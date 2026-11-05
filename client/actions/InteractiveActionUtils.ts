import { TLShape, TLShapeId } from 'tldraw'
import { registerShapeDescriber } from '../../shared/format/convertTldrawShapeToFocusedShape'
import {
	EquationAction,
	GraphAction,
	SceneAction,
	SceneObjectAction,
	SetParameterAction,
	SimulationAction,
} from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { AgentHelpers } from '../AgentHelpers'
import { compileExpression } from '../shapes/math/expression'
import { clampParameter, ShapeParameter } from '../shapes/math/parameters'
import { EQUATION_TYPE, EquationShape, measureEquation } from '../shapes/EquationShapeUtil'
import { describeSceneShape, SCENE_TYPE, sceneChromeHeight, SceneShape } from '../shapes/SceneShapeUtil'
import { checkSceneObjectId, SceneObject, sanitizeSceneObject } from '../shapes/scene/sceneModel'
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
registerShapeDescriber(SCENE_TYPE, (shape) => describeSceneShape(shape as SceneShape))

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
			const { editor } = this
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
