import { Editor, TLShape, TLShapeId } from 'tldraw'
import { alignStep } from '../agent/alignSteps'
import { attachStepNotes } from '../agent/stepNotes'
import { fitInFrame } from '../agent/fitInFrame'
import { settleBlock } from '../agent/settleBlock'
import { registerShapeDescriber } from '../../shared/format/convertTldrawShapeToFocusedShape'
import {
	EquationAction,
	GraphAction,
	RenderAnimationAction,
	SceneAction,
	SceneObjectAction,
	SceneTemplateAction,
	SetParameterAction,
	SimulationAction,
	WidgetAction,
} from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { AgentHelpers } from '../AgentHelpers'
import { compileExpression } from '../shapes/math/expression'
import { clampParameter, ShapeParameter } from '../shapes/math/parameters'
import { EQUATION_TYPE, EquationShape, katexFontsLoaded, katexFontsReady, measureEquation } from '../shapes/EquationShapeUtil'
import type { TldrawAgent } from '../agent/TldrawAgent'
import { describeSceneShape, SCENE_TYPE, sceneChromeHeight, SceneShape } from '../shapes/SceneShapeUtil'
import { checkSceneObjectId, SceneObject, sanitizeSceneObject } from '../shapes/scene/sceneModel'
import { getAllTemplates } from '../shapes/scene/templates'
import { describeGraph, GRAPH_TYPE, GraphFunction, GraphShape, parametersHeight } from '../shapes/GraphShapeUtil'
import {
	describeSimulation,
	PROJECTILE_PARAMETERS,
	SIMULATION_TYPE,
	SimulationShape,
} from '../shapes/SimulationShapeUtil'
import { describeWidget, WIDGET_TYPE, widgetChromeHeight, WidgetShape } from '../shapes/WidgetShapeUtil'
import { runWidgetJob } from '../shapes/widget/job'
import { describeVideo, VIDEO_TYPE, videoHeightForWidth, VideoShape } from '../shapes/VideoShapeUtil'
import { runVideoJob } from '../shapes/video/job'
import { AgentActionUtil, registerActionUtil } from './AgentActionUtil'

// The agent reads these shapes as a line each: the equation's LaTeX, and a
// graph's or a simulation's current parameter values, so it sees the user's changes.
registerShapeDescriber(EQUATION_TYPE, (shape) => `Equation: ${(shape as EquationShape).props.latex}`)
registerShapeDescriber(GRAPH_TYPE, (shape) => describeGraph((shape as GraphShape).props))
registerShapeDescriber(SIMULATION_TYPE, (shape) => describeSimulation((shape as SimulationShape).props))
registerShapeDescriber(SCENE_TYPE, (shape) => describeSceneShape(shape as SceneShape))
registerShapeDescriber(WIDGET_TYPE, (shape) => describeWidget((shape as WidgetShape).props, shape.id as TLShapeId))
registerShapeDescriber(VIDEO_TYPE, (shape) => describeVideo((shape as VideoShape).props, shape.id as TLShapeId))

/**
 * The shape an interactive action works on: the existing one of that type, to
 * change it, or a fresh id to create one. A shapeId already used by a
 * different kind of shape gets a unique variant, so nothing else is overwritten.
 */
function resolveTarget<S extends TLShape>(
	helpers: AgentHelpers,
	shapeId: string | undefined,
	type: string
): { id: TLShapeId; existing: S | null } {
	const { editor } = helpers.agent
	const simple = (shapeId || type) as Parameters<AgentHelpers['ensureShapeIdIsUnique']>[0]
	// An id the agent gave earlier in this turn may have been renamed to stay
	// unique; it still means the shape it named then.
	const mapped = helpers.shapeIdMap.get(String(simple)) ?? simple
	const existing = editor.getShape(`shape:${mapped}` as TLShapeId)
	if (existing && existing.type === type) return { id: existing.id, existing: existing as S }
	const unique = helpers.ensureShapeIdIsUnique(simple)
	return { id: `shape:${unique}` as TLShapeId, existing: null }
}

