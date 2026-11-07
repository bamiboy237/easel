// The local render service: runs Manim jobs for the board, each in its own
// process and folder, and serves their videos and frames. The Worker cannot
// start processes, so this runs beside it, like the ChatGPT plan helper; in the
// Mac app the shell runs it.
//
//   node render/server.ts            (EASEL_RENDER_PORT, default 8790)
//
// Each job: a static check refuses source that reaches for the system or the
// network, then Manim runs in a new process group with a stripped environment,
// no network (a network namespace where the system allows one, and an audit
// hook that blocks sockets everywhere), a wall-clock limit, and size caps.
// Finished renders are cached by a hash of their source, scene, and quality.
import { spawn, spawnSync, ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.EASEL_RENDER_PORT || 8790)
const RENDER_DIR = process.env.EASEL_RENDER_DIR || join(homedir(), '.cache', 'easel', 'renders')
const TEX_DIR = join(RENDER_DIR, '..', 'render-tex')
const FONTS_DIR = join(RENDER_DIR, '..', 'render-fonts')
const JOBS_DIR = join(tmpdir(), 'easel-render-jobs')
const FONT_ROOT = resolve(HERE, '..', 'node_modules', '@fontsource-variable', 'source-serif-4', 'files')
const RUNNER = join(HERE, 'py', 'easel_run.py')

/** The helpers a scene imports are part of every render's cache key. */
const HELPERS_HASH = createHash('sha256')
	.update(readFileSync(join(HERE, 'py', 'easel.py')))
	.update(readFileSync(RUNNER))
	.digest('hex')
	.slice(0, 12)

const MAX_SOURCE_CHARS = 40_000
const MAX_BODY_BYTES = 64_000
const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const MAX_RUNNING = 3
/** At most this many processes render one final video, in parallel parts. */
const MAX_PARTS = 3
/** How long a finished job's record is kept, for status reads. */
const JOB_RECORD_MS = 30 * 60 * 1000

// A sketch skips the animations: a frame at the end of each step, and no video.
// It shows a scene while its code is still being written, and gives the frames
// the writer checks. A preview is a low-resolution video.
export type Quality = 'sketch' | 'preview' | 'final'
const QUALITIES: Record<Quality, { width: number; height: number; fps: number; timeoutSeconds: number }> = {
	sketch: { width: 854, height: 480, fps: 5, timeoutSeconds: 30 },
	preview: { width: 854, height: 480, fps: 10, timeoutSeconds: 60 },
	final: { width: 1920, height: 1080, fps: 30, timeoutSeconds: 150 },
}

type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

interface Job {
	id: string
	key: string
	quality: Quality
	source: string
	scene: string | null
	timeoutSeconds: number
	status: JobStatus
	cached: boolean
	startedAt: number
	finishedAt: number | null
	/** Animations played so far, and the guess of how many there are. */
	steps: number
	estimate: number
	/** The newest frame of the scene as it is drawn, in the job's folder. */
	liveFrame: string | null
	error: string | null
	/** The source was refused before it ran. */
	refused: boolean
	line: number | null
	layout: string[]
	/** The runner processes: one, or one per part of a final render. */
	children: ChildProcess[]
	/** How many steps the scene has, if a sketch of it said so; it splits a final render into parts. */
	hint: number | null
	/** 1 to render in one piece. */
	parts: number | null
	dir: string
	stderr: string
	meta: RenderMeta | null
}

interface RenderMeta {
	key: string
	quality: Quality
	scene: string
	duration: number
	width: number
	height: number
	frames: { name: string; time: number }[]
	layout: string[]
	createdAt: string
	renderSeconds: number
}

const python = findPython()
const networkNamespace = process.platform === 'linux' && spawnSync('unshare', ['-n', 'true']).status === 0
const jobs = new Map<string, Job>()
const queue: Job[] = []

function findPython(): string {
	if (process.env.EASEL_MANIM_PYTHON) return process.env.EASEL_MANIM_PYTHON
	for (const candidate of [join(homedir(), 'manim-venv', 'bin', 'python'), join(homedir(), '.venvs', 'manim', 'bin', 'python')]) {
		if (existsSync(candidate)) return candidate
	}
	return 'python3'
}

