import { Box, createShapeId, Editor, TLArrowShape, TLShape, TLShapeId } from 'tldraw'
import type { TldrawAgent } from './TldrawAgent'

/** The least room a visual needs to read at a glance: about a third of a screen's width. */
const MIN_W = 360
const MIN_BODY_H = 220
/** Space kept between the visual and anything else, and from the frame's edges. */
const PAD = 20
/** Grid step of the search for room. */
const STEP = 10

/**
 * Make room for a visual the agent placed in a frame. The model guesses the
 * room left in a frame from the board's JSON, and a full frame gets a visual
 * squeezed into a strip at its bottom edge, too small to read and touching
 * what is above it. A teacher with a full panel draws the figure at a readable
 * size in clear space beside it and points to it. So:
 *
 * 1. The visual gets at least a readable size.
 * 2. If that fits in the frame's clear space, it goes to the nearest spot there.
 * 3. If not, it goes to the nearest clear space beside the frame, on the
 *    page, with a short dotted leader to the frame, so it still reads as the
 *    frame's content.
 *
 * Geometric repair of this kind (rather than asking the model to look again)
 * is what worked best for layout defects in SGA (arXiv 2607.18116). Only the
 * agent's new visual and its leader move or change; nothing else does.
 *
 * `chrome` is the part of the visual's height that is controls, not drawing,
 * such as sliders under a scene. Returns the visual's new size when it grew.
 */
export function fitInFrame(agent: TldrawAgent, id: TLShapeId, chrome: number): { w: number; h: number } | null {
	const { editor } = agent
	const shape = editor.getShape(id)
	const bounds = editor.getShapePageBounds(id)
	if (!shape || !bounds) return null
	const pageId = editor.getCurrentPageId()
	const frame = frameOf(editor, shape, bounds)
	if (!frame) return null
	const frameBounds = editor.getShapePageBounds(frame.id)
	if (!frameBounds) return null
	const props = shape.props as { w?: number; h?: number }
	if (typeof props.w !== 'number' || typeof props.h !== 'number') return null
	const w = Math.max(props.w, MIN_W)
	const h = chrome + Math.max(props.h - chrome, MIN_BODY_H)
	const grew = w !== props.w || h !== props.h

	// What is drawn in the frame, other than this visual and its leader.
	const inside: Box[] = []
	editor.visitDescendants(frame.id, (child) => {
		if (child === frame.id || child === id || child === leaderId(id)) return
		const b = editor.getShapePageBounds(child)
		if (b) inside.push(b)
	})
	const clearOf = (box: Box, obstacles: Box[]) => obstacles.every((o) => !box.clone().expandBy(PAD).collides(o))
	const wanted = new Box(bounds.x, bounds.y, w, h)
	const fitsWhere = (box: Box) => frameBounds.clone().expandBy(-PAD).contains(box) && clearOf(box, inside)
	if (!grew && fitsWhere(wanted)) {
		removeLeader(editor, id)
		return null
	}

	// The nearest clear spot in the frame.
	let best: { box: Box; d: number } | null = null
	for (let y = frameBounds.minY + PAD; y + h <= frameBounds.maxY - PAD; y += STEP) {
		for (let x = frameBounds.minX + PAD; x + w <= frameBounds.maxX - PAD; x += STEP) {
			const d = Math.hypot(x - bounds.x, y - bounds.y)
			if (best && d >= best.d) continue
			const box = new Box(x, y, w, h)
			if (clearOf(box, inside)) best = { box, d }
		}
	}
	if (best) {
		place(editor, shape, best.box, frame.id, grew)
		removeLeader(editor, id)
		return grew ? { w, h } : null
	}

	// No room in the frame: the nearest clear space beside it, on the page.
	const page = editor
		.getCurrentPageShapes()
		.filter((s) => s.parentId === pageId && s.id !== id && s.id !== leaderId(id))
		.map((s) => editor.getShapePageBounds(s))
		.filter((b): b is Box => !!b)
	const gap = 48
	// Each side of the frame, sliding along it and stepping away from it. The
	// left of the board is the user's own space (docs/design.md), so it comes last.
	const candidates: { box: Box; cost: number }[] = []
	for (let out = 0; out <= 600; out += 40) {
		for (let k = -10; k <= 30; k++) {
			const slideY = frameBounds.minY + k * 20
			const slideX = frameBounds.minX + k * 20
			candidates.push(
				{ box: new Box(frameBounds.maxX + gap + out, slideY, w, h), cost: 0 },
				{ box: new Box(slideX, frameBounds.maxY + gap + out, w, h), cost: 0 },
				{ box: new Box(slideX, frameBounds.minY - gap - h - out, w, h), cost: 0 },
				{ box: new Box(frameBounds.minX - gap - w - out, slideY, w, h), cost: 600 }
			)
		}
	}
	// Distance from the frame, a little more for a spot off to the side of where
	// the visual was meant to go, so it lands as close to its subject as it can.
	const gapTo = (box: Box) =>
		Math.hypot(
			Math.max(frameBounds.minX - box.maxX, box.minX - frameBounds.maxX, 0),
			Math.max(frameBounds.minY - box.maxY, box.minY - frameBounds.maxY, 0)
		)
	const outside = candidates
		.filter(({ box }) => clearOf(box, page))
		// The leader must not cross anything on its way to the frame.
		.filter(({ box }) => {
			const { start, end } = leaderEnds(box, frameBounds)
			return page.every((o) => o === frameBounds || !segmentHits(start, end, o))
		})
		.map(({ box, cost }) => ({ box, d: cost + gapTo(box) + 0.25 * Math.hypot(box.midX - bounds.midX, box.midY - bounds.midY) }))
		.sort((a, b) => a.d - b.d)[0]
	if (!outside) return null
	place(editor, shape, outside.box, pageId, true)
	drawLeader(editor, id, outside.box, frameBounds)
	return { w, h }
}

