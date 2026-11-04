import { T, TLShape, useEditor } from 'tldraw'

/** A named number on a graph or a simulation, which the user and the agent can both change. */
export interface ShapeParameter {
	name: string
	value: number
	min: number
	max: number
	step: number
}

export const shapeParameterValidator = T.object({
	name: T.string,
	value: T.number,
	min: T.number,
	max: T.number,
	step: T.number,
})

/** The parameters as a scope for expressions: { a: 2, b: 0.5 }. */
export function parameterScope(parameters: ShapeParameter[]): Record<string, number> {
	return Object.fromEntries(parameters.map((p) => [p.name, p.value]))
}

/** A short line the agent reads: "a = 2 (0 to 5), b = 0.5 (0 to 1)". */
export function describeParameters(parameters: ShapeParameter[]): string {
	return parameters.map((p) => `${p.name} = ${round(p.value)} (${round(p.min)} to ${round(p.max)})`).join(', ')
}

/** Keep a value inside its range and on its step. */
export function clampParameter(parameter: ShapeParameter, value: number): number {
	const clamped = Math.min(parameter.max, Math.max(parameter.min, value))
	if (!(parameter.step > 0)) return clamped
	const stepped = parameter.min + Math.round((clamped - parameter.min) / parameter.step) * parameter.step
	return round(Math.min(parameter.max, stepped))
}

function round(value: number) {
	return Math.round(value * 1000) / 1000
}

/**
 * Sliders for a shape's parameters, drawn on the shape. A change is an ordinary
 * edit of the shape, so it is recorded as the user's, with its own undo step
 * for each drag.
 */
export function ParameterSliders<S extends TLShape & { props: { parameters: ShapeParameter[] } }>({
	shape,
}: {
	shape: S
}) {
	const editor = useEditor()
	const { parameters } = shape.props
	if (parameters.length === 0) return null
	const set = (name: string, value: number) => {
		const next = parameters.map((p) => (p.name === name ? { ...p, value: clampParameter(p, value) } : p))
		editor.updateShape({ id: shape.id, type: shape.type, props: { parameters: next } } as never)
	}
	return (
		<div
			className="shape-parameters"
			onPointerDown={(e) => {
				e.stopPropagation()
				editor.markHistoryStoppingPoint('parameter')
			}}
			onWheel={(e) => e.stopPropagation()}
		>
			{parameters.map((p) => (
				<label key={p.name} className="shape-parameter">
					<span className="shape-parameter-name">{p.name}</span>
					<input
						type="range"
						min={p.min}
						max={p.max}
						step={p.step > 0 ? p.step : 'any'}
						value={p.value}
						onChange={(e) => set(p.name, Number(e.currentTarget.value))}
						aria-label={p.name}
					/>
					<span className="shape-parameter-value">{round(p.value)}</span>
				</label>
			))}
		</div>
	)
}