function renderKey(source: string, scene: string | null, quality: Quality): string {
	return createHash('sha256').update(JSON.stringify([source, scene ?? '', quality, HELPERS_HASH])).digest('hex').slice(0, 32)
}

function cacheDir(key: string) {
	return join(RENDER_DIR, key)
}

async function readMeta(key: string): Promise<RenderMeta | null> {
	try {
		return JSON.parse(await readFile(join(cacheDir(key), 'meta.json'), 'utf8')) as RenderMeta
	} catch {
		return null
	}
}

function view(job: Job) {
	const files = `/render/files/${job.key}`
	const done = job.status === 'done' && job.meta
	const elapsed = ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000
	return {
		id: job.id,
		key: job.key,
		quality: job.quality,
		status: job.status,
		cached: job.cached,
		progress: done ? 1 : job.estimate ? Math.min(0.97, job.steps / Math.max(job.estimate, job.steps + 1)) : 0,
		steps: job.steps,
		seconds: Math.round(elapsed * 10) / 10,
		liveFrame: job.status === 'running' && job.liveFrame ? `/render/jobs/${job.id}/live?n=${job.steps}` : null,
		frames: done ? job.meta!.frames.map((f) => ({ url: `${files}/frames/${f.name}`, time: f.time })) : [],
		video: done && job.quality !== 'sketch' ? `${files}/video.mp4` : null,
		poster: done ? `${files}/poster.png` : null,
		duration: done ? job.meta!.duration : null,
		layout: job.layout,
		error: job.error,
		refused: job.refused,
		line: job.line,
	}
}

async function createJob(body: { source?: unknown; scene?: unknown; quality?: unknown; timeoutSeconds?: unknown; steps?: unknown; parts?: unknown }) {
	const source = typeof body.source === 'string' ? body.source : ''
	if (!source.trim()) throw new HttpError(400, 'No source.')
	if (source.length > MAX_SOURCE_CHARS) throw new HttpError(413, `The source is over ${MAX_SOURCE_CHARS} characters.`)
	const quality: Quality = body.quality === 'final' || body.quality === 'sketch' ? body.quality : 'preview'
	const scene = typeof body.scene === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(body.scene) ? body.scene : null
	const limit = QUALITIES[quality].timeoutSeconds
	const timeoutSeconds =
		typeof body.timeoutSeconds === 'number' && body.timeoutSeconds > 0 ? Math.min(limit, Math.max(2, body.timeoutSeconds)) : limit
	const key = renderKey(source, scene, quality)

	// The same render already running: share it.
	for (const job of jobs.values()) {
		if (job.key === key && (job.status === 'queued' || job.status === 'running')) return job
	}
	const job: Job = {
		id: randomBytes(8).toString('hex'),
		key,
		quality,
		source,
		scene,
		timeoutSeconds,
		status: 'queued',
		cached: false,
		startedAt: Date.now(),
		finishedAt: null,
		steps: 0,
		estimate: 0,
		liveFrame: null,
		error: null,
		refused: false,
		line: null,
		layout: [],
		children: [],
		hint: typeof body.steps === 'number' && body.steps > 0 ? Math.min(500, Math.floor(body.steps)) : null,
		parts: body.parts === 1 ? 1 : null,
		dir: join(JOBS_DIR, ''),
		stderr: '',
		meta: null,
	}
	jobs.set(job.id, job)
	const meta = await readMeta(key)
	if (meta) {
		job.status = 'done'
		job.cached = true
		job.meta = meta
		job.layout = meta.layout
		job.finishedAt = Date.now()
		return job
	}
	queue.push(job)
	pump()
	return job
}

function runningCount() {
	let n = 0
	for (const job of jobs.values()) if (job.status === 'running') n++
	return n
}

function pump() {
	while (queue.length && runningCount() < MAX_RUNNING) {
		const job = queue.shift()!
		if (job.status !== 'queued') continue
		void run(job)
	}
}

