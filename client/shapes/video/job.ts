import { TLShapeId } from 'tldraw'
import type { TldrawAgent } from '../../agent/TldrawAgent'
import { VIDEO_TYPE, VideoShape } from '../VideoShapeUtil'
import { freshVideos, runningVideoJobs, setVideoJob } from './jobs'
import { runAnimationPipeline } from './pipeline'

/**
 * Make an animation in the background, like a widget's code: the agent goes on
 * while the placeholder shows the scene taking shape. The finished video lands
 * as one agent command, based on the board as it was when the job started, so
 * it is stale only if the user changed the animation's own fields meanwhile,
 * and revert removes it.
 */
export interface VideoJobContext {
	/** The pass and request of the action that started the job, so revert and review see its command. */
	passId?: string
	requestId?: string
	/** The user shapes the request allowed the agent to change. */
	allowedShapeIds: ReadonlySet<TLShapeId>
	/** Use this source instead of asking the writer, as a test does. */
	source?: string
	renderTimeoutSeconds?: number
}

export async function runVideoJob(agent: TldrawAgent, id: TLShapeId, context: VideoJobContext): Promise<void> {
	const { editor } = agent
	const shape = editor.getShape<VideoShape>(id)
	if (!shape || shape.type !== VIDEO_TYPE) return
	// A newer job for the same animation replaces this one.
	runningVideoJobs.get().get(id)?.controller.abort()
	const controller = new AbortController()
	const startedAt = Date.now()
	setVideoJob(id, { controller, startedAt, progress: { phase: 'writing', progress: 0, frame: null, frames: [] } })
	const baseRev = agent.commands.getRev()
	const { title, brief } = shape.props

	let props: Partial<VideoShape['props']>
	try {
		const result = await runAnimationPipeline({
			title,
			brief,
			modelName: agent.modelName.getModelName(),
			signal: controller.signal,
			source: context.source,
			renderTimeoutSeconds: context.renderTimeoutSeconds,
			onProgress: (progress) => {
				if (runningVideoJobs.get().get(id)?.controller === controller) setVideoJob(id, { controller, startedAt, progress })
			},
			onLog: (event, detail) => console.debug(`[animation ${id}] ${event}`, detail ?? ''),
		})
		props = { status: 'ready', error: '', renderKey: result.key, source: result.source, duration: Math.round(result.duration * 10) / 10 }
	} catch (error) {
		if (controller.signal.aborted) {
			if (runningVideoJobs.get().get(id)?.controller === controller) setVideoJob(id, null)
			return
		}
		props = { status: 'failed', error: (error as Error).message.slice(0, 600) }
	}

	if (runningVideoJobs.get().get(id)?.controller !== controller) return
	setVideoJob(id, null)
	if (!editor.getShape(id)) return
	const options = { baseRev, allowedShapeIds: context.allowedShapeIds, passId: context.passId, requestId: context.requestId }
	const result = agent.commands.execute('agent', 'animation', () => editor.updateShape<VideoShape>({ id, type: VIDEO_TYPE, props }), options)
	if (result.status === 'applied') {
		if (props.status === 'ready') freshVideos.add(id)
		return
	}
	// The user changed the animation meanwhile, or put it inside their own work.
	// The video is not placed, and the shape says why, if the board still allows that.
	console.warn(`Animation ${id} not placed: ${result.reason}.`)
	const error =
		result.reason === 'stale'
			? 'The animation changed while it was being made. Ask for it again.'
			: "The animation is now inside the user's own work, so the agent cannot fill it in. Ask for it again."
	agent.commands.execute('agent', 'animation', () => editor.updateShape<VideoShape>({ id, type: VIDEO_TYPE, props: { status: 'failed', error } }), {
		...options,
		baseRev: agent.commands.getRev(),
	})
}