/** A clean list of parameters from the model: named, numeric, inside a sensible range. */
function sanitizeParameters(parameters: Partial<ShapeParameter>[] | undefined): ShapeParameter[] {
	const seen = new Set<string>()
	const out: ShapeParameter[] = []
	for (const p of parameters ?? []) {
		const name = (p.name ?? '').trim()
		if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name) || seen.has(name)) continue
		seen.add(name)
		let min = Number.isFinite(p.min) ? p.min! : 0
		let max = Number.isFinite(p.max) ? p.max! : 10
		if (max <= min) [min, max] = [Math.min(min, max), Math.max(min, max, min + 1)]
		const step = Number.isFinite(p.step) && p.step! > 0 ? p.step! : (max - min) / 100
		const unit = typeof p.unit === 'string' && p.unit.trim() && p.unit.trim().length <= 8 ? p.unit.trim() : undefined
		const parameter = { name, min, max, step, value: Number.isFinite(p.value) ? p.value! : min, ...(unit ? { unit } : {}) }
		out.push({ ...parameter, value: clampParameter(parameter, parameter.value) })
	}
	return out
}

export const EquationActionUtil = registerActionUtil(
	class EquationActionUtil extends AgentActionUtil<EquationAction> {
		static override type = 'equation' as const

		override getInfo(action: Streaming<EquationAction>) {
			return { icon: 'pencil' as const, description: action.intent ?? '' }
		}

		override applyAction(action: Streaming<EquationAction>, helpers: AgentHelpers) {
			if (!action.complete || typeof action.latex !== 'string') return
			const { editor } = this
			const size = Number.isFinite(action.size) && action.size > 8 ? Math.min(action.size, 96) : 24
			const latex = action.latex.trim().replace(/^\$+|\$+$/g, '')
			const { id, existing } = resolveTarget<EquationShape>(helpers, action.shapeId, EQUATION_TYPE)
			const props = { latex, size, ...measureEquation(latex, size) }
			if (existing) {
				editor.updateShape<EquationShape>({ id, type: EQUATION_TYPE, props })
				return
			}
			const at = helpers.removeOffsetFromVec({ x: action.x ?? 0, y: action.y ?? 0 })
			// Where the model asked for the step, before it settles: notes beside the
			// derivation were placed level with that (see attachStepNotes).
			editor.createShape<EquationShape>({ id, type: EQUATION_TYPE, x: at.x, y: at.y, props, meta: { askedY: at.y } })
			settleBlock(this.agent, id)
			alignStep(this.agent, id)
			const step = editor.getShape(id)
			if (step) attachStepNotes(this.agent, step.parentId, id)
			// Measured before the KaTeX faces loaded: measure again once they have,
			// and line the step and its note up again on the real widths.
			if (!katexFontsLoaded()) {
				const baseRev = this.agent.commands.getRev()
				void katexFontsReady.then(() => remeasureStep(this.agent, id, baseRev))
			}
		}
	}
)

/**
 * Measure an equation again in the real KaTeX faces, as an agent command of
 * its own, and realign it. Only a shape the agent still owns as it made it
 * changes: a stale command is rejected like any other.
 */
function remeasureStep(agent: TldrawAgent, id: TLShapeId, baseRev: number) {
	const { editor } = agent
	const shape = editor.getShape<EquationShape>(id)
	if (!shape || shape.type !== EQUATION_TYPE) return
	const size = measureEquation(shape.props.latex, shape.props.size)
	if (Math.abs(size.w - shape.props.w) < 2 && Math.abs(size.h - shape.props.h) < 2) return
	agent.commands.execute(
		'agent',
		'equation-measure',
		() => {
			editor.updateShape<EquationShape>({ id, type: EQUATION_TYPE, props: size })
			alignStep(agent, id)
			const step = editor.getShape(id)
			if (step) attachStepNotes(agent, step.parentId, id)
		},
		{ baseRev }
	)
}

/** The inks of one-curve graphs in order: blue, red pencil, forest, charcoal (indices into PLOT_INKS). */
const SINGLE_CURVE_INKS = [2, 1, 3, 0]

