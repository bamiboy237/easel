import { atom, BoxModel, TLFrameShape, TLShape, TLShapeId } from 'tldraw'
import { getShapeCreator } from './BoardCommandManager'
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
	/** The frame being filled now, by the map or by the user's "Fill this part". */
	private $current = atom<TLShapeId | null>('frame being filled', null)
	/** Frames still waiting for their turn, as an atom so the board's part controls follow. */
	private $queued = atom<readonly TLShapeId[]>('frames waiting', [])
	/** A frame the user asked to fill on its own. Unlike the map's queue, a new request does not clear it. */
	private manual: TLShapeId | null = null

	reset(): void {
		this.frames = []
		this.setPending([])
		if (this.$current.get() !== this.manual) this.$current.set(null)
		for (const p of this.prefetched.values()) p.controller.abort('Map ended')
		this.prefetched.clear()
	}

	private setPending(frames: MapFrame[]) {
		this.pending = frames
		this.$queued.set(frames.map((f) => f.id))
	}

	/**
	 * Where one part of a map stands:
	 * - filling: the agent is filling it now.
	 * - queued: it waits for its turn in this request.
	 * - unfinished: its fill never finished, because the user stopped it or the request failed.
	 * - done: its fill finished.
	 * Null for a frame that is not part of a map.
	 */
	getPartStatus(frame: TLShape): 'filling' | 'queued' | 'unfinished' | 'done' | null {
		const fill = frame.meta.fill
		if (fill !== 'pending' && fill !== 'done') return null
		const generating = this.agent.requests.isGenerating()
		if (generating && this.$current.get() === frame.id) return 'filling'
		if (generating && this.$queued.get().includes(frame.id)) return 'queued'
		return fill === 'pending' ? 'unfinished' : 'done'
	}

	/** Record that a frame's fill finished, as an agent command beside the fill's own. */
	private markFilled(id: TLShapeId) {
		const { editor } = this.agent
		const frame = editor.getShape(id)
		if (!frame || frame.meta.fill !== 'pending') return
		this.agent.commands.execute(
			'agent',
			'part-filled',
			() =>
				editor.run(() => editor.updateShape({ id, type: frame.type, meta: { ...frame.meta, fill: 'done' } }), {
					ignoreShapeLock: true,
					history: 'ignore',
				}),
			{ baseRev: this.agent.commands.getRev(), ...this.agent.getPassIds() }
		)
	}

	/**
	 * Stop one part: a waiting frame leaves the queue, and the frame being
	 * filled stops while the map goes on with the next one. Either stays marked
	 * unfinished, with "Fill this part" on it.
	 */
	stopPart(id: TLShapeId) {
		if (this.$queued.get().includes(id)) {
			this.setPending(this.pending.filter((f) => f.id !== id))
			this.prefetched.get(id)?.controller.abort('Part stopped')
			this.prefetched.delete(id)
			return
		}
		if (this.$current.get() !== id) return
		this.$current.set(null)
		if (this.manual === id) {
			this.manual = null
			this.agent.cancel()
			return
		}
		// Ends this frame's request only. The map then schedules its next frame.
		this.agent.requests.cancel()
	}

	/**
	 * The agent's work in one part of a map: shapes it made inside the frame, and
	 * shapes it drew over the frame that have not been filed into it yet. The
	 * frame's description and the user's own shapes are not part of it.
	 */
	getPartWork(id: TLShapeId): TLShape[] {
		const { editor } = this.agent
		const frameBounds = editor.getShapePageBounds(id)
		if (!frameBounds) return []
		const isDescription = (c: TLShape) => typeof c.meta.note === 'string' && c.meta.note.startsWith('Description of')
		const inside = editor.getSortedChildIdsForParent(id).map((child) => editor.getShape(child)).filter((c): c is TLShape => !!c)
		const pageId = editor.getCurrentPageId()
		const over = editor.getCurrentPageShapes().filter((shape) => {
			if (shape.parentId !== pageId || shape.id === id || shape.type === 'frame') return false
			const b = editor.getShapePageBounds(shape)
			return !!b && frameBounds.contains(b)
		})
		return [...inside, ...over].filter((c) => !isDescription(c) && getShapeCreator(c) !== 'user')
	}

	/**
	 * The user asks for one part of a map again. "Fill" keeps what the frame
	 * already holds and adds what is missing; "redo" first removes the agent's
	 * shapes in it and starts the part over. The user's own shapes in the frame
	 * stay either way. Runs as a user request of its own.
	 */
	async fillPart(id: TLShapeId, { redo = false }: { redo?: boolean } = {}) {
		const { editor } = this.agent
		const frame = editor.getShape<TLFrameShape>(id)
		if (!frame || frame.type !== 'frame' || this.agent.requests.isGenerating()) return
		const title = frame.props.name.trim() || 'this part'
		const children = editor.getSortedChildIdsForParent(id).map((child) => editor.getShape(child)).filter((c): c is TLShape => !!c)
		const descriptionShape = children.find((c) => typeof c.meta.note === 'string' && c.meta.note.startsWith('Description of'))
		const description = descriptionShape ? this.agent.commands.getShapeText(descriptionShape) : ''
		if (redo) {
			const agentShapes = this.getPartWork(id)
			if (agentShapes.length > 0) {
				this.agent.commands.execute('user', 'redo-part', () => editor.deleteShapes(agentShapes.map((c) => c.id)))
			}
		}
		const bounds = editor.getShapePageBounds(id)
		if (!bounds) return
		const helpers = new AgentHelpers(this.agent)
		const modelBounds = helpers.roundBox(helpers.applyOffsetToBox(bounds))
		const kept = !redo && this.getPartWork(id).length > 0
		const message =
			fillMessage({ id, title, description, modelBounds }) +
			(kept ? '\nThe frame already holds part of its content. Keep it, do not draw it again, and add only what is missing.' : '')
		this.manual = id
		this.$current.set(id)
		try {
			await this.agent.prompt({
				agentMessages: [message],
				userMessages: [`${redo ? 'Redo' : 'Fill'} the "${title}" part.`],
				bounds: bounds.clone().expandBy(40),
				source: 'user',
			})
		} finally {
			const finished = this.manual === id && this.agent.getOutcome() === null
			if (this.manual === id) this.manual = null
			if (this.$current.get() === id) this.$current.set(null)
			if (finished) this.markFilled(id)
		}
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
		this.setPending([...this.pending, ...frames])
	}

	/**
	 * Move agent-created shapes into the frame they were drawn in, then schedule
	 * the next frame's fill request. Returns false when no frame is left.
	 */
	scheduleNext(): boolean {
		this.fileCreatedShapesIntoFrames()

		// The frame filled by the request that just ended is finished.
		const finished = this.$current.get()
		if (finished && finished !== this.manual) this.markFilled(finished)
		this.$current.set(null)

		const frame = this.pending[0]
		this.setPending(this.pending.slice(1))
		if (!frame) {
			this.reset()
			return false
		}
		this.$current.set(frame.id)

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
				userText: this.agent.getRequestUserText(),
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
The frames are read side by side, so set every frame the same way: one idea per frame, one heading at fontSize 30, body text at fontSize 22 or more in lines of a few words, and one main visual that takes most of the frame's width. Keep the colors the earlier frames gave each quantity.
Fill only this frame. Do not create a map, and do not change other frames or the user's work. When this frame is complete, finish. The app starts the next frame.`
}
