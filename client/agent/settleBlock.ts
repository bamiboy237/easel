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
	// A diagram the agent drew in this request is one block, as large as all its
	// parts: its layout can come out wider than the model guessed, and a note
	// written beside it must not land on it, even in the space between its boxes,
	// where arrows run.
	const parts = new Map<string, Box[]>()
	for (const s of agent.lints.getCreatedShapes()) {
		const diagram = s.meta?.diagram
		if (s.id === id || s.parentId !== parentId || typeof diagram !== 'string') continue
		const b = editor.getShapePageBounds(s)
		if (b) parts.set(diagram, [...(parts.get(diagram) ?? []), b])
	}
	const diagrams = [...parts.values()].map((boxes) => Box.Common(boxes))
	if (earlier.length === 0 && diagrams.length === 0) return
	let bounds = editor.getShapePageBounds(id)
	if (!bounds) return
	const start = bounds.clone()
	for (let i = 0; i < MAX_MOVES; i++) {
		const current: Box = bounds
		// Off a diagram: to its right or below it, whichever is the shorter move.
		const onDiagram = diagrams.find((b) => overlap(b, current))
		if (onDiagram) {
			const moved = current.clone()
			if (onDiagram.maxX + GAP - current.x <= onDiagram.maxY + GAP - current.y) moved.x = onDiagram.maxX + GAP
			else moved.y = onDiagram.maxY + GAP
			bounds = moved
			continue
		}
		const hits = earlier.filter((b) => overlap(b, current) && !b.contains(current) && !current.contains(b))
		if (hits.length === 0) break
		const stacked = hits.some((b) => sharedWidth(b, current) >= 0.5 * Math.min(b.w, current.w))
		const moved = current.clone()
		if (stacked) moved.y = Math.max(...hits.map((b) => b.maxY)) + GAP
		else moved.x = Math.max(...hits.map((b) => b.maxX)) + GAP
		bounds = moved
	}
	// An explanation written beside a visual the agent just made, such as a scene
	// or a diagram, sits close to it: the model guesses the visual's width, and a
	// wide gap reads as two separate things. Only across clear space.
	if (shape.type === 'text') {
		const visuals = [
			...agent.lints
				.getCreatedShapes()
				.filter((s) => s.id !== id && s.parentId === parentId && VISUALS.includes(s.type))
				.map((s) => editor.getShapePageBounds(s))
				.filter((b): b is Box => !!b),
			...diagrams,
		]
		const current: Box = bounds
		const beside = visuals
			.filter((b) => b.maxX + NEAR < current.minX && current.minY >= b.minY - 8 && current.minY < b.maxY - 40)
			.sort((a, b) => b.maxX - a.maxX)[0]
		if (beside) {
			const corridor = new Box(beside.maxX + 1, current.minY, current.minX - beside.maxX - 2, current.h)
			const blocked = editor
				.getCurrentPageShapes()
				.filter((s) => s.id !== id && s.type !== 'frame' && s.type !== 'arrow')
				.some((s) => {
					const b = editor.getShapePageBounds(s)
					return !!b && overlap(b, corridor)
				})
			if (!blocked) bounds = current.clone().translate({ x: beside.maxX + NEAR - current.minX, y: 0 })
		}
	}
	const dx = bounds.x - start.x
	const dy = bounds.y - start.y
	if (dx === 0 && dy === 0) return
	editor.updateShape({ id, type: shape.type, x: shape.x + dx, y: shape.y + dy })
}

/** The gap kept between a visual and the explanation beside it. */
const NEAR = 40
/** Visuals an explanation is written beside. */
const VISUALS = ['graph', 'scene', 'simulation', 'widget', 'animation']

/** Shapes that hold content of their own: typeset math, plots, scenes, and text. */
function isBlock(type: string) {
	return ['equation', 'graph', 'scene', 'simulation', 'widget', 'animation', 'text'].includes(type)
}

function overlap(a: Box, b: Box) {
	return sharedWidth(a, b) > 4 && Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > 4
}

function sharedWidth(a: Box, b: Box) {
	return Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)
}