export const GraphActionUtil = registerActionUtil(
	class GraphActionUtil extends AgentActionUtil<GraphAction> {
		static override type = 'graph' as const

		override getInfo(action: Streaming<GraphAction>) {
			return { icon: 'pencil' as const, description: action.intent ?? '' }
		}

		override applyAction(action: Streaming<GraphAction>, helpers: AgentHelpers) {
			if (!action.complete) return
			const { editor } = this
			const parameters = sanitizeParameters(action.parameters)
			// Only functions that parse are kept, so the graph never shows a broken plot.
			const labels = Array.isArray(action.labels) ? action.labels : []
			const functions: GraphFunction[] = (action.functions ?? [])
				.map((expression, i) => ({
					expression: String(expression).trim().replace(/^y\s*=\s*/, ''),
					label: String(labels[i] ?? '').trim(),
				}))
				.filter(({ expression }) => {
					try {
						compileExpression(expression)
						return true
					} catch {
						return false
					}
				})
				.map(({ expression, label }) => (label ? { expression, label } : { expression }))
			const axisTitles = {
				xLabel: String(action.xLabel ?? '').trim(),
				yLabel: String(action.yLabel ?? '').trim(),
			}
			const range = (min: number, max: number, fallback: [number, number]) =>
				Number.isFinite(min) && Number.isFinite(max) && max > min ? [min, max] : fallback
			const [xMin, xMax] = range(action.xMin, action.xMax, [-6, 6])
			const [yMin, yMax] = range(action.yMin, action.yMax, [-4, 4])
			const plotW = Math.min(800, Math.max(200, action.width || 360))
			const plotH = Math.min(600, Math.max(120, action.height || 240))
			// Marked points: only whole ones, and only when the action names them, so a
			// redraw that leaves them out keeps the ones already there.
			const points = Array.isArray(action.points)
				? action.points
						.filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
						.slice(0, 6)
						.map((p) => ({ x: Number(p.x), y: Number(p.y), label: String(p.label ?? '').trim() }))
				: autoPoints(functions, parameters, { xMin, xMax, yMin, yMax })
			const props = {
				functions,
				...axisTitles,
				parameters,
				xMin,
				xMax,
				yMin,
				yMax,
				w: plotW,
				h: plotH + parametersHeight(parameters),
				...(points ? { points } : {}),
			}
			const { id, existing } = resolveTarget<GraphShape>(helpers, action.shapeId, GRAPH_TYPE)
			// A graph of one curve takes its own ink, so two graphs of one situation,
			// such as height and velocity, read apart: blue, then red, then green, in
			// the order the graphs land on the board. A redraw keeps the graph's ink.
			if (functions.length === 1) {
				const kept = existing?.props.functions[0]?.ink
				const others = editor.getCurrentPageShapes().filter((s) => s.type === GRAPH_TYPE && s.id !== id && (s as GraphShape).props.functions.length === 1)
				const ink = Number.isInteger(kept) ? kept! : SINGLE_CURVE_INKS[others.length % SINGLE_CURVE_INKS.length]
				functions[0] = { ...functions[0], ink }
			}
			if (existing) {
				editor.updateShape<GraphShape>({ id, type: GRAPH_TYPE, props })
				return
			}
			const at = helpers.removeOffsetFromVec({ x: action.x ?? 0, y: action.y ?? 0 })
			editor.createShape<GraphShape>({ id, type: GRAPH_TYPE, x: at.x, y: at.y, props })
			settleBlock(this.agent, id)
		}
	}
)

/** A number for a point's label: three significant digits, without trailing zeros. */
function short(v: number) {
	if (Math.abs(v) < 1e-9) return '0'
	return String(Number(v.toPrecision(3)))
}

/**
 * The points a teacher would mark on a graph the model sent without any: where
 * a curve turns, where a single curve crosses the x axis, and where two curves
 * meet, each labeled with its coordinates. Only for a graph without sliders,
 * whose points stay put, and only when there are three or fewer, so a wave's
 * many peaks are left alone.
 */
