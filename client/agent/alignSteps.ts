import { Box, TLShapeId } from 'tldraw'
import { EQUATION_TYPE, EquationShape, measureRelationX } from '../shapes/EquationShapeUtil'
import type { TldrawAgent } from './TldrawAgent'

/** How far below the step above a new step may start and still count as the next line. */
const MAX_LINE_GAP = 140
/** How far a step may slide sideways to line up; more means it was put somewhere else on purpose. */
const MAX_SHIFT = 260

/**
 * Line a new step of a derivation up with the step above it on their equals
 * signs, as a worked example in a textbook is set (an align environment):
 * the eye runs down one column of relations and sees what changed on each
 * side. Only a step the agent made in this request moves, and only sideways.
 * It stays put when the step above has no relation, when the two do not read
 * as consecutive lines, or when the move would land it on something else.
 */
export function alignStep(agent: TldrawAgent, id: TLShapeId) {
	const { editor } = agent
	const shape = editor.getShape<EquationShape>(id)
	if (!shape || shape.type !== EQUATION_TYPE) return
	const relation = measureRelationX(shape.props.latex, shape.props.size)
	if (relation === null) return
	const bounds = editor.getShapePageBounds(id)
	if (!bounds) return
	const earlier = agent.lints
		.getCreatedShapes()
		.filter((s): s is EquationShape => s.id !== id && s.type === EQUATION_TYPE && s.parentId === shape.parentId)
		.map((s) => ({ shape: s, box: editor.getShapePageBounds(s) }))
		.filter((s): s is { shape: EquationShape; box: Box } => !!s.box)
	// The step just above: it ends above this one starts, close by, and shares its column.
	const above = earlier
		.filter(({ box }) => box.maxY <= bounds.minY + 4 && bounds.minY - box.maxY <= MAX_LINE_GAP)
		.filter(({ box }) => Math.abs(box.minX - bounds.minX) <= MAX_SHIFT)
		.sort((a, b) => b.box.maxY - a.box.maxY)[0]
	if (!above) return
	const aboveRelation = measureRelationX(above.shape.props.latex, above.shape.props.size)
	if (aboveRelation === null) return
	const dx = above.box.minX + aboveRelation - (bounds.minX + relation)
	if (Math.abs(dx) < 1 || Math.abs(dx) > MAX_SHIFT) return
	// The moved step must not land on anything but its own old place.
	const moved = bounds.clone()
	moved.x += dx
	const others = editor
		.getCurrentPageShapes()
		.filter((s) => s.id !== id && s.parentId === shape.parentId && s.type !== 'arrow' && s.type !== 'frame')
		.map((s) => editor.getShapePageBounds(s))
		.filter((b): b is Box => !!b)
	if (others.some((b) => b.collides(moved.clone().expandBy(-2)))) return
	editor.updateShape({ id, type: EQUATION_TYPE, x: shape.x + dx })
}
