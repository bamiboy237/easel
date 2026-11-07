import { Box, TLShapeId, toRichText } from 'tldraw'
import { normalizeQuote } from '../actions/ClaimUserShapesActionUtil'
import { findNoteSpot } from '../agent/findClearSpace'
import { BoardCommandResult } from '../agent/managers/BoardCommandManager'
import type { TldrawAgent } from '../agent/TldrawAgent'
import { GRAPH_TYPE, GraphShape } from '../shapes/GraphShapeUtil'
import { SCENE_TYPE, SceneShape } from '../shapes/SceneShapeUtil'
import { SIMULATION_TYPE, SimulationShape } from '../shapes/SimulationShapeUtil'
import { WIDGET_TYPE, WidgetShape } from '../shapes/WidgetShapeUtil'
import { BoardTarget, describeShape, resolveTarget } from './parts'

/** What a voice turn knows when it changes the board. */
export interface VoiceTurn {
	/** The board revision the voice model last read. */
	baseRev: number
	/** One pass per voice response, so each turn's changes revert on their own. */
	passId: string
	/** One request per conversation. */
	requestId: string
	/** What the user said this turn, for checking a claim on their own shapes. */
	userText: () => string
}

const MIN_QUOTE = 6

/** The shapes this turn may change although the user owns them: the selection, and shapes the user just asked about by name. */
function allowedFor(agent: TldrawAgent, turn: VoiceTurn, shapeId: TLShapeId | null, userWords?: string): Set<TLShapeId> {
	const allowed = new Set<TLShapeId>(agent.editor.getSelectedShapeIds())
	const quote = normalizeQuote(userWords ?? '')
	if (shapeId && quote.length >= MIN_QUOTE && normalizeQuote(turn.userText()).includes(quote)) allowed.add(shapeId)
	return allowed
}

function rejection(result: Extract<BoardCommandResult, { status: 'rejected' }>): string {
	const ids = (result.reason === 'stale' ? result.staleRecordIds : result.protectedRecordIds).map((id) => id.replace(/^shape:/, ''))
	return result.reason === 'stale'
		? `Rejected, nothing changed: the user changed ${ids.join(', ')} after you read the board. Read the board again before you try again.`
		: `Rejected, nothing changed: ${ids.join(', ')} is the user's own work. Change it only when they ask, with their words as user_words.`
}

function parameterNames(shape: GraphShape | SimulationShape | SceneShape | WidgetShape): string[] {
	if (shape.type === SCENE_TYPE) return Object.keys((shape as SceneShape).props.params)
	if (shape.type === WIDGET_TYPE) return Object.keys((shape as WidgetShape).props.params)
	return (shape as GraphShape | SimulationShape).props.parameters.map((p) => p.name)
}

function parameterValue(shape: GraphShape | SimulationShape | SceneShape | WidgetShape, name: string): number | undefined {
	if (shape.type === SCENE_TYPE) return (shape as SceneShape).props.params[name]?.value
	if (shape.type === WIDGET_TYPE) return (shape as WidgetShape).props.params[name]?.value
	return (shape as GraphShape | SimulationShape).props.parameters.find((p) => p.name === name)?.value
}

/** set_parameter: the agent's own action, run as a voice command. */
export function setParameter(agent: TldrawAgent, turn: VoiceTurn, args: { shape: string; name: string; value: number; user_words?: string }) {
	const { editor } = agent
	const target = resolveTarget(editor, args.shape)
	const shape = target && editor.getShape(target.shapeId)
	if (!shape || ![GRAPH_TYPE, SIMULATION_TYPE, SCENE_TYPE, WIDGET_TYPE].includes(shape.type)) {
		return { ok: false, output: `No graph, simulation, scene, or widget called ${args.shape} on the board.` }
	}
	const typed = shape as GraphShape | SimulationShape | SceneShape | WidgetShape
	const names = parameterNames(typed)
	const name = names.find((n) => n === args.name) ?? names.find((n) => n.toLowerCase() === String(args.name).toLowerCase())
	if (!name || !Number.isFinite(args.value)) {
		return { ok: false, output: `${args.shape} has no parameter ${args.name}. Its parameters: ${names.join(', ') || 'none'}.` }
	}
	const util = agent.actions.getAgentActionUtil('set_parameter')
	const result = agent.commands.execute(
		'voice',
		'set_parameter',
		() => {
			util.applyAction(
				{ _type: 'set_parameter', intent: 'voice', shapeId: shape.id.replace(/^shape:/, ''), name, value: args.value, complete: true, time: 0 } as never,
				undefined as never
			)
		},
		{ baseRev: turn.baseRev, allowedShapeIds: allowedFor(agent, turn, shape.id, args.user_words), passId: turn.passId, requestId: turn.requestId }
	)
	if (result.status === 'rejected') return { ok: false, output: rejection(result) }
	const now = parameterValue(editor.getShape(shape.id) as typeof typed, name)
	return { ok: true, output: `Done: ${name} on ${args.shape} is now ${now}.`, commandId: result.commandId }
}

