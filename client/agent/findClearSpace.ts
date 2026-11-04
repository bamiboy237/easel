import { Box, Editor, TLShapeId } from 'tldraw'

/** Space kept between new work and the shapes around it. */
const MARGIN = 40
/** Distance between new work and the subject it relates to. */
const GAP = 80
/** How far a candidate slides along one side before that side is given up. */
const SLIDE_STEP = 80
const SLIDE_STEPS = 12

/** Top-level shapes on the page. A shape inside a frame is covered by its frame. */
function getObstacles(editor: Editor): Box[] {
	const pageId = editor.getCurrentPageId()
	return editor
		.getCurrentPageShapes()
		.filter((shape) => shape.parentId === pageId)
		.map((shape) => editor.getShapePageBounds(shape))
		.filter((bounds): bounds is Box => !!bounds)
}

function isClear(box: Box, obstacles: Box[]) {
	const padded = box.clone().expandBy(MARGIN)
	return obstacles.every((obstacle) => !padded.collides(obstacle))
}

/**
 * Clear space beside a subject: to its right, then below, left, and above,
 * sliding along each side until the space is free of other shapes.
 */
export function findClearSpaceBeside(editor: Editor, subject: Box, size: { w: number; h: number }): Box | null {
	const obstacles = getObstacles(editor).filter((obstacle) => !subject.contains(obstacle))
	const sides = [
		(i: number) => new Box(subject.maxX + GAP + i * SLIDE_STEP, subject.y, size.w, size.h),
		(i: number) => new Box(subject.x, subject.maxY + GAP + i * SLIDE_STEP, size.w, size.h),
		(i: number) => new Box(subject.x - GAP - size.w - i * SLIDE_STEP, subject.y, size.w, size.h),
		(i: number) => new Box(subject.x, subject.y - GAP - size.h - i * SLIDE_STEP, size.w, size.h),
	]
	for (let i = 0; i <= SLIDE_STEPS; i++) {
		for (const side of sides) {
			const candidate = side(i)
			if (isClear(candidate, obstacles)) return candidate
		}
	}
	return null
}

/** Clear space inside the user's view, scanning from the top left. */
export function findClearSpaceInView(editor: Editor, size: { w: number; h: number }): Box | null {
	const view = editor.getViewportPageBounds()
	const obstacles = getObstacles(editor)
	const step = Math.max(40, Math.min(size.w, size.h) / 4)
	for (let y = view.y + MARGIN; y + size.h <= view.maxY - MARGIN; y += step) {
		for (let x = view.x + MARGIN; x + size.w <= view.maxX - MARGIN; x += step) {
			const candidate = new Box(x, y, size.w, size.h)
			if (isClear(candidate, obstacles)) return candidate
		}
	}
	return null
}

/**
 * A spot for a small note tied to a subject, such as a thread beside its mark.
 * It tries every side, sliding along each a line at a time, and takes the clear
 * spot nearest the subject. The right side wins a tie, then below, left, and
 * above. A spot inside the view beats one outside it. Only when no side has
 * room near the subject does the note step further right. Notes sit closer
 * than new work, so this uses a small margin.
 */
export function findNoteSpot(
	editor: Editor,
	subject: Box,
	size: { w: number; h: number },
	ignore: TLShapeId[] = []
): Box | null {
	const ignored = new Set(ignore)
	const obstacles = editor
		.getCurrentPageShapes()
		.filter((shape) => shape.parentId === editor.getCurrentPageId() && !ignored.has(shape.id))
		.map((shape) => editor.getShapePageBounds(shape))
		.filter((bounds): bounds is Box => !!bounds && !subject.contains(bounds))
	const view = editor.getViewportPageBounds()
	const margin = 8
	const gap = 24
	const isClear = (box: Box) => {
		const padded = box.clone().expandBy(margin)
		return obstacles.every((obstacle) => !padded.collides(obstacle))
	}

	let best: { box: Box; score: number } | null = null
	const consider = (x: number, y: number, side: number) => {
		const box = new Box(x, y, size.w, size.h)
		if (!isClear(box)) return
		// Distance the eye travels from the subject to the note, plus a small
		// preference for the right side and for staying in view.
		const dx = Math.max(subject.x - box.maxX, box.x - subject.maxX, 0)
		const dy = Math.max(subject.y - box.maxY, box.y - subject.maxY, 0)
		const slide = side === 0 || side === 2 ? Math.abs(box.y - subject.y) : Math.abs(box.x - subject.x)
		const score = Math.hypot(dx, dy) + slide * 0.5 + side * 12 + (view.contains(box) ? 0 : 400)
		if (!best || score < best.score) best = { box, score }
	}
	// A subject inside a frame has no room beside it inside the frame, so the
	// sides of each shape that holds it are tried too, still scored by distance
	// to the subject itself.
	const anchors = [subject, ...obstacles.filter((obstacle) => obstacle.contains(subject))]
	for (const anchor of anchors) {
		for (let step = 0; step <= 8; step++) {
			for (const k of step === 0 ? [0] : [step, -step]) {
				const y = subject.y + k * 24
				const x = subject.x + k * 40
				consider(anchor.maxX + gap, y, 0)
				consider(x, anchor.maxY + gap, 1)
				consider(anchor.x - gap - size.w, y, 2)
				consider(x, anchor.y - gap - size.h, 3)
			}
		}
	}
	if (best) return (best as { box: Box }).box
	for (let right = 1; right <= 4; right++) {
		for (let down = 0; down <= 6; down++) {
			const candidate = new Box(subject.maxX + gap + right * 160, subject.y + down * 24, size.w, size.h)
			if (isClear(candidate)) return candidate
		}
	}
	return null
}

/** True when a box overlaps a top-level shape other than the ones ignored. */
export function overlapsShapes(editor: Editor, box: Box, ignore: TLShapeId[] = []): boolean {
	const ignored = new Set(ignore)
	return editor
		.getCurrentPageShapes()
		.filter((shape) => shape.parentId === editor.getCurrentPageId() && !ignored.has(shape.id))
		.some((shape) => {
			const bounds = editor.getShapePageBounds(shape)
			return !!bounds && box.collides(bounds)
		})
}
