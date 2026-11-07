import { atom, Box, Editor, VecModel } from 'tldraw'

/** The AI's cursor: where it flies from and to, and when. */
export interface AiCursorFlight {
	from: VecModel
	to: VecModel
	control: VecModel
	startedAt: number
	duration: number
}

/** How long the cursor takes to fly to its next place. */
export const AI_CURSOR_FLY_MS = 650

const cursors = new WeakMap<Editor, AiCursor>()

/** The one AI cursor of a board, shared by the agent and the voice. */
export function getAiCursor(editor: Editor): AiCursor {
	let cursor = cursors.get(editor)
	if (!cursor) {
		cursor = new AiCursor()
		cursors.set(editor, cursor)
	}
	return cursor
}

/**
 * The AI's own cursor on the board. It flies along a gentle curve, as a hand
 * moves, to where the agent is working or what the voice is talking about.
 * It is an overlay, never a shape or a command.
 */
export class AiCursor {
	readonly $cursor = atom<AiCursorFlight | null>('ai cursor', null)
	private hideTimer: ReturnType<typeof setTimeout> | null = null

	/** Fly to a page point, from where the cursor is now, or from a little up and left of it. */
	flyTo(to: VecModel, duration = AI_CURSOR_FLY_MS) {
		this.cancelHide()
		const now = performance.now()
		const from = this.position(now) ?? { x: to.x - 180, y: to.y - 120 }
		const dx = to.x - from.x
		const dy = to.y - from.y
		const length = Math.hypot(dx, dy)
		if (length < 2 && this.$cursor.get()) return
		// Bow the path to one side, as a hand moves, not a straight line.
		const bow = Math.min(160, (length || 1) * 0.3)
		const control = { x: (from.x + to.x) / 2 - (dy / (length || 1)) * bow, y: (from.y + to.y) / 2 + (dx / (length || 1)) * bow }
		this.$cursor.set({ from, to, control, startedAt: now, duration })
	}

	/** Fly to a box as if the hand just finished drawing it: just inside its lower right corner. */
	flyToBox(box: Box) {
		const inset = Math.min(18, box.w / 4, box.h / 4)
		this.flyTo({ x: box.maxX - inset, y: box.maxY - inset })
	}

	/** Where the cursor is now, or null when it is not on the board. */
	position(now = performance.now()): VecModel | null {
		const cursor = this.$cursor.get()
		if (!cursor) return null
		const t = Math.min(1, Math.max(0, (now - cursor.startedAt) / cursor.duration))
		const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
		const u = 1 - e
		return {
			x: u * u * cursor.from.x + 2 * u * e * cursor.control.x + e * e * cursor.to.x,
			y: u * u * cursor.from.y + 2 * u * e * cursor.control.y + e * e * cursor.to.y,
		}
	}

	/** Take the cursor off the board after a moment, unless it flies again first. */
	hideAfter(ms: number) {
		this.cancelHide()
		this.hideTimer = setTimeout(() => {
			this.hideTimer = null
			this.$cursor.set(null)
		}, ms)
	}

	private cancelHide() {
		if (this.hideTimer) clearTimeout(this.hideTimer)
		this.hideTimer = null
	}
}
