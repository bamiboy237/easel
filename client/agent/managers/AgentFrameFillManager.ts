import { BoxModel, TLShapeId } from 'tldraw'
import { AgentPrompt } from '../../../shared/types/AgentPrompt'
import { AgentHelpers } from '../../AgentHelpers'
import { BaseAgentManager } from './BaseAgentManager'

export interface MapFrame {
	id: TLShapeId
	title: string
	description: string
	/** Frame bounds in the model's coordinate space, used in the fill request. */
	modelBounds: BoxModel
}

/** How many frames ahead of the one being filled the model already writes. */
const PREFETCH_AHEAD = 2

/**
 * A frame's fill request, sent to the model before its turn. The answer
 * streams in the background and is applied when the frame's turn comes, with
 * the prompt, helpers, and board revision it was asked with.
 */
export interface PrefetchedFill {
	message: string
	prompt: AgentPrompt
	helpers: AgentHelpers
	baseRev: number
	response: Promise<Response>
	controller: AbortController
}

/**
 * Fills the frames of a map one at a time, one follow-up request per frame,
 * so the user can work in finished frames while later ones generate. The model
 * writes the next frames while the current one is placed: frames do not
 * overlap, so each fill is independent of the others, and placing stays one
 * frame at a time.
 */
export class AgentFrameFillManager extends BaseAgentManager {
	private frames: MapFrame[] = []
	private pending: MapFrame[] = []
	private prefetched = new Map<TLShapeId, PrefetchedFill>()

	reset(): void {
		this.frames = []
		this.pending = []
		for (const p of this.prefetched.values()) p.controller.abort('Map ended')
		this.prefetched.clear()
	}

	/**
	 * The prefetched answer for a request, if the request is exactly one frame's
	 * fill. It is taken: each prefetch is used once.
	 */
	takePrefetch(agentMessages: string[]): PrefetchedFill | null {
		if (agentMessages.length !== 1) return null
		for (const [id, p] of this.prefetched) {
			if (p.message !== agentMessages[0]) continue
			this.prefetched.delete(id)
			return p
		}
		return null
	}

	/** Frames still waiting to be filled. */
	getPending(): readonly MapFrame[] {
		return this.pending
	}

	enqueue(frames: MapFrame[]) {
		this.frames.push(...frames)
		this.pending.push(...frames)
	}

	/**
	 * Move agent-created shapes into the frame they were drawn in, then schedule
	 * the next frame's fill request. Returns false when no frame is left.
	 */
	scheduleNext(): boolean {
		this.fileCreatedShapesIntoFrames()

		const frame = this.pending.shift()
		if (!frame) {
			this.reset()
			return false
		}

		const { editor } = this.agent
		const bounds = editor.getShapePageBounds(frame.id)
		if (!bounds) return this.scheduleNext()

		this.agent.schedule({
			agentMessages: [fillMessage(frame)],
			bounds: bounds.clone().expandBy(40),
			source: 'self',
		})
		// The next frames' answers are written while this one is placed.
		for (const next of this.pending.slice(0, PREFETCH_AHEAD)) void this.prefetch(next)
		return true
	}

	private async prefetch(frame: MapFrame) {
		if (this.prefetched.has(frame.id)) return
		const bounds = this.agent.editor.getShapePageBounds(frame.id)
		if (!bounds) return
		const message = fillMessage(frame)
		const request = this.agent.requests.getFullRequestFromInput({
			agentMessages: [message],
			bounds: bounds.clone().expandBy(40),
			source: 'self',
		})
		const helpers = new AgentHelpers(this.agent)
		const baseRev = this.agent.commands.getRev()
		const controller = new AbortController()
		// Claimed before the prompt is built, so a second call does not start another.
		const entry = { message, helpers, baseRev, controller } as PrefetchedFill
		this.prefetched.set(frame.id, entry)
		try {
			entry.prompt = await this.agent.preparePrompt(request, helpers)
		} catch {
			this.prefetched.delete(frame.id)
			return
		}
		if (this.prefetched.get(frame.id) !== entry) return
		entry.response = fetch('/stream', {
			method: 'POST',
			body: JSON.stringify(entry.prompt),
			headers: { 'Content-Type': 'application/json' },
			signal: controller.signal,
		})
		// A failed prefetch is dropped; the frame then asks again at its turn.
		entry.response.catch(() => {
			if (this.prefetched.get(frame.id) === entry) this.prefetched.delete(frame.id)
		})
	}

	private fileCreatedShapesIntoFrames() {
		if (this.frames.length === 0) return
		const { editor } = this.agent
		const pageId = editor.getCurrentPageId()

		const moves = new Map<TLShapeId, TLShapeId[]>()
		for (const shape of this.agent.lints.getCreatedShapes()) {
			if (shape.parentId !== pageId || shape.type === 'frame') continue
			const shapeBounds = editor.getShapePageBounds(shape.id)
			if (!shapeBounds) continue
			const frame = this.frames.find((f) => editor.getShapePageBounds(f.id)?.contains(shapeBounds))
			if (!frame) continue
			moves.set(frame.id, [...(moves.get(frame.id) ?? []), shape.id])
		}
		if (moves.size === 0) return

		const result = this.agent.commands.execute(
			'agent',
			'file-into-frame',
			() => {
				editor.run(
					() => {
						for (const [frameId, ids] of moves) editor.reparentShapes(ids, frameId)
					},
					{ ignoreShapeLock: true, history: 'ignore' }
				)
			},
			{
				baseRev: this.agent.getLastBaseRev(),
				allowedShapeIds: this.agent.getAllowedShapeIds(),
				...this.agent.getPassIds(),
			}
		)
		if (result.status === 'rejected') {
			this.agent.actions.reportRejectedCommand('file-into-frame', result)
		}
	}
}

/** The request that fills one frame. */
function fillMessage(frame: MapFrame): string {
	const { x, y, w, h } = frame.modelBounds
	return `Fill the "${frame.title}" frame: ${frame.description}
The frame spans x=${x}, y=${y}, w=${w}, h=${h}. Its title and description sit at the top. Put all new content inside the frame, starting at y=${y + 110}, with at least 24 units of padding from its edges.
Fill only this frame. Do not create a map, and do not change other frames or the user's work. When this frame is complete, finish. The app starts the next frame.`
}