function autoPoints(
	functions: { expression: string }[],
	parameters: ShapeParameter[],
	view: { xMin: number; xMax: number; yMin: number; yMax: number }
) {
	if (parameters.length > 0 || functions.length === 0 || functions.length > 3) return undefined
	const fns = functions.map((f) => compileExpression(f.expression))
	const N = 400
	const xs = Array.from({ length: N + 1 }, (_, i) => view.xMin + ((view.xMax - view.xMin) * i) / N)
	const edge = (view.xMax - view.xMin) * 0.03
	const inside = (x: number, y: number) =>
		x > view.xMin + edge && x < view.xMax - edge && y >= view.yMin && y <= view.yMax && Number.isFinite(y)
	const found: { x: number; y: number }[] = []
	const root = (g: (x: number) => number, a: number, b: number) => {
		for (let k = 0; k < 50; k++) {
			const m = (a + b) / 2
			if (Math.sign(g(m)) === Math.sign(g(a))) a = m
			else b = m
		}
		return (a + b) / 2
	}
	const values = fns.map((f) => xs.map((x) => f({ x })))
	fns.forEach((f, i) => {
		const ys = values[i]
		for (let k = 1; k < N; k++) {
			const d1 = ys[k] - ys[k - 1]
			const d2 = ys[k + 1] - ys[k]
			if (Number.isFinite(d1) && Number.isFinite(d2) && d1 * d2 < 0) {
				const slope = (x: number) => f({ x: x + 1e-6 }) - f({ x: x - 1e-6 })
				const x = root(slope, xs[k - 1], xs[k + 1])
				found.push({ x, y: f({ x }) })
			}
		}
		if (fns.length === 1) {
			for (let k = 0; k < N; k++) {
				if (ys[k] === 0) found.push({ x: xs[k], y: 0 })
				else if (Number.isFinite(ys[k]) && Number.isFinite(ys[k + 1]) && ys[k] * ys[k + 1] < 0) {
					const x = root((t) => f({ x: t }), xs[k], xs[k + 1])
					found.push({ x, y: 0 })
				}
			}
		}
	})
	for (let i = 0; i < fns.length; i++) {
		for (let j = i + 1; j < fns.length; j++) {
			const g = (x: number) => fns[i]({ x }) - fns[j]({ x })
			for (let k = 0; k < N; k++) {
				const a = g(xs[k])
				const b = g(xs[k + 1])
				if (a === 0) found.push({ x: xs[k], y: fns[i]({ x: xs[k] }) })
				else if (Number.isFinite(a) && Number.isFinite(b) && a * b < 0) {
					const x = root(g, xs[k], xs[k + 1])
					found.push({ x, y: fns[i]({ x }) })
				}
			}
		}
	}
	const points = found.filter((p) => inside(p.x, p.y))
	const unique = points.filter((p, i) => !points.slice(0, i).some((q) => Math.abs(q.x - p.x) < edge && Math.abs(q.y - p.y) < (view.yMax - view.yMin) * 0.03))
	if (unique.length === 0 || unique.length > 3) return undefined
	return unique.map((p) => ({ x: Number(p.x.toFixed(4)), y: Number(p.y.toFixed(4)), label: `(${short(p.x)}, ${short(p.y)})` }))
}

export const SimulationActionUtil = registerActionUtil(
	class SimulationActionUtil extends AgentActionUtil<SimulationAction> {
		static override type = 'simulation' as const

		override getInfo(action: Streaming<SimulationAction>) {
			return { icon: 'pencil' as const, description: action.intent ?? '' }
		}

		override applyAction(action: Streaming<SimulationAction>, helpers: AgentHelpers) {
			if (!action.complete) return
			const { editor } = this
			const values: Record<string, number> = {
				speed: action.speed,
				angle: action.angle,
				gravity: action.gravity,
				height: action.height,
			}
			const parameters = PROJECTILE_PARAMETERS.map((p) =>
				Number.isFinite(values[p.name]) ? { ...p, value: clampParameter(p, values[p.name]) } : p
			)
			const { id, existing } = resolveTarget<SimulationShape>(helpers, action.shapeId, SIMULATION_TYPE)
			if (existing) {
				editor.updateShape<SimulationShape>({ id, type: SIMULATION_TYPE, props: { parameters } })
				return
			}
			const at = helpers.removeOffsetFromVec({ x: action.x ?? 0, y: action.y ?? 0 })
			editor.createShape<SimulationShape>({
				id,
				type: SIMULATION_TYPE,
				x: at.x,
				y: at.y,
				props: { kind: 'projectile', parameters },
			})
			settleBlock(this.agent, id)
		}
	}
)

/**
 * Build or update a scene from a scene action. A template is placed through
 * the same path, so it behaves exactly like a scene the agent wrote.
 */
