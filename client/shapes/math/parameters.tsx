import { T, TLShape, useEditor } from 'tldraw'

/** A named number on a graph or a simulation, which the user and the agent can both change. */
const GREEK: Record<string, string> = {
	alpha: 'α',
	beta: 'β',
	gamma: 'γ',
	delta: 'δ',
	theta: 'θ',
	lambda: 'λ',
	mu: 'μ',
	omega: 'ω',
	phi: 'φ',
	rho: 'ρ',
	sigma: 'σ',
	tau: 'τ',
}
const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉'

/**
 * A parameter's name as a textbook prints it: "mu" as μ, "theta" as θ, and a
 * trailing digit as a subscript, so "v0" reads v₀. The name itself, which the
 * formulas use, does not change.
 */
export function displayName(name: string) {
	const m = /^([a-zA-Z]+)(\d?)$/.exec(name)
	if (!m) return name
	const base = GREEK[m[1]] ?? m[1]
	return base + (m[2] ? SUBSCRIPT[Number(m[2])] : '')
}

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
	// Twelve significant digits drop float noise (0.30000000000000004) but keep
	// small values, so a range of 0.0001 to 0.001 is not rounded to zero.
	return Number(Math.min(parameter.max, stepped).toPrecision(12))
}

/** A value for reading: four significant digits, so small values stay readable. */
function round(value: number) {
	return Number(value.toPrecision(4))
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
	const set = (name: string, value: number) => {
		const next = parameters.map((p) => (p.name === name ? { ...p, value: clampParameter(p, value) } : p))
		editor.updateShape({ id: shape.id, type: shape.type, props: { parameters: next } } as never)
	}
	return <SliderRows parameters={parameters} onSet={set} />
}

/** The slider rows themselves, for any shape that stores its parameters its own way. */
export function SliderRows({
	parameters,
	onSet,
}: {
	parameters: ShapeParameter[]
	onSet: (name: string, value: number) => void
}) {
	const editor = useEditor()
	if (parameters.length === 0) return null
	return (
		<div
			className="shape-parameters"
			onPointerDown={(e) => {
				e.stopPropagation()
				editor.markHistoryStoppingPoint('parameter')
			}}
			// Keyboard changes start their own undo step too, from when a slider takes focus.
			onFocus={() => editor.markHistoryStoppingPoint('parameter')}
			onWheel={(e) => e.stopPropagation()}
		>
			{parameters.map((p) => (
				<label key={p.name} className="shape-parameter">
					<span className="shape-parameter-name" title={p.name}>
						{displayName(p.name)}
					</span>
					<input
						type="range"
						min={p.min}
						max={p.max}
						step={p.step > 0 ? p.step : 'any'}
						value={p.value}
						onChange={(e) => onSet(p.name, Number(e.currentTarget.value))}
						aria-label={p.name}
					/>
					<span className="shape-parameter-value">{round(p.value)}</span>
				</label>
			))}
		</div>
	)
}
