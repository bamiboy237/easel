import { Box, EASINGS, Editor, TLEventInfo } from 'tldraw'
import { getUsableViewBounds } from '../agent/findClearSpace'

/** After the user's last pointer, wheel, or key input, the camera stays still this long. */
const QUIET_MS = 2500
/** A glide, slow enough to follow with the eye. */
const GLIDE_MS = 700
/** Room kept between revealed work and the edge of the usable view, in screen pixels. */
const EDGE = 48
/** The camera never zooms out past this fraction of the user's zoom to reveal work. */
const MIN_ZOOM_RATIO = 0.55

/**
 * Keeps what the voice talks about, and the work it delegates, in view. While
 * a voice conversation points at a part that is off screen, or the agent
 * places work for it there, the camera glides just far enough to show it,
 * inside the part of the view the menu and toolbar leave free. It never moves
 * while the user is working: pressing, dragging, scrolling, typing, editing a
 * shape, or within a moment of any of those.
 */
export class CameraFollow {
	private lastInputAt = 0
	private dispose: () => void

	constructor(private editor: Editor) {
		const onEvent = (info: TLEventInfo) => {
			// Pointer moves without a press are only the hand resting on the mouse.
			if (info.type === 'pointer' && info.name === 'pointer_move' && !editor.inputs.getIsPointing()) return
			this.lastInputAt = performance.now()
		}
		editor.on('event', onEvent)
		this.dispose = () => editor.off('event', onEvent)
	}

	/** Whether the user is working on the board, so the camera must stay where they put it. */
	isUserBusy(now = performance.now()) {
		const { editor } = this
		if (now - this.lastInputAt < QUIET_MS) return true
		if (editor.inputs.getIsPointing() || editor.inputs.getIsDragging() || editor.inputs.getIsPinching()) return true
		if (editor.getEditingShapeId()) return true
		// Typing in the composer, a mark's question, or a shape's text.
		const active = document.activeElement as HTMLElement | null
		if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return true
		return false
	}

	/** Whether a page box is fully inside the part of the view the user can see. */
	isInView(box: Box) {
		return this.usable().contains(box)
	}

	/**
	 * Glide the camera just far enough to show a page box, when the user is not
	 * working. A box too big for the view is shown by zooming out, but no
	 * further than about half the user's zoom; then its top left part is shown.
	 * Returns whether the camera moved.
	 */
	reveal(box: Box): boolean {
		const { editor } = this
		if (this.isUserBusy() || editor.getCameraOptions().isLocked) return false
		if (this.isInView(box)) return false
		const camera = editor.getCamera()
		const screen = editor.getViewportScreenBounds()
		const usable = this.usable()
		const zoom = camera.z
		// The usable view in screen pixels, less the edge.
		const top = (usable.y - editor.getViewportPageBounds().y) * zoom
		const area = { x: EDGE, y: top + EDGE, w: screen.w - EDGE * 2, h: usable.h * zoom - EDGE * 2 }
		if (area.w <= 0 || area.h <= 0) return false
		const fit = Math.min(area.w / box.w, area.h / box.h)
		const z = Math.max(Math.min(zoom, fit), zoom * MIN_ZOOM_RATIO)
		// Page coordinates of the area at the new zoom, before panning. A zoom
		// change keeps the page point at the area's top left corner where it is.
		const view = { x: area.x / zoom - camera.x, y: area.y / zoom - camera.y, w: area.w / z, h: area.h / z }
		// Pan as little as possible: only the sides that are out of view move in.
		const dx = box.w > view.w ? box.x - view.x : box.x < view.x ? box.x - view.x : box.maxX > view.x + view.w ? box.maxX - (view.x + view.w) : 0
		const dy = box.h > view.h ? box.y - view.y : box.y < view.y ? box.y - view.y : box.maxY > view.y + view.h ? box.maxY - (view.y + view.h) : 0
		if (z === zoom && Math.abs(dx) < 1 && Math.abs(dy) < 1) return false
		const next = { x: area.x / z - (view.x + dx), y: area.y / z - (view.y + dy), z }
		editor.setCamera(next, { animation: { duration: GLIDE_MS, easing: EASINGS.easeInOutCubic } })
		return true
	}

	private usable() {
		return getUsableViewBounds(this.editor)
	}

	close() {
		this.dispose()
	}
}
