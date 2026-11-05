import { TLShape, TLShapeId } from 'tldraw'
import { registerShapeDescriber } from '../../shared/format/convertTldrawShapeToFocusedShape'
import {
	EquationAction,
	GraphAction,
	SceneAction,
	SetParameterAction,
	SimulationAction,
} from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { AgentHelpers } from '../AgentHelpers'
import { compileExpression } from '../shapes/math/expression'
import { clampParameter, ShapeParameter } from '../shapes/math/parameters'
import { EQUATION_TYPE, EquationShape, measureEquation } from '../shapes/EquationShapeUtil'
import { SCENE_TYPE, sceneChromeHeight, SceneShape } from '../shapes/SceneShapeUtil'
import { describeScene, SceneObject, sanitizeSceneObject } from '../shapes/scene/sceneModel'
import { describeGraph, GRAPH_TYPE, GraphShape, parametersHeight } from '../shapes/GraphShapeUtil'
import {
	describeSimulation,
	PROJECTILE_PARAMETERS,
	SIMULATION_TYPE,
	SimulationShape,
} from '../shapes/SimulationShapeUtil'
import { AgentActionUtil, registerActionUtil } from './AgentActionUtil'

// The agent reads these shapes as a line each: the equation's LaTeX, and a
// graph's or a simulation's current parameter values, so it sees the user's changes.
registerShapeDescriber(EQUATION_TYPE, (shape) => `Equation: ${(shape as EquationShape).props.latex}`)
registerShapeDescriber(GRAPH_TYPE, (shape) => describeGraph((shape as GraphShape).props))
registerShapeDescriber(SIMULATION_TYPE, (shape) => describeSimulation((shape as SimulationShape).props))
registerShapeDescriber(SCENE_TYPE, (shape) => describeScene((shape as SceneShape).props))

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
		const parameter = { name, min, max, step, value: Number.isFinite(p.value) ? p.value! : min }
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
			editor.createShape<EquationShape>({ id, type: EQUATION_TYPE, x: at.x, y: at.y, props })
		}
	}
)

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
			const functions = (action.functions ?? [])
				.map((expression) => String(expression).trim().replace(/^y\s*=\s*/, ''))
				.filter((expression) => {
					try {
						compileExpression(expression)
						return true
					} catch {
						return false
					}
				})
				.map((expression) => ({ expression }))
			const range = (min: number, max: number, fallback: [number, number]) =>
				Number.isFinite(min) && Number.isFinite(max) && max > min ? [min, max] : fallback
			const [xMin, xMax] = range(action.xMin, action.xMax, [-6, 6])
			const [yMin, yMax] = range(action.yMin, action.yMax, [-4, 4])
			const plotW = Math.min(800, Math.max(200, action.width || 360))
			const plotH = Math.min(600, Math.max(120, action.height || 240))
			const props = { functions, parameters, xMin, xMax, yMin, yMax, w: plotW, h: plotH + parametersHeight(parameters) }
			const { id, existing } = resolveTarget<GraphShape>(helpers, action.shapeId, GRAPH_TYPE)
			if (existing) {
				editor.updateShape<GraphShape>({ id, type: GRAPH_TYPE, props })
				return
			}
			const at = helpers.removeOffsetFromVec({ x: action.x ?? 0, y: action.y ?? 0 })
			editor.createShape<GraphShape>({ id, type: GRAPH_TYPE, x: at.x, y: at.y, props })
		}
	}
)

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
		}
	}
)

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
			if (!action.complete) return
			const { editor } = this
			const { id, existing } = resolveTarget<SceneShape>(helpers, action.shapeId, SCENE_TYPE)

			const params = { ...(existing?.props.params ?? {}) }
			for (const p of sanitizeParameters(action.params)) {
				const current = params[p.name]
				// A parameter that already exists keeps its value: it may be the user's.
				params[p.name] = current ? { ...p, value: clampParameter(p, current.value) } : p
			}

			const objects: Record<string, SceneObject> = { ...(existing?.props.objects ?? {}) }
			const dropped: string[] = []
			for (const raw of action.objects ?? []) {
				const objectId = String(raw?.id ?? '').trim()
				if (!objectId) continue
				const result = sanitizeSceneObject(raw)
				if ('error' in result) dropped.push(`${objectId}: ${result.error}`)
				else objects[objectId] = result.object
			}
			for (const removed of action.remove ?? []) delete objects[removed]
			if (dropped.length > 0) console.warn(`Scene ${action.shapeId} dropped objects:`, dropped)

			const range = (min: number, max: number, fallback: [number, number]) =>
				Number.isFinite(min) && Number.isFinite(max) && max > min ? [min, max] : fallback
			const [xMin, xMax] = range(action.xMin, action.xMax, existing ? [existing.props.xMin, existing.props.xMax] : [-5, 5])
			const [yMin, yMax] = range(action.yMin, action.yMax, existing ? [existing.props.yMin, existing.props.yMax] : [-4, 4])
			const duration = Number.isFinite(action.duration) && action.duration > 0 ? Math.min(action.duration, 120) : 0
			const plotW = Math.min(900, Math.max(200, action.width || existing?.props.w || 420))
			const plotH = Math.min(700, Math.max(120, action.height || 300))
			const props = {
				title: String(action.title ?? existing?.props.title ?? ''),
				xMin,
				xMax,
				yMin,
				yMax,
				duration,
				axes: typeof action.axes === 'boolean' ? action.axes : (existing?.props.axes ?? true),
				params,
				objects,
				w: plotW,
				h: plotH + sceneChromeHeight({ duration, params }),
			}
			if (existing) {
				editor.updateShape<SceneShape>({ id, type: SCENE_TYPE, props })
				return
			}
			const at = helpers.removeOffsetFromVec({ x: action.x ?? 0, y: action.y ?? 0 })
			editor.createShape<SceneShape>({ id, type: SCENE_TYPE, x: at.x, y: at.y, props })
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
				| undefined
			if (!shape) return
			if (shape.type === SCENE_TYPE) {
				// Only this parameter's value changes, so the edit touches one field.
				const p = shape.props.params[action.name]
				if (!p || !Number.isFinite(action.value)) return
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
