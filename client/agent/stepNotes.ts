import { Box, TLShape, TLShapeId, TLTextShape } from 'tldraw'
import { EQUATION_TYPE } from '../shapes/EquationShapeUtil'
import type { TldrawAgent } from './TldrawAgent'

/** Space between the widest step of a derivation and its column of notes. */
const NOTE_GAP = 40
/** A note is short: a few words on what the step did. */
const MAX_NOTE_CHARS = 90

/**
 * Keep each step's note level with its step. The model writes a derivation's
 * steps and the short notes beside them ("divide both sides by a") at the
 * heights it guesses; a typeset fraction is taller than the guess, so the
 * steps settle lower and the notes drift up against the wrong step. A note
 * written level with a step, as the model placed them, moves to sit level
 * with that step where it really landed, in one column just right of the
 * widest step, so the reader sees each move and its reason together, as in a
 * worked example. Only shapes the agent made in this request move, and a
 * note whose step is unclear, or whose new place is taken, stays put.
 */
export function attachStepNotes(agent: TldrawAgent, parentId: TLShape['parentId'], justMade?: TLShapeId) {
	const { editor } = agent
	// The shape the current action just made is not tracked until the action ends.
	const made = justMade ? editor.getShape(justMade) : undefined
	const created = [...agent.lints.getCreatedShapes().filter((s) => s.id !== justMade), ...(made ? [made] : [])].filter(
		(s) => s.parentId === parentId
	)
	const steps: { s: TLShape; box: Box; asked: number }[] = []
	for (const s of created) {
		if (s.type !== EQUATION_TYPE) continue
		const box = editor.getShapePageBounds(s.id)
		const asked = askedTop(editor.getShape(s.id))
		if (box && asked !== null) steps.push({ s, box, asked })
	}
	steps.sort((a, b) => a.asked - b.asked)
	if (steps.length < 2) return
	// One column of steps: they share their left side, give or take the shift that lines up the equals signs.
	const colMinX = Math.min(...steps.map((x) => x.box.minX))
	const colMaxX = Math.max(...steps.map((x) => x.box.maxX))
	const gaps = steps.slice(1).map((x, i) => x.asked - steps[i].asked).filter((g) => g > 0)
	const pitch = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 60
	const tolerance = Math.max(24, pitch * 0.45)
	const notes = created
		.filter((s): s is TLTextShape => s.type === 'text')
		.map((s) => editor.getShape<TLTextShape>(s.id))
		.filter((s): s is TLTextShape => !!s)
		.map((s) => ({ s, box: editor.getShapePageBounds(s.id)!, text: editor.getShapeUtil(s).getText(s) ?? '' }))
		.filter((x) => x.box && x.text.trim().length > 0 && x.text.length <= MAX_NOTE_CHARS && x.box.minX >= colMinX + 120)
	const claimed = new Map<TLShapeId, { id: TLShapeId; d: number }>()
	const matches: { note: (typeof notes)[number]; step: (typeof steps)[number]; d: number }[] = []
	for (const note of notes) {
		const asked = (note.s.meta.noteAskedY as number | undefined) ?? note.box.minY
		if (note.s.meta.noteAskedY === undefined) editor.updateShape({ id: note.s.id, type: 'text', meta: { ...note.s.meta, noteAskedY: asked } })
		if (asked < steps[0].asked - tolerance || asked > steps[steps.length - 1].asked + tolerance + 40) continue
		const ranked = steps
			.map((step) => ({ step, d: Math.min(Math.abs(asked - step.asked), Math.abs(asked + note.box.h / 2 - (step.asked + step.box.h / 2))) }))
			.sort((a, b) => a.d - b.d)
		const [best, next] = ranked
		if (best.d > tolerance) continue
		// Halfway between two steps says nothing about which one it explains.
		if (next && next.d - best.d < 8) continue
		const prior = claimed.get(best.step.s.id)
		if (prior && prior.d <= best.d) continue
		claimed.set(best.step.s.id, { id: note.s.id, d: best.d })
		matches.push({ note, step: best.step, d: best.d })
	}
	const ours = new Set(created.map((s) => s.id))
	for (const { note, step } of matches) {
		if (claimed.get(step.s.id)?.id !== note.s.id) continue
		const x = colMaxX + NOTE_GAP
		const y = step.box.midY - note.box.h / 2
		if (Math.abs(x - note.box.minX) < 1 && Math.abs(y - note.box.minY) < 1) continue
		const target = new Box(x, y, note.box.w, note.box.h)
		// The new place must be free of everything but this request's own notes and steps.
		const blocked = editor
			.getCurrentPageShapes()
			.filter((s) => s.id !== note.s.id && s.parentId === parentId && s.type !== 'frame' && s.type !== 'arrow')
			.filter((s) => !(ours.has(s.id) && (s.type === 'text' || s.type === EQUATION_TYPE)))
			.some((s) => editor.getShapePageBounds(s)?.collides(target.clone().expandBy(-2)))
		if (blocked) continue
		editor.updateShape({ id: note.s.id, type: 'text', x: note.s.x + (x - note.box.minX), y: note.s.y + (y - note.box.minY) })
	}
}

/** Where the model asked for a step to start, before it settled or lined up. */
function askedTop(shape: TLShape | undefined) {
	if (!shape) return null
	const asked = shape.meta.askedY
	return typeof asked === 'number' ? asked : null
}
