import { TLShape, TLShapeId } from 'tldraw'
import { registerShapeDescriber } from '../../shared/format/convertTldrawShapeToFocusedShape'
import {
	EquationAction,
	GraphAction,
	SetParameterAction,
	SimulationAction,
} from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { AgentHelpers } from '../AgentHelpers'
import { compileExpression } from '../shapes/math/expression'
import { clampParameter, ShapeParameter } from '../shapes/math/parameters'
import { EQUATION_TYPE, EquationShape, measureEquation } from '../shapes/EquationShapeUtil'
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
	const existing = editor.getShape(`shape:${simple}` as TLShapeId)
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
			const shape = editor.getShape(`shape:${action.shapeId}` as TLShapeId) as GraphShape | SimulationShape | undefined
			if (!shape || (shape.type !== GRAPH_TYPE && shape.type !== SIMULATION_TYPE)) return
			const parameters = shape.props.parameters.map((p) =>
				p.name === action.name && Number.isFinite(action.value) ? { ...p, value: clampParameter(p, action.value) } : p
			)
			editor.updateShape({ id: shape.id, type: shape.type, props: { parameters } } as never)
		}
	}
)