function applySceneAction(editor: Editor, action: Streaming<SceneAction>, helpers: AgentHelpers) {
	// While the action streams, show what has arrived as a preview: the scene
	// appears once its frame is known, and each object as soon as it is
	// finished. The last item of a list may be cut off, so it waits. The
	// preview is taken back before the next one; only the finished action is
	// recorded as a command.
	const streaming = !action.complete
	if (streaming) {
		const framed = [action.xMin, action.xMax, action.yMin, action.yMax].every((v) => typeof v === 'number')
		if (typeof action.shapeId !== 'string' || !action.shapeId || !framed) return
	}
	const finished = <T,>(list: T[] | undefined) => (streaming ? (list ?? []).slice(0, -1) : (list ?? []))
	const { id, existing } = resolveTarget<SceneShape>(helpers, action.shapeId, SCENE_TYPE)
	// Only a new scene previews. A preview of an existing scene is taken back
	// by writing the old record over it, which would undo the user's slider
	// moves made while the agent writes.
	if (streaming && existing) return

	const params = { ...(existing?.props.params ?? {}) }
	for (const p of sanitizeParameters(finished(action.params))) {
		const current = params[p.name]
		// A parameter that already exists keeps its value: it may be the user's.
		params[p.name] = current ? { ...p, value: clampParameter(p, current.value) } : p
	}

	const objects: Record<string, SceneObject> = { ...(existing?.props.objects ?? {}) }
	const dropped: string[] = []
	for (const raw of finished(action.objects)) {
		const objectId = String(raw?.id ?? '').trim()
		if (!objectId) continue
		const idProblem = checkSceneObjectId(objectId, params)
		if (idProblem) {
			dropped.push(`${objectId}: ${idProblem}`)
			continue
		}
		const result = sanitizeSceneObject(raw)
		if ('error' in result) dropped.push(`${objectId}: ${result.error}`)
		else objects[objectId] = result.object
	}
	for (const removed of finished(action.remove)) delete objects[removed]
	if (dropped.length > 0 && !streaming) console.warn(`Scene ${action.shapeId} dropped objects:`, dropped)

	const range = (min: number | undefined, max: number | undefined, fallback: [number, number]) =>
		Number.isFinite(min) && Number.isFinite(max) && max! > min! ? [min!, max!] : fallback
	const [xMin, xMax] = range(action.xMin, action.xMax, existing ? [existing.props.xMin, existing.props.xMax] : [-5, 5])
	const [yMin, yMax] = range(action.yMin, action.yMax, existing ? [existing.props.yMin, existing.props.yMax] : [-4, 4])
	const duration = Number.isFinite(action.duration) && action.duration! > 0 ? Math.min(action.duration!, 120) : 0
	// A new scene takes the size the agent asks for. An existing one keeps its
	// size, so the user's resize stands, and grows only by the rows it gains.
	const chrome = sceneChromeHeight({ duration, params })
	const w = existing ? existing.props.w : Math.min(900, Math.max(200, action.width || 420))
	const h = existing
		? existing.props.h - sceneChromeHeight(existing.props) + chrome
		: Math.min(700, Math.max(120, action.height || 300)) + chrome
	const props = {
		title: String(action.title ?? existing?.props.title ?? ''),
		xMin,
		xMax,
		yMin,
		yMax,
		duration,
		axes: typeof action.axes === 'boolean' ? action.axes : (existing?.props.axes ?? true),
		// A pin is set only by the action that asks for it; any other update clears it.
		...(Number.isFinite(action.pinTime)
			? {
					pinnedTime: Math.min(Math.max(0, action.pinTime!), duration),
					pinCount: (existing?.props.pinCount ?? 0) + 1,
				}
			: { pinnedTime: undefined }),
		params,
		objects,
		w,
		h,
	}
	// A preview is shown read-only: edits to it would be lost when it is replaced.
	const meta = { sceneDropped: streaming ? [] : dropped, ...(streaming ? { scenePreview: true } : {}) }
	if (existing) {
		editor.updateShape<SceneShape>({ id, type: SCENE_TYPE, props, meta: { ...existing.meta, ...meta } })
		return
	}
	const at = helpers.removeOffsetFromVec({ x: action.x ?? 0, y: action.y ?? 0 })
	editor.createShape<SceneShape>({ id, type: SCENE_TYPE, x: at.x, y: at.y, props, meta })
	// The preview and the finished scene settle the same way, so the scene does not jump.
	settleBlock(helpers.agent, id)
	// A scene squeezed into a full frame gets readable room, in the frame or beside it.
	fitInFrame(helpers.agent, id, chrome)
}

