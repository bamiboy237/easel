import { Box, TLShapeId } from 'tldraw'
import type { TldrawAgent } from './TldrawAgent'

/** Space kept between two blocks the agent stacks. */
const GAP = 20
/** How many times a block may move before it is left where it is. */
const MAX_MOVES = 12

/**
 * Keep a block the agent just made off the blocks it made earlier in the same
 * request. The model places a block by guessing the size of the ones above it,
 * and a typeset fraction or a scene with sliders often comes out taller than
 * the guess, so the next step lands on it. That used to cost a whole repair
 * pass. A block that sits mostly under an earlier one moves down below it; one
 * that sits mostly beside it moves right. Only the new block moves, so work the
 * agent already placed, and everything the user made, stays put.
 */
export function settleBlock(agent: TldrawAgent, id: TLShapeId) {
	const { editor } = agent
	const shape = editor.getShape(id)
	if (!shape) return
	const parentId = shape.parentId
	const earlier = agent.lints
		.getCreatedShapes()
		.filter((s) => s.id !== id && s.parentId === parentId && isBlock(s.type))
		.map((s) => editor.getShapePageBounds(s))
		.filter((b): b is Box => !!b)
	if (earlier.length === 0) return
	let bounds = editor.getShapePageBounds(id)
	if (!bounds) return
	const start = bounds.clone()
	for (let i = 0; i < MAX_MOVES; i++) {
		const current: Box = bounds
		const hits = earlier.filter((b) => overlap(b, current) && !b.contains(current) && !current.contains(b))
		if (hits.length === 0) break
		const stacked = hits.some((b) => sharedWidth(b, current) >= 0.5 * Math.min(b.w, current.w))
		const moved = current.clone()
		if (stacked) moved.y = Math.max(...hits.map((b) => b.maxY)) + GAP
		else moved.x = Math.max(...hits.map((b) => b.maxX)) + GAP
		bounds = moved
	}
	const dx = bounds.x - start.x
	const dy = bounds.y - start.y
	if (dx === 0 && dy === 0) return
	editor.updateShape({ id, type: shape.type, x: shape.x + dx, y: shape.y + dy })
}

/** Shapes that hold content of their own: typeset math, plots, scenes, and text. */
function isBlock(type: string) {
	return ['equation', 'graph', 'scene', 'simulation', 'widget', 'text'].includes(type)
}

function overlap(a: Box, b: Box) {
	return sharedWidth(a, b) > 4 && Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > 4
}

function sharedWidth(a: Box, b: Box) {
	return Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)
}
