import { useEffect, useRef, useState } from 'react'
import { Editor, useValue } from 'tldraw'

/**
 * How long after the last camera change the canvas still counts as moving.
 * tldraw's own camera state settles after 64 ms of its frame clock, which a
 * busy or throttled page can skip in one frame, so previews would resume and
 * hold again in the middle of one pan.
 */
const SETTLE_MS = 180

const lastMove = new WeakMap<Editor, { key: string; at: number }>()

/**
 * Whether the user is panning, zooming, or dragging the canvas right now: the
 * camera is moving, or it changed in the last moment. Called every frame by a
 * playing preview, so it sees each camera change.
 */
export function isCanvasMoving(editor: Editor | null | undefined): boolean {
	if (!editor) return false
	const now = performance.now()
	const { x, y, z } = editor.getCamera()
	const key = `${x},${y},${z}`
	const seen = lastMove.get(editor)
	if (!seen) {
		lastMove.set(editor, { key, at: -Infinity })
	} else if (seen.key !== key) {
		seen.key = key
		seen.at = now
	}
	if (editor.getCameraState() === 'moving') return true
	return now - (lastMove.get(editor)?.at ?? -Infinity) < SETTLE_MS
}

/**
 * Advance a clock by the frame time, except while the canvas moves: a playing
 * scene or simulation pauses its frame work during pan and zoom, and resumes
 * from the same time without changing play or pause (docs/design.md,
 * Controls, Animated previews).
 */
export function playbackStep(editor: Editor | null | undefined, dt: number): number {
	return isCanvasMoving(editor) ? 0 : dt
}

/** True while the canvas moves, and until it has been still for a moment. */
function useCanvasMoving(editor: Editor): boolean {
	const camera = useValue('camera', () => editor.getCamera(), [editor])
	const [moving, setMoving] = useState(false)
	const first = useRef(true)
	useEffect(() => {
		if (first.current) {
			first.current = false
			return
		}
		setMoving(true)
		const timer = setTimeout(() => setMoving(false), SETTLE_MS)
		return () => clearTimeout(timer)
	}, [camera])
	return moving
}

/**
 * Hold a playing video while the canvas moves, and let it go on when the
 * camera settles. The video's own play state is untouched: `heldRef` is true
 * while the pause is ours, so the player can ignore that pause event.
 */
export function useHoldVideoWhileMoving(editor: Editor, ref: { current: HTMLVideoElement | null }) {
	const moving = useCanvasMoving(editor)
	const heldRef = useRef(false)
	useEffect(() => {
		const video = ref.current
		if (!video) return
		if (moving && !video.paused) {
			heldRef.current = true
			video.pause()
		} else if (!moving && heldRef.current) {
			heldRef.current = false
			void video.play().catch(() => {})
		}
	}, [moving, ref])
	return heldRef
}