/**
 * The agent builds or changes a scene. On an existing scene, objects with the
 * same id are replaced, new ones are added, and ids in `remove` are deleted.
 * Parameters keep the value the user set; the agent changes a value with
 * set_parameter. Only the fields that change are written, so the edit does not
 * conflict with the user's slider or point moves elsewhere in the scene.
 */
export const SceneActionUtil = registerActionUtil(
	class SceneActionUtil extends AgentActionUtil<SceneAction> {
		static override type = 'scene' as const

		override getInfo(action: Streaming<SceneAction>) {
			return { icon: 'pencil' as const, description: action.intent ?? '' }
		}

		override applyAction(action: Streaming<SceneAction>, helpers: AgentHelpers) {
			applySceneAction(this.editor, action, helpers)
		}
	}
)

/**
 * The agent places a ready-made scene, with its own starting values for any of
 * the template's parameters. It goes through the same path as a scene action.
 */
export const SceneTemplateActionUtil = registerActionUtil(
	class SceneTemplateActionUtil extends AgentActionUtil<SceneTemplateAction> {
		static override type = 'scene_template' as const

		override getInfo(action: Streaming<SceneTemplateAction>) {
			return { icon: 'pencil' as const, description: action.intent ?? '' }
		}

		override applyAction(action: Streaming<SceneTemplateAction>, helpers: AgentHelpers) {
			if (!action.complete) return
			const name = String(action.template ?? '').trim()
			const template = getAllTemplates(this.editor).find((t) => t.id === name)
			if (!template) {
				// Tell the agent, so it picks a listed template or writes the scene.
				this.agent.schedule(
					`There is no scene template named "${name}". Place one of the templates listed in the prompt, or write the scene with a scene action.`
				)
				return
			}
			// A template always becomes a new scene: it never merges into an existing
			// one, which would keep that scene's values over the ones asked for here.
			const shapeId = helpers.ensureShapeIdIsUnique(
				String(action.shapeId || template.id) as Parameters<AgentHelpers['ensureShapeIdIsUnique']>[0]
			)
			const values = new Map((action.params ?? []).map((p) => [p.name, p.value]))
			applySceneAction(
				this.editor,
				{
					_type: 'scene',
					intent: action.intent,
					shapeId,
					title: template.title,
					x: action.x,
					y: action.y,
					width: template.width,
					height: template.height,
					xMin: template.xMin,
					xMax: template.xMax,
					yMin: template.yMin,
					yMax: template.yMax,
					duration: template.duration,
					axes: template.axes,
					params: template.params.map((p) => {
						const value = values.get(p.name)
						return Number.isFinite(value) ? { ...p, value: value! } : p
					}),
					objects: template.objects as SceneAction['objects'],
					complete: true,
					time: action.time,
				},
				helpers
			)
		}
	}
)

/**
 * The agent adds or replaces one object of an existing scene. Each one is its
 * own command and lands as soon as it is written, so a scene builds up object
 * by object, and a problem can be fixed by sending only the object it names.
 */