/** The frame a visual was put in: its parent, or the top-level frame around its middle. */
function frameOf(editor: Editor, shape: TLShape, bounds: Box) {
	const parent = editor.getShape(shape.parentId as TLShapeId)
	if (parent?.type === 'frame') return parent
	if (shape.parentId !== editor.getCurrentPageId()) return null
	return editor
		.getCurrentPageShapes()
		.filter((s) => s.type === 'frame' && s.parentId === editor.getCurrentPageId())
		.find((s) => editor.getShapePageBounds(s)?.containsPoint(bounds.center))
}

function place(editor: Editor, shape: TLShape, box: Box, parentId: TLShape['parentId'], resize: boolean) {
	if (shape.parentId !== parentId) editor.reparentShapes([shape.id], parentId)
	const current = editor.getShape(shape.id)!
	const at = editor.getShapePageBounds(shape.id)!
	editor.updateShape({
		id: shape.id,
		type: shape.type,
		x: current.x + (box.x - at.x),
		y: current.y + (box.y - at.y),
		...(resize ? { props: { w: box.w, h: box.h } } : {}),
	} as Parameters<Editor['updateShape']>[0])
}

function leaderId(id: TLShapeId) {
	return createShapeId(`${id.replace(/^shape:/, '')}-leader`)
}

function removeLeader(editor: Editor, id: TLShapeId) {
	if (editor.getShape(leaderId(id))) editor.deleteShapes([leaderId(id)])
}

/** The visual's side that faces the frame, and the closest point on the frame to it. */
function leaderEnds(box: Box, frame: Box) {
	const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
	let start: { x: number; y: number }
	if (box.minX >= frame.maxX) start = { x: box.minX, y: clamp(frame.midY, box.minY + 20, box.maxY - 20) }
	else if (box.maxX <= frame.minX) start = { x: box.maxX, y: clamp(frame.midY, box.minY + 20, box.maxY - 20) }
	else if (box.minY >= frame.maxY) start = { x: clamp(frame.midX, box.minX + 20, box.maxX - 20), y: box.minY }
	else start = { x: clamp(frame.midX, box.minX + 20, box.maxX - 20), y: box.maxY }
	const end = { x: clamp(start.x, frame.minX, frame.maxX), y: clamp(start.y, frame.minY, frame.maxY) }
	return { start, end }
}

/** Whether a straight segment passes through a box, sampled finely enough for a board. */
function segmentHits(a: { x: number; y: number }, b: { x: number; y: number }, box: Box) {
	for (let i = 1; i < 40; i++) {
		const t = i / 40
		if (box.containsPoint({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return true
	}
	return false
}

/** A short dotted line from the visual's nearest side to the frame's edge. */
function drawLeader(editor: Editor, id: TLShapeId, box: Box, frame: Box) {
	const { start, end } = leaderEnds(box, frame)
	const lid = leaderId(id)
	const props = {
		start: { x: 0, y: 0 },
		end: { x: end.x - start.x, y: end.y - start.y },
		dash: 'dotted' as const,
		color: 'grey' as const,
		size: 's' as const,
		arrowheadStart: 'none' as const,
		arrowheadEnd: 'dot' as const,
	}
	if (editor.getShape(lid)) editor.updateShape<TLArrowShape>({ id: lid, type: 'arrow', x: start.x, y: start.y, props })
	else editor.createShape<TLArrowShape>({ id: lid, type: 'arrow', x: start.x, y: start.y, props })
}
