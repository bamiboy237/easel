import { useEffect, useState } from 'react'
import type React from 'react'
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
	// "th" is the usual short name for an angle θ.
	const base = GREEK[m[1]] ?? (m[1] === 'th' ? 'θ' : m[1])
	return base + (m[2] ? SUBSCRIPT[Number(m[2])] : '')
}

export interface ShapeParameter {
	name: string
	value: number
	min: number
	max: number
	step: number
	/** The unit the value is in, as printed after it, such as "m/s", "N", or "°". Optional. */
	unit?: string
}

export const shapeParameterValidator = T.object({
	name: T.string,
	value: T.number,
	min: T.number,
	max: T.number,
	step: T.number,
	unit: T.string.optional(),
})

/** A value with its unit, as the board prints it: "45°", "9 m/s", "2". */
export function withUnit(value: number | string, unit?: string): string {
	if (!unit) return String(value)
	return unit === '°' || unit === '%' ? `${value}${unit}` : `${value} ${unit}`
}

/** The parameters as a scope for expressions: { a: 2, b: 0.5 }. */
export function parameterScope(parameters: ShapeParameter[]): Record<string, number> {
	return Object.fromEntries(parameters.map((p) => [p.name, p.value]))
}

/** A short line the agent reads: "a = 2 (0 to 5), b = 0.5 (0 to 1)". */
export function describeParameters(parameters: ShapeParameter[]): string {
	return parameters
		.map((p) => `${p.name} = ${withUnit(round(p.value), p.unit)} (${withUnit(round(p.min), p.unit)} to ${withUnit(round(p.max), p.unit)})`)
		.join(', ')
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
						className="paper-range"
						type="range"
						min={p.min}
						max={p.max}
						step={p.step > 0 ? p.step : 'any'}
						value={p.value}
						onChange={(e) => onSet(p.name, Number(e.currentTarget.value))}
						aria-label={p.name}
						style={rangeFill(p.value, p.min, p.max)}
					/>
					<ParameterValue parameter={p} onSet={(value) => onSet(p.name, value)} />
				</label>
			))}
		</div>
	)
}

/**
 * A slider's value, in ink. A click turns it into a field: Enter or leaving
 * sets the typed number, clamped to the range and step; Escape keeps the old
 * value.
 */
function ParameterValue({ parameter, onSet }: { parameter: ShapeParameter; onSet: (value: number) => void }) {
	const [draft, setDraft] = useState<string | null>(null)
	// After a typed value was out of range, the range shows for a moment, so the
	// change to the nearest allowed value is never silent.
	const [clamped, setClamped] = useState<{ typed: string; at: number } | null>(null)
	useEffect(() => {
		if (!clamped) return
		const timer = setTimeout(() => setClamped(null), RANGE_NOTE_MS)
		return () => clearTimeout(timer)
	}, [clamped])
	const range = `${withUnit(round(parameter.min), parameter.unit)} to ${withUnit(round(parameter.max), parameter.unit)}`
	if (draft === null) {
		return (
			<span className="shape-parameter-value-wrap">
				{clamped && (
					<span className="shape-parameter-range shape-parameter-range--note" role="status">
						{clamped.typed} is outside {range}, so it is {withUnit(round(parameter.value), parameter.unit)}
					</span>
				)}
				<button
					type="button"
					className="shape-parameter-value"
					title={`Type a value, ${range}`}
					onPointerDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.preventDefault()
						setDraft(String(round(parameter.value)))
					}}
				>
					{withUnit(round(parameter.value), parameter.unit)}
				</button>
			</span>
		)
	}
	const commit = () => {
		const value = Number(draft.replace(',', '.').replace('\u2212', '-'))
		if (draft.trim() !== '' && Number.isFinite(value)) {
			if (value < parameter.min || value > parameter.max) setClamped({ typed: draft.trim(), at: Date.now() })
			onSet(value)
		}
		setDraft(null)
	}
	return (
		<span className="shape-parameter-value-wrap">
			<span className="shape-parameter-range">{range}</span>
			<input
				className="shape-parameter-value"
				inputMode="decimal"
				aria-label={`${parameter.name} value, ${range}`}
				autoFocus
				value={draft}
				onFocus={(e) => e.currentTarget.select()}
				onPointerDown={(e) => e.stopPropagation()}
				onChange={(e) => setDraft(e.currentTarget.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					e.stopPropagation()
					if (e.key === 'Enter') commit()
					if (e.key === 'Escape') setDraft(null)
				}}
			/>
		</span>
	)
}

/** How long the allowed range shows after a typed value was brought into it. */
const RANGE_NOTE_MS = 4000

/** How far along its track a slider is, for the ink fill of a `.paper-range`. */
export function rangeFill(value: number, min: number, max: number): React.CSSProperties {
	const t = max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0
	return { ['--fill' as string]: `${(t * 100).toFixed(2)}%` }
}