export const SceneObjectActionUtil = registerActionUtil(
	class SceneObjectActionUtil extends AgentActionUtil<SceneObjectAction> {
		static override type = 'scene_object' as const

		override getInfo(action: Streaming<SceneObjectAction>) {
			return { icon: 'pencil' as const, description: action.intent ?? '' }
		}

		override sanitizeAction(action: Streaming<SceneObjectAction>, helpers: AgentHelpers) {
			if (!action.complete) return action
			const id = helpers.ensureShapeIdExists(action.shapeId)
			return id ? { ...action, shapeId: id } : null
		}

		override applyAction(action: Streaming<SceneObjectAction>) {
			if (!action.complete) return
			const { editor } = this
			const shape = editor.getShape<SceneShape>(`shape:${action.shapeId}` as TLShapeId)
			if (!shape || shape.type !== SCENE_TYPE) return
			const objectId = String(action.object?.id ?? '').trim()
			if (!objectId) return
			const previous = ((shape.meta.sceneDropped as string[] | undefined) ?? []).filter((d) => !d.startsWith(`${objectId}:`))
			const idProblem = checkSceneObjectId(objectId, shape.props.params)
			const result = idProblem ? { error: idProblem } : sanitizeSceneObject(action.object)
			if ('error' in result) {
				editor.updateShape<SceneShape>({
					id: shape.id,
					type: SCENE_TYPE,
					meta: { ...shape.meta, sceneDropped: [...previous, `${objectId}: ${result.error}`] },
				})
				return
			}
			// Write only this object, so the edit does not touch the user's sliders.
			editor.updateShape<SceneShape>({
				id: shape.id,
				type: SCENE_TYPE,
				props: { objects: { ...shape.props.objects, [objectId]: result.object } },
				meta: { ...shape.meta, sceneDropped: previous },
			})
		}
	}
)

export const SetParameterActionUtil = registerActionUtil(
	class SetParameterActionUtil extends AgentActionUtil<SetParameterAction> {
		static override type = 'set_parameter' as const

		override getInfo(action: Streaming<SetParameterAction>) {
			return { icon: 'pencil' as const, description: action.intent ?? '' }
		}

		override sanitizeAction(action: Streaming<SetParameterAction>, helpers: AgentHelpers) {
			if (!action.complete) return action
			const id = helpers.ensureShapeIdExists(action.shapeId)
			if (!id) return null
			return { ...action, shapeId: id }
		}

		override applyAction(action: Streaming<SetParameterAction>) {
			if (!action.complete) return
			const { editor } = this
			const shape = editor.getShape(`shape:${action.shapeId}` as TLShapeId) as
				| GraphShape
				| SimulationShape
				| SceneShape
				| WidgetShape
				| undefined
			if (!shape) return
			if (shape.type === WIDGET_TYPE) {
				const widget = shape as unknown as WidgetShape
				if (!Object.hasOwn(widget.props.params, action.name) || !Number.isFinite(action.value)) return
				const p = widget.props.params[action.name]
				editor.updateShape<WidgetShape>({
					id: widget.id,
					type: WIDGET_TYPE,
					props: { params: { ...widget.props.params, [action.name]: { ...p, value: clampParameter(p, action.value) } } },
				})
				return
			}
			if (shape.type === SCENE_TYPE) {
				// Only this parameter's value changes, so the edit touches one field.
				if (!Object.hasOwn(shape.props.params, action.name) || !Number.isFinite(action.value)) return
				const p = shape.props.params[action.name]
				editor.updateShape<SceneShape>({
					id: shape.id,
					type: SCENE_TYPE,
					props: { params: { ...shape.props.params, [action.name]: { ...p, value: clampParameter(p, action.value) } } },
				})
				return
			}
			if (shape.type !== GRAPH_TYPE && shape.type !== SIMULATION_TYPE) return
			const parameters = shape.props.parameters.map((p) =>
				p.name === action.name && Number.isFinite(action.value) ? { ...p, value: clampParameter(p, action.value) } : p
			)
			editor.updateShape({ id: shape.id, type: shape.type, props: { parameters } } as never)
		}
	}
)

/**
 * The agent starts a widget: a placeholder lands now, as this action's command,
 * and the code is written in a background job that fills it in later. Sending
 * the action again for the same widget updates its brief and size and starts a
 * new job; parameters keep the values the user set.
 */
