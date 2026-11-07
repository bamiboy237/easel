import {
	ANIMATION_STREAM_ERROR,
	applyAnimationEdits,
	AnimationReview,
	parseAnimationChoice,
	parseAnimationReview,
	parseAnimationSource,
	partialAnimationSource,
} from '../../../shared/animationCode'

/**
 * How an animation is made, in the background:
 *
 * 1. The writer model writes a Manim scene. While it writes, the part written
 *    so far renders as a sketch (each step's end state, no video), so the board
 *    shows the scene taking shape within seconds.
 * 2. The whole scene renders as a low-resolution sketch. If Manim fails, its
 *    error goes back to the writer once.
 * 3. The final video starts rendering. Meanwhile the writer checks the sketch's
 *    frames for layout and its own source for content, and fixes it once if
 *    needed; a fix renders beside the first version, and the fixed one is kept.
 *
 * This file knows only the writer route and the render service, not the board,
 * so a script can run it too.
 */

/** A render job as the render service reports it (render/server.ts). */
export interface RenderJobView {
	id: string
	key: string
	quality: 'sketch' | 'preview' | 'final'
	status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
	cached: boolean
	progress: number
	steps: number
	seconds: number
	liveFrame: string | null
	frames: { url: string; time: number }[]
	video: string | null
	poster: string | null
	duration: number | null
	layout: string[]
	error: string | null
	refused: boolean
	line: number | null
}

export type AnimationPhase = 'writing' | 'checking' | 'fixing' | 'rendering'

export interface AnimationProgress {
	phase: AnimationPhase
	/** From 0 to 1, for the final render. */
	progress: number
	/** The newest picture of the scene: a sketch of the code so far, then the checked sketch. */
	frame: string | null
	/** The checked sketch's representative frames, once they exist. */
	frames: string[]
}

export interface AnimationPipelineOptions {
	title: string
	brief: string
	modelName: string
	signal: AbortSignal
	/** Where the writer route and the render service are: the page's own origin by default. */
	base?: string
	/** Check the sketch's frames with the writer, and fix once. On by default. */
	review?: boolean
	/** How many versions the writer writes at once; with two, the review picks the better one. 1 by default: in tests a second version did not raise the scores. */
	candidates?: number
	/** Look up the same title and brief asked for before. On by default. */
	reuse?: boolean
	/** Use this source instead of asking the writer, as a test does. */
	source?: string
	/** A shorter wall-clock limit for each render, in seconds. */
	renderTimeoutSeconds?: number
	onProgress?: (progress: AnimationProgress) => void
	/** Each step, for logs and evals. */
	onLog?: (event: string, detail?: unknown) => void
}

export interface AnimationResult {
	source: string
	/** The final render's cache key; its video and poster are served under /render/files/<key>/. */
	key: string
	duration: number
	/** The final render's representative frames. */
	frames: { url: string; time: number }[]
	/** The checked sketch's frames, which the writer saw. */
	sketchFrames: { url: string; time: number }[]
	layout: string[]
	review: 'ok' | 'fixed' | 'skipped' | 'kept'
	/** Which of two versions was kept, when two were written. */
	chose: 'A' | 'B' | null
	problems: string[]
	cached: boolean
	seconds: { firstFrame: number | null; written: number | null; checked: number | null; total: number }
}

export class AnimationError extends Error {}

const POLL_MS = 350
/** How long the review waits for the second version once the first is sketched, in milliseconds. */
const SECOND_VERSION_WAIT_MS = 12000
/** How often a growing scene is sketched while it is written, at most. */
const SKETCH_EVERY_MS = 3000