/** A short text placed beside a target, as a voice command. */
function placeText(
	agent: TldrawAgent,
	turn: VoiceTurn,
	type: string,
	near: string,
	text: string,
	meta: Record<string, string | boolean>
) {
	const { editor } = agent
	const target: BoardTarget | null = resolveTarget(editor, near)
	const subject = target?.bounds ?? editor.getViewportPageBounds().clone().expandBy(-200)
	const width = 260
	const lines = Math.max(1, Math.ceil(text.length / 30))
	const size = { w: width, h: 26 * lines + 8 }
	const spot = findNoteSpot(editor, Box.From(subject), size) ?? new Box(subject.maxX + 24, subject.y, size.w, size.h)
	const id = `shape:voice_${type}_${Math.random().toString(36).slice(2, 8)}` as TLShapeId
	const result = agent.commands.execute(
		'voice',
		type,
		() => {
			editor.createShape({
				id,
				type: 'text',
				x: spot.x,
				y: spot.y,
				props: { richText: toRichText(text), autoSize: false, w: width, size: 's', font: 'serif', color: type === 'ask_prediction' ? 'violet' : 'black' },
				meta: { ...meta, voiceTarget: near },
			})
		},
		{ baseRev: turn.baseRev, allowedShapeIds: allowedFor(agent, turn, null), passId: turn.passId, requestId: turn.requestId }
	)
	if (result.status === 'rejected') return { ok: false, output: rejection(result) }
	return { ok: true, output: `Placed ${id.replace(/^shape:/, '')}${target ? ` beside ${near}` : ''}.`, commandId: result.commandId, shapeId: id }
}

export function placeNote(agent: TldrawAgent, turn: VoiceTurn, args: { near: string; text: string }) {
	const text = String(args.text ?? '').trim().slice(0, 240)
	if (!text) return { ok: false, output: 'The note needs text.' }
	return placeText(agent, turn, 'place_note', args.near, text, { voiceNote: true })
}

export function askPrediction(agent: TldrawAgent, turn: VoiceTurn, args: { near: string; question: string }) {
	const question = String(args.question ?? '').trim().slice(0, 200)
	if (!question) return { ok: false, output: 'The prediction needs a question.' }
	const result = placeText(agent, turn, 'ask_prediction', args.near, `Predict: ${question}\nYour guess:`, { prediction: true, question })
	return result.ok ? { ...result, output: `${result.output} Now ask the user aloud and wait for their guess.` } : result
}

/** The shapes the agent added or changed since a point in the command log, for the voice to talk about. */
export function describeNewWork(agent: TldrawAgent, fromIndex: number): { created: string[]; summary: string } {
	const { editor } = agent
	const commands = agent.commands.getHistory().slice(fromIndex).filter((c) => c.status === 'applied' && c.origin === 'agent')
	const created = new Set<string>()
	const changed = new Set<string>()
	for (const c of commands) {
		for (const id of Object.keys(c.payload.added)) if (id.startsWith('shape:')) created.add(id)
		for (const id of Object.keys(c.payload.updated)) if (id.startsWith('shape:') && !created.has(id)) changed.add(id)
	}
	const line = (id: string) => {
		const shape = editor.getShape(id as TLShapeId)
		if (!shape || shape.type === 'arrow') return null
		return `${id.replace(/^shape:/, '')} (${shape.type}): ${describeShape(editor, shape).slice(0, 160)}`
	}
	const createdLines = [...created].map(line).filter(Boolean).slice(0, 20)
	const changedLines = [...changed].map(line).filter(Boolean).slice(0, 10)
	const parts = []
	if (createdLines.length > 0) parts.push(`New on the board:\n${createdLines.join('\n')}`)
	if (changedLines.length > 0) parts.push(`Changed:\n${changedLines.join('\n')}`)
	return { created: [...created], summary: parts.join('\n') || 'Nothing changed on the board.' }
}