export const WidgetActionUtil = registerActionUtil(
	class WidgetActionUtil extends AgentActionUtil<WidgetAction> {
		static override type = 'widget' as const

		override getInfo(action: Streaming<WidgetAction>) {
			return { icon: 'pencil' as const, description: action.intent ?? '' }
		}

		override applyAction(action: Streaming<WidgetAction>, helpers: AgentHelpers) {
			if (!action.complete) return
			const { editor } = this
			const { id, existing } = resolveTarget<WidgetShape>(helpers, action.shapeId, WIDGET_TYPE)
			const params: Record<string, ShapeParameter> = {}
			for (const p of sanitizeParameters(action.params)) {
				const current = existing?.props.params[p.name]
				params[p.name] = current ? { ...p, value: clampParameter(p, current.value) } : p
			}
			const state: Record<string, unknown> = {}
			for (const entry of action.state ?? []) {
				const key = String(entry?.key ?? '').trim().slice(0, 64)
				if (!key) continue
				state[key] = existing && Object.hasOwn(existing.props.state, key) ? existing.props.state[key] : (entry.value ?? null)
			}
			const chrome = widgetChromeHeight({ params })
			const w = existing ? existing.props.w : Math.min(900, Math.max(200, action.width || 420))
			const h = existing
				? existing.props.h - widgetChromeHeight(existing.props) + chrome
				: Math.min(800, Math.max(120, action.height || 320)) + chrome
			const props = {
				title: String(action.title ?? ''),
				brief: String(action.brief ?? ''),
				status: 'writing' as const,
				error: '',
				params,
				state,
				w,
				h,
			}
			if (existing) {
				editor.updateShape<WidgetShape>({ id, type: WIDGET_TYPE, props })
			} else {
				const at = helpers.removeOffsetFromVec({ x: action.x ?? 0, y: action.y ?? 0 })
				editor.createShape<WidgetShape>({ id, type: WIDGET_TYPE, x: at.x, y: at.y, props })
				settleBlock(this.agent, id)
			}
			// The job starts once this command is recorded, so its base revision
			// follows it, and only if the command was applied: a rejected command
			// was rolled back, so the widget does not show this brief as writing.
			const agent = this.agent
			const context = { ...agent.getPassIds(), allowedShapeIds: agent.getAllowedShapeIds() }
			const brief = props.brief
			setTimeout(() => {
				const placed = editor.getShape<WidgetShape>(id)
				if (!placed || placed.props.status !== 'writing' || placed.props.brief !== brief) return
				void runWidgetJob(agent, id, context)
			}, 0)
		}
	}
)

/**
 * The agent starts an animation: a placeholder lands now, as this action's
 * command, and a background job writes and renders the video, which lands
 * later as one more agent command. Sending the action again for the same
 * animation updates its brief and starts a new job.
 */
export const RenderAnimationActionUtil = registerActionUtil(
	class RenderAnimationActionUtil extends AgentActionUtil<RenderAnimationAction> {
		static override type = 'render_animation' as const

		override getInfo(action: Streaming<RenderAnimationAction>) {
			return { icon: 'pencil' as const, description: action.intent ?? '' }
		}

		override applyAction(action: Streaming<RenderAnimationAction>, helpers: AgentHelpers) {
			if (!action.complete) return
			const { editor } = this
			const { id, existing } = resolveTarget<VideoShape>(helpers, action.shapeId, VIDEO_TYPE)
			const w = existing ? existing.props.w : Math.min(1200, Math.max(320, Number.isFinite(action.width) ? action.width! : 640))
			const props = {
				title: String(action.title ?? ''),
				brief: String(action.brief ?? ''),
				status: 'rendering' as const,
				error: '',
				w,
				h: videoHeightForWidth(w),
			}
			// The placeholder stays out of undo history. The finished animation lands
			// as one undo step from the board before the request, so Undo takes the
			// whole animation away (or brings back the video it replaced) at once,
			// never a placeholder whose job is gone.
			const before = existing ?? null
			editor.run(
				() => {
					if (existing) {
						editor.updateShape<VideoShape>({ id, type: VIDEO_TYPE, props })
					} else {
						const at = helpers.removeOffsetFromVec({ x: action.x ?? 0, y: action.y ?? 0 })
						editor.createShape<VideoShape>({ id, type: VIDEO_TYPE, x: at.x, y: at.y, props })
						settleBlock(this.agent, id)
					}
				},
				{ history: 'ignore' }
			)
			// The job starts once this command is recorded, so its base revision
			// follows it, and only if the command was applied.
			const agent = this.agent
			const context = { ...agent.getPassIds(), allowedShapeIds: agent.getAllowedShapeIds(), before }
			const brief = props.brief
			setTimeout(() => {
				const placed = editor.getShape<VideoShape>(id)
				if (!placed || placed.props.status !== 'rendering' || placed.props.brief !== brief) return
				void runVideoJob(agent, id, context)
			}, 0)
		}
	}
)