type DoneEvent = {
	video: string | null
	empty?: boolean
	duration: number
	steps: { index: number; time: number; frame: string | null; beat?: number }[]
	layout: string[]
	seconds: number
}

/**
 * How a final render splits into parts that render in parallel and are joined:
 * ranges of animation numbers, the last open-ended. A part renders its range and
 * runs the animations before it without drawing. Scenes whose state builds up
 * frame by frame (updaters that use the time step, traced paths) or that use
 * randomness render in one piece, since a part that skips ahead would differ.
 */
function partsFor(job: Job): { from: number; upto: number }[] {
	const whole = [{ from: 0, upto: -1 }]
	if (job.quality !== 'final' || job.parts === 1) return whole
	if (/TracedPath|add_updater|\bdt\b|random/.test(job.source)) return whole
	const count = job.hint ?? estimateSteps(job.source)
	const parts = Math.min(MAX_PARTS, Math.floor(count / 4))
	if (parts < 2) return whole
	const bounds = Array.from({ length: parts + 1 }, (_, k) => Math.round((count * k) / parts))
	return bounds.slice(0, -1).map((from, k) => ({ from, upto: k === parts - 1 ? -1 : bounds[k + 1] - 1 }))
}

/** Like the runner's own guess: the steps a scene plays, counted in its source. */
function estimateSteps(source: string) {
	const count = (re: RegExp) => (source.match(re) ?? []).length
	return Math.max(1, count(/\.play\(/g) + count(/\.caption\(/g) + count(/\.title\(/g) * 2 + count(/\.wait\(/g) + count(/\.end\(/g))
}

async function run(job: Job) {
	const preset = QUALITIES[job.quality]
	job.status = 'running'
	job.startedAt = Date.now()
	job.dir = join(JOBS_DIR, job.id)
	await mkdir(TEX_DIR, { recursive: true })
	const parts = partsFor(job)
	const dirs = parts.map((_, i) => (parts.length === 1 ? job.dir : join(job.dir, `part${i}`)))
	for (const [i, dir] of dirs.entries()) {
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, 'scene.py'), job.source)
		await writeFile(
			join(dir, 'job.json'),
			JSON.stringify({
				scene: job.scene,
				width: preset.width,
				height: preset.height,
				fps: preset.fps,
				sketch: job.quality === 'sketch',
				fromAnimation: parts[i].from,
				uptoAnimation: parts[i].upto,
				timeoutSeconds: job.timeoutSeconds,
				texDir: TEX_DIR,
				fontsDir: FONTS_DIR,
				fontRoot: existsSync(FONT_ROOT) ? FONT_ROOT : null,
			})
		)
	}
	if (job.status !== 'running') return finish(job)

	const timer = setTimeout(() => {
		if (job.status !== 'running') return
		job.status = 'failed'
		job.error = `The render ran longer than ${job.timeoutSeconds} seconds and was stopped. Keep the animation simpler, or look for a loop that never ends.`
		kill(job)
	}, job.timeoutSeconds * 1000)
	const drawn = parts.map(() => 0)
	const results = await Promise.all(
		dirs.map((dir, i) =>
			runPart(job, dir, (event) => {
				drawn[i]++
				job.steps = drawn.reduce((a, b) => a + b, 0)
				if (event.frame) job.liveFrame = relative(job.dir, join(dir, event.frame))
			})
		)
	)
	clearTimeout(timer)
	if (job.status === 'running') {
		if (results.some((r) => !r)) {
			job.status = 'failed'
			job.error ??= `The render stopped without a video. ${lastLines(job.stderr)}`.trim()
		} else {
			try {
				job.meta = await store(job, await joinParts(job, dirs, results as DoneEvent[]))
				job.status = 'done'
			} catch (error) {
				job.status = 'failed'
				job.error = (error as Error).message
			}
		}
	}
	finish(job)
}

function relative(root: string, path: string) {
	return path.slice(root.length + 1)
}

/** One runner process, in its own process group, reporting into the job. Resolves with its done event, or null. */
async function runPart(job: Job, dir: string, onDrawn: (event: { frame: string | null }) => void): Promise<DoneEvent | null> {
	// Only what Manim needs: no proxies, no keys, nothing from this process.
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '/usr/bin:/bin',
		HOME: dir,
		LANG: 'C.UTF-8',
		OPENBLAS_NUM_THREADS: '1',
		OMP_NUM_THREADS: '1',
		PYTHONDONTWRITEBYTECODE: '1',
	}
	const args = ['-I', RUNNER, dir]
	const child = networkNamespace
		? spawn('unshare', ['-n', python, ...args], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
		: spawn(python, args, { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
	job.children.push(child)
	// A job cancelled while its parts start: stop this one too.
	if (job.status !== 'running') kill(job)

	let pending = ''
	let done: DoneEvent | null = null
	child.stdout!.setEncoding('utf8')
	child.stdout!.on('data', (chunk: string) => {
		pending += chunk
		const lines = pending.split('\n')
		pending = lines.pop() ?? ''
		for (const line of lines) {
			if (!line.startsWith('EASEL ')) continue
			let event: any
			try {
				event = JSON.parse(line.slice(6))
			} catch {
				continue
			}
			if (event.type === 'check') {
				job.estimate = Math.max(job.estimate, event.estimate)
				job.scene = event.scene
			} else if (event.type === 'step') {
				onDrawn(event)
				for (const p of event.layout ?? []) if (!job.layout.includes(p)) job.layout.push(p)
			} else if (event.type === 'done') {
				done = event
			} else if (event.type === 'refused' || event.type === 'error') {
				if (!job.error) {
					job.error = event.type === 'refused' ? `Refused: ${event.message}` : event.message
					if (event.where?.length) job.error += ` (at ${event.where.join('; ')})`
					job.refused = event.type === 'refused'
					job.line = event.line ?? null
				}
				// One part failing fails the whole render.
				if (job.status === 'running') {
					job.status = 'failed'
					kill(job)
				}
			}
		}
	})
	child.stderr!.setEncoding('utf8')
	child.stderr!.on('data', (chunk: string) => {
		job.stderr = (job.stderr + chunk).slice(-4000)
	})
	await new Promise<void>((resolveExit) => child.on('close', () => resolveExit()))
	job.children = job.children.filter((c) => c !== child)
	return done
}

/** The parts of a render as one: their videos joined in order, their steps merged. */
async function joinParts(job: Job, dirs: string[], parts: DoneEvent[]): Promise<DoneEvent> {
	if (parts.length === 1) return parts[0]
	const videos = parts.map((p, i) => (p.video ? join(dirs[i], p.video) : null)).filter((v): v is string => !!v)
	if (!videos.length) throw new Error('The render made no video.')
	const joined = join(job.dir, 'joined.mp4')
	if (videos.length === 1) await copyFile(videos[0], joined)
	else {
		const list = join(job.dir, 'parts.txt')
		await writeFile(list, videos.map((v) => `file '${v.replace(/'/g, "'\\''")}'`).join('\n'))
		await ffmpeg(['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', joined])
	}
	const steps = new Map<number, DoneEvent['steps'][number]>()
	for (const [i, part] of parts.entries()) {
		for (const step of part.steps) {
			if (step.frame) steps.set(step.index, { ...step, frame: relative(job.dir, join(dirs[i], step.frame)) })
		}
	}
	return {
		video: 'joined.mp4',
		duration: Math.max(...parts.map((p) => p.duration)),
		steps: [...steps.values()].sort((a, b) => a.index - b.index),
		layout: [...new Set(parts.flatMap((p) => p.layout))],
		seconds: Math.max(...parts.map((p) => p.seconds)),
	}
}

function ffmpeg(args: string[]) {
	return new Promise<void>((resolveRun, reject) => {
		const child = spawn('ffmpeg', args, { stdio: 'ignore' })
		const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
		child.on('close', (code) => {
			clearTimeout(timer)
			if (code === 0) resolveRun()
			else reject(new Error('ffmpeg could not join the video.'))
		})
		child.on('error', reject)
	})
}

function lastLines(text: string) {
	return text
		.replace(/\u001b\[[0-9;]*m/g, '')
		.split('\n')
		.filter((l) => l.trim())
		.slice(-6)
		.join('\n')
}

/** Move a finished render into the cache: the video, a poster, and a few representative frames. */
async function store(job: Job, done: DoneEvent) {
	const video = done.video ? join(job.dir, done.video) : null
	if (video && statSync(video).size > MAX_VIDEO_BYTES) throw new Error('The video is too large.')
	if (!video && job.quality !== 'sketch') throw new Error('The render made no video.')
	const target = cacheDir(job.key)
	const staging = `${target}.tmp-${job.id}`
	await mkdir(join(staging, 'frames'), { recursive: true })
	if (video) await copyFile(video, join(staging, 'video.mp4'))
	const withFrames = done.steps.filter((s) => s.frame)
	const picks = pickFrames(withFrames)
	const frames: { name: string; time: number }[] = []
	for (const [i, index] of picks.entries()) {
		const step = withFrames[index]
		const name = `${i}.png`
		await copyFile(join(job.dir, step.frame!), join(staging, 'frames', name))
		frames.push({ name, time: step.time })
	}
	// The poster is the video's own last frame, or a sketch's last step.
	if (video) await ffmpegFrame(join(staging, 'video.mp4'), -1, join(staging, 'poster.png'))
	else if (withFrames.length) await copyFile(join(job.dir, withFrames.at(-1)!.frame!), join(staging, 'poster.png'))
	const preset = QUALITIES[job.quality]
	const meta: RenderMeta = {
		key: job.key,
		quality: job.quality,
		scene: job.scene ?? '',
		duration: done.duration,
		width: preset.width,
		height: preset.height,
		frames,
		layout: done.layout,
		createdAt: new Date().toISOString(),
		renderSeconds: done.seconds,
	}
	await writeFile(join(staging, 'meta.json'), JSON.stringify(meta, null, 1))
	await writeFile(join(staging, 'scene.py'), job.source)
	await rm(target, { recursive: true, force: true })
	await rename(staging, target)
	return meta
}

/** Up to four steps, spread through the animation, always ending on the last. */
/**
 * Six steps that tell the story, ending on the last: near 22, 40, 56, 72, and
 * 86 percent of the way through, by time. A scene with captions is told in
 * beats, one per caption. The last step of a beat shows what its caption says,
 * so it is preferred; the step that brings in a new caption is never picked,
 * since its caption is ahead of the picture.
 */
function pickFrames(steps: { beat?: number; time: number }[]): number[] {
	const count = steps.length
	if (count <= 6) return Array.from({ length: count }, (_, i) => i)
	const all = Array.from({ length: count - 1 }, (_, i) => i)
	const beats = steps[0].beat !== undefined
	const ends = beats ? all.filter((i) => steps[i + 1].beat !== steps[i].beat) : []
	const settled = beats ? all.filter((i) => i === 0 || steps[i].beat === steps[i - 1].beat) : all
	const total = steps[count - 1].time || 1
	const picks: number[] = []
	const nearest = (list: number[], t: number) => list.reduce((best, i) => (Math.abs(steps[i].time - t) < Math.abs(steps[best].time - t) ? i : best))
	for (const f of [0.22, 0.4, 0.56, 0.72, 0.86]) {
		const t = f * total
		const free = (list: number[]) => list.filter((i) => !picks.includes(i))
		const end = free(ends).length ? nearest(free(ends), t) : null
		if (end !== null && Math.abs(steps[end].time - t) <= 0.1 * total) picks.push(end)
		else if (free(settled).length) picks.push(nearest(free(settled), t))
		else if (free(all).length) picks.push(nearest(free(all), t))
	}
	return [...picks.sort((x, y) => x - y), count - 1]
}

/** One frame of a video as a PNG: the frame at time, or the last frame when time is negative. */
function ffmpegFrame(video: string, time: number, out: string) {
	const args =
		time < 0
			? ['-v', 'error', '-y', '-sseof', '-0.5', '-i', video, '-update', '1', out]
			: ['-v', 'error', '-y', '-ss', time.toFixed(3), '-i', video, '-frames:v', '1', out]
	return new Promise<void>((resolveFrame, reject) => {
		const child = spawn('ffmpeg', args, { stdio: 'ignore' })
		const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
		child.on('close', (code) => {
			clearTimeout(timer)
			if (code === 0 && existsSync(out)) resolveFrame()
			else reject(new Error('ffmpeg could not take a frame.'))
		})
		child.on('error', reject)
	})
}

function kill(job: Job) {
	for (const child of job.children) {
		if (!child.pid) continue
		try {
			// The whole process group: Manim and any LaTeX it started.
			process.kill(-child.pid, 'SIGKILL')
		} catch {
			try {
				child.kill('SIGKILL')
			} catch {}
		}
	}
}

function finish(job: Job) {
	job.finishedAt = Date.now()
	if (job.dir.endsWith(job.id)) void rm(job.dir, { recursive: true, force: true }).catch(() => {})
	const id = job.id
	setTimeout(() => jobs.delete(id), JOB_RECORD_MS).unref()
	pump()
}

function cancel(job: Job) {
	if (job.status === 'queued') {
		job.status = 'cancelled'
		job.finishedAt = Date.now()
	} else if (job.status === 'running') {
		job.status = 'cancelled'
		kill(job)
	}
}

/**
 * Animations by what was asked for: the same title and brief again gets the
 * source written the first time, so its render comes from the cache instead
 * of a new model call. A brief is matched after case and spacing are evened out.
 */
async function briefs(save: boolean, body: { title?: unknown; brief?: unknown; source?: unknown; key?: unknown }) {
	const normal = (v: unknown) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
	const id = createHash('sha256').update(JSON.stringify([normal(body.title), normal(body.brief)])).digest('hex').slice(0, 32)
	const file = join(RENDER_DIR, 'briefs', `${id}.json`)
	if (save) {
		if (typeof body.source !== 'string' || body.source.length > MAX_SOURCE_CHARS || typeof body.key !== 'string' || !/^[0-9a-f]{32}$/.test(body.key)) {
			throw new HttpError(400, 'A brief needs its source and render key.')
		}
		if (!(await readMeta(body.key))) throw new HttpError(400, 'That render is not finished.')
		await mkdir(join(RENDER_DIR, 'briefs'), { recursive: true })
		await writeFile(file, JSON.stringify({ title: body.title, brief: body.brief, source: body.source, key: body.key }))
		return { saved: true }
	}
	try {
		const entry = JSON.parse(await readFile(file, 'utf8')) as { source: string; key: string }
		if (!(await readMeta(entry.key))) return { found: false }
		return { found: true, source: entry.source, key: entry.key }
	} catch {
		return { found: false }
	}
}

class HttpError extends Error {
	status: number
	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

function isLocalOrigin(origin: string | undefined) {
	if (!origin) return true
	try {
		return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)
	} catch {
		return false
	}
}

function send(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
	res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage) {
	let size = 0
	const chunks: Buffer[] = []
	for await (const chunk of req) {
		size += chunk.length
		if (size > MAX_BODY_BYTES) throw new HttpError(413, 'The request is too large.')
		chunks.push(chunk as Buffer)
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} catch {
		throw new HttpError(400, 'The request was not JSON.')
	}
}

const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.png': 'image/png', '.json': 'application/json' }

function serveFile(req: IncomingMessage, res: ServerResponse, path: string) {
	if (!existsSync(path)) throw new HttpError(404, 'Not found.')
	const size = statSync(path).size
	const type = TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream'
	const headers: Record<string, string | number> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' }
	// Videos are read in ranges, so the board can seek.
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
	if (range) {
		const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
		const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1
		if (start >= size || start > end) {
			res.writeHead(416, { 'Content-Range': `bytes */${size}` })
			res.end()
			return
		}
		res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
		createReadStream(path, { start, end }).pipe(res)
		return
	}
	res.writeHead(200, { ...headers, 'Content-Length': size })
	createReadStream(path).pipe(res)
}

async function handle(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? '/', 'http://127.0.0.1')
	const origin = req.headers.origin
	if (!isLocalOrigin(origin)) throw new HttpError(403, 'Requests must come from the local Easel page.')
	if (origin) {
		res.setHeader('Access-Control-Allow-Origin', origin)
		res.setHeader('Vary', 'Origin')
	}
	if (req.method === 'OPTIONS') {
		res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' })
		return res.end()
	}
	const path = url.pathname.replace(/^\/render/, '') || '/'
	if (req.method === 'POST' && req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
		throw new HttpError(415, 'Expected application/json.')
	}

	if (req.method === 'GET' && path === '/health') {
		return send(res, 200, { ok: true, python, network: networkNamespace ? 'namespace and audit hook' : 'audit hook', running: runningCount(), queued: queue.length })
	}
	if (req.method === 'POST' && path === '/jobs') {
		const job = await createJob(await readBody(req))
		return send(res, 200, view(job))
	}
	if (req.method === 'POST' && (path === '/briefs/lookup' || path === '/briefs')) {
		return send(res, 200, await briefs(path === '/briefs', await readBody(req)))
	}
	let match = /^\/jobs\/([0-9a-f]{16})(\/cancel|\/live)?$/.exec(path)
	if (match) {
		const job = jobs.get(match[1])
		if (!job) throw new HttpError(404, 'No such job.')
		if (req.method === 'POST' && match[2] === '/cancel') {
			cancel(job)
			return send(res, 200, view(job))
		}
		if (req.method === 'GET' && match[2] === '/live') {
			if (!job.liveFrame || job.status !== 'running') throw new HttpError(404, 'No frame yet.')
			const file = join(job.dir, job.liveFrame)
			res.setHeader('Cache-Control', 'no-store')
			return serveFile(req, res, file)
		}
		if (req.method === 'GET' && !match[2]) return send(res, 200, view(job))
	}
	match = /^\/files\/([0-9a-f]{32})\/(video\.mp4|poster\.png|meta\.json|frames\/[0-5]\.png)$/.exec(path)
	if (match && req.method === 'GET') return serveFile(req, res, join(cacheDir(match[1]), match[2]))
	match = /^\/files\/([0-9a-f]{32})\/frame$/.exec(path)
	if (match && req.method === 'GET') {
		// Any moment of a finished video, as a PNG.
		const t = Math.max(0, Number(url.searchParams.get('t')) || 0)
		const dir = cacheDir(match[1])
		const out = join(dir, 'frames', `t${Math.round(t * 1000)}.png`)
		if (!existsSync(out)) {
			if (!existsSync(join(dir, 'video.mp4'))) throw new HttpError(404, 'Not found.')
			await ffmpegFrame(join(dir, 'video.mp4'), t, out)
		}
		return serveFile(req, res, out)
	}
	throw new HttpError(404, 'Not found.')
}

async function cleanStaleJobFolders() {
	await mkdir(JOBS_DIR, { recursive: true })
	for (const name of await readdir(JOBS_DIR)) await rm(join(JOBS_DIR, name), { recursive: true, force: true })
}

await mkdir(RENDER_DIR, { recursive: true })
await cleanStaleJobFolders()
createServer((req, res) => {
	handle(req, res).catch((error) => {
		const status = error instanceof HttpError ? error.status : 500
		if (!res.headersSent) send(res, status, { error: (error as Error).message })
		else res.end()
	})
}).listen(PORT, '127.0.0.1', () => {
	console.log(`Render service on http://127.0.0.1:${PORT} (python ${python}, network: ${networkNamespace ? 'namespace' : 'audit hook only'})`)
})

// Stop every render with the service.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		for (const job of jobs.values()) if (job.status === 'running') kill(job)
		process.exit(0)
	})
}