export async function runAnimationPipeline(options: AnimationPipelineOptions): Promise<AnimationResult> {
	const base = options.base ?? ''
	const { signal } = options
	const started = Date.now()
	const elapsed = () => Math.round((Date.now() - started) / 100) / 10
	const log = options.onLog ?? (() => {})
	/** Render jobs this pipeline started that may still run. */
	const jobs = new Set<string>()
	let firstFrame: number | null = null
	let written: number | null = null
	let checked: number | null = null
	let frame: string | null = null
	let frames: string[] = []
	let phase: AnimationPhase = 'writing'
	let progress = 0
	const report = (next: Partial<{ phase: AnimationPhase; progress: number; frame: string | null; frames: string[] }>) => {
		phase = next.phase ?? phase
		progress = next.progress ?? progress
		frames = next.frames ?? frames
		if (next.frame !== undefined) {
			frame = next.frame
			if (frame && firstFrame === null) {
				firstFrame = elapsed()
				log('first frame', { seconds: firstFrame })
			}
		}
		options.onProgress?.({ phase, progress, frame, frames })
	}

	const post = async (path: string, body: unknown) => {
		const response = await fetch(base + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		})
		if (!response.headers.get('Content-Type')?.includes('json')) {
			throw new AnimationError(`The render service answered ${response.status}. Is it running (node render/server.ts)?`)
		}
		return response.json()
	}
	const cancelJob = (id: string) => {
		jobs.delete(id)
		void fetch(`${base}/render/jobs/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {})
	}
	// Cancelling stops every render this pipeline started, on the service too.
	const cancelAll = () => {
		for (const id of [...jobs]) cancelJob(id)
	}
	signal.addEventListener('abort', cancelAll, { once: true })

	/** Start a render and wait for it, calling onPoll as it runs. */
	const render = async (source: string, quality: RenderJobView['quality'], onPoll?: (job: RenderJobView) => void, steps?: number): Promise<RenderJobView> => {
		let job = (await post('/render/jobs', { source, quality, steps, timeoutSeconds: options.renderTimeoutSeconds })) as RenderJobView & { error?: string }
		if (!job.id) throw new AnimationError(job.error ?? 'The render service refused the job.')
		jobs.add(job.id)
		while (job.status === 'queued' || job.status === 'running') {
			onPoll?.(job)
			await sleep(POLL_MS, signal)
			if (!jobs.has(job.id)) break
			const response = await fetch(`${base}/render/jobs/${job.id}`, { signal })
			if (!response.ok) throw new AnimationError('The render service lost the job.')
			job = await response.json()
		}
		jobs.delete(job.id)
		if (quality !== 'sketch' || job.status !== 'done') {
			log(`render ${quality}`, { status: job.status, seconds: job.seconds, cached: job.cached, layout: job.layout, error: job.error })
		}
		return job
	}

	/** Ask the writer, reading its reply as it streams. */
	const write = async (request: Record<string, unknown>, onText?: (text: string) => void): Promise<string> => {
		const response = await fetch(`${base}/animation`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ modelName: options.modelName, title: options.title, brief: options.brief, ...request }),
			signal,
		})
		if (!response.ok || !response.body) throw new AnimationError((await response.text()) || `The writer answered ${response.status}.`)
		const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
		let text = ''
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			text += value
			onText?.(text)
		}
		const failed = text.indexOf(ANIMATION_STREAM_ERROR)
		if (failed >= 0) throw new AnimationError(text.slice(failed + ANIMATION_STREAM_ERROR.length) || 'The writer failed.')
		return text
	}

	/** Sketch the code written so far, one sketch at a time, and show its last frame. */
	let sketching = false
	let sketchedAt = 0
	let lastPartial = ''
	const sketchPartial = (text: string) => {
		if (sketching || Date.now() - sketchedAt < SKETCH_EVERY_MS || signal.aborted) return
		const partial = partialAnimationSource(text)
		if (!partial || partial === lastPartial) return
		sketching = true
		sketchedAt = Date.now()
		lastPartial = partial
		render(partial, 'sketch')
			.then((job) => {
				if (job.status === 'done' && job.poster && phase === 'writing') report({ frame: base + job.poster })
			})
			.catch(() => {})
			.finally(() => (sketching = false))
	}

	try {
		// The same animation asked for again comes from the cache.
		if (!options.source && options.reuse !== false) {
			const known = (await post('/render/briefs/lookup', { title: options.title, brief: options.brief })) as { found: boolean; source?: string }
			if (known.found && known.source) {
				report({ phase: 'rendering' })
				const final = await render(known.source, 'final', (job) => report({ progress: job.progress }))
				if (final.status === 'done') {
					log('reused', { key: final.key, cached: final.cached })
					return await finish(known.source, final, [], 'kept', [], true)
				}
			}
		}

		// 1. Write, sketching the scene as it grows. A second version is written
		// beside it, so the review can keep the better one: the writer's scenes
		// vary a lot from one try to the next.
		report({ phase: 'writing' })
		const second =
			!options.source && options.review !== false && (options.candidates ?? 1) > 1
				? (async () => {
						const code = parseAnimationSource(await write({ mode: 'write' }))
						const job = await render(code, 'sketch')
						return job.status === 'done' ? { source: code, sketch: job } : null
					})().catch(() => null)
				: null
		let source = options.source ?? null
		let problem: string | null = null
		for (let attempt = 0; !source && attempt < 2; attempt++) {
			const text = await write({ mode: 'write', problem: problem ?? undefined }, sketchPartial)
			try {
				source = parseAnimationSource(text)
			} catch (error) {
				problem = (error as Error).message
			}
		}
		if (!source) throw new AnimationError(`The writer did not send a scene: ${problem}`)
		written = elapsed()
		log('written', { seconds: written })

		// 2. Sketch the whole scene, and start the final video beside it. A scene
		// that fails goes back to the writer once.
		let finalJobId: string | null = null
		const startFinal = (code: string) => {
			const pending = render(code, 'final', (job) => {
				finalJobId = job.id
				if (phase === 'rendering') report({ progress: job.progress })
			})
			pending.catch(() => {})
			return pending
		}
		let firstFinal = startFinal(source)
		let sketch = await render(source, 'sketch')
		if (sketch.status === 'cancelled') throw abortError()
		if (sketch.status !== 'done' && !options.source) {
			log('sketch failed, rewriting', sketch.error)
			if (finalJobId) cancelJob(finalJobId)
			report({ phase: 'fixing' })
			source = parseAnimationSource(await write({ mode: 'write', source, problem: sketch.error }, sketchPartial))
			firstFinal = startFinal(source)
			sketch = await render(source, 'sketch')
		}
		if (sketch.status !== 'done') throw new AnimationError(sketch.error ?? 'The animation did not render.')
		const sketchFrames = sketch.frames
		report({ phase: 'checking', frame: sketch.poster ? base + sketch.poster : frame, frames: sketchFrames.map((f) => base + f.url) })

		// 3. The writer checks the sketch while the final video renders.
		let review: AnimationResult['review'] = 'skipped'
		let problems: string[] = []
		let chose: 'A' | 'B' | null = null
		if (options.review !== false) {
			const images = await Promise.all(sketchFrames.map(async (f) => ({ image: await toDataUrl(base + f.url, signal), time: f.time })))
			const other = second ? await Promise.race([second, sleep(SECOND_VERSION_WAIT_MS, signal).then(() => null)]) : null
			let verdict: AnimationReview
			if (other) {
				const otherImages = await Promise.all(other.sketch.frames.map(async (f) => ({ image: await toDataUrl(base + f.url, signal), time: f.time })))
				const reply = parseAnimationChoice(
					await write({
						mode: 'review',
						source,
						frames: images,
						layout: sketch.layout,
						duration: sketch.duration,
						alternative: { source: other.source, frames: otherImages, layout: other.sketch.layout, duration: other.sketch.duration },
					})
				)
				chose = reply.choice
				verdict = reply.review
				log('chose', { choice: chose, layout: { A: sketch.layout.length, B: other.sketch.layout.length } })
				if (chose === 'B') {
					if (finalJobId) cancelJob(finalJobId)
					source = other.source
					sketch = other.sketch
					firstFinal = startFinal(source)
				}
			} else {
				if (second) log('second version not ready')
				verdict = parseAnimationReview(await write({ mode: 'review', source, frames: images, layout: sketch.layout, duration: sketch.duration }))
			}
			checked = elapsed()
			if (verdict.ok) {
				review = 'ok'
				log('review', { ok: true, seconds: checked })
			} else {
				problems = verdict.problems
				const fixedSource = verdict.edits.length ? applyAnimationEdits(source, verdict.edits) : verdict.source
				log('review', { ok: false, problems, edits: verdict.edits.length, applied: !!fixedSource, seconds: checked })
				review = 'kept'
				if (fixedSource && fixedSource !== source) {
					report({ phase: 'fixing' })
					// A fix is kept only if it renders and the layout check finds no more
					// problems in it than in the first version: a fix can break what worked.
					// Its final video renders beside that check, and is dropped if the fix is;
					// the first version's render goes on meanwhile, in case it is needed.
					let fixJobId: string | null = null
					const fixFinal = render(fixedSource, 'final', (job) => {
						fixJobId = job.id
						report({ progress: job.progress })
					}, sketch.steps)
					fixFinal.catch(() => {})
					const fixSketch = await render(fixedSource, 'sketch')
					const better = fixSketch.status === 'done' && fixSketch.layout.length <= sketch.layout.length
					log('fix sketched', { status: fixSketch.status, layout: fixSketch.layout, kept: better })
					if (better) {
						if (finalJobId) cancelJob(finalJobId)
						const fixed = await fixFinal
						if (fixed.status === 'done') return await finish(fixedSource, fixed, fixSketch.frames, 'fixed', problems, false, chose)
						log('the fix did not render', fixed.error)
						// The first version again: from the cache if its render had finished.
						firstFinal = startFinal(source)
					} else if (fixJobId) cancelJob(fixJobId)
				}
			}
		}
		report({ phase: 'rendering' })
		const final = await firstFinal
		if (final.status !== 'done') throw new AnimationError(final.error ?? 'The final video did not render.')
		return await finish(source, final, sketch.frames, review, problems, false, chose)
	} catch (error) {
		if (signal.aborted) throw abortError()
		throw error
	} finally {
		signal.removeEventListener('abort', cancelAll)
		cancelAll()
	}

	async function finish(
		source: string,
		job: RenderJobView,
		sketchFrames: { url: string; time: number }[],
		review: AnimationResult['review'],
		problems: string[],
		reused: boolean,
		chose: 'A' | 'B' | null = null
	): Promise<AnimationResult> {
		// Remember what was asked for, so asking again comes from the cache.
		if (!options.source && !reused) await post('/render/briefs', { title: options.title, brief: options.brief, source, key: job.key }).catch(() => {})
		return {
			source,
			key: job.key,
			duration: job.duration ?? 0,
			frames: job.frames,
			sketchFrames,
			layout: job.layout,
			review,
			chose,
			problems,
			cached: reused || job.cached,
			seconds: { firstFrame, written, checked, total: elapsed() },
		}
	}
}

export function abortError() {
	return new DOMException('The animation was cancelled.', 'AbortError')
}

function sleep(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(abortError())
		const timer = setTimeout(resolve, ms)
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer)
				reject(abortError())
			},
			{ once: true }
		)
	})
}

async function toDataUrl(url: string, signal: AbortSignal): Promise<string> {
	const bytes = new Uint8Array(await (await fetch(url, { signal })).arrayBuffer())
	let binary = ''
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	return `data:image/png;base64,${btoa(binary)}`
}
