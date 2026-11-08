import { Coordinates, Line, Mafs, Plot, Point } from 'mafs'
import { isRestoringRecords } from '../agent/restoring'
import 'mafs/core.css'
import { useMemo } from 'react'
import { Geometry2d, HTMLContainer, Rectangle2d, RecordProps, ShapeUtil, T, TLShape } from 'tldraw'
import { compileExpression, CompiledExpression } from './math/expression'
import { describeParameters, ParameterSliders, parameterScope, ShapeParameter, shapeParameterValidator } from './math/parameters'

export const GRAPH_TYPE = 'graph'

export interface GraphFunction {
	/** y as an expression of x and the parameters, such as `a*sin(b*x)`. */
	expression: string
	/** A short name written at the curve's end, such as "demand" or "y = eˣ". */
	label?: string
	/** Which of PLOT_INKS the curve takes; by default the next ink in order. */
	ink?: number
}

/** A key point the graph marks: a dot, dashed guides to both axes, and a short label. */
export interface GraphPoint {
	x: number
	y: number
	label?: string
}

export interface GraphShapeProps {
	w: number
	h: number
	functions: GraphFunction[]
	/** What each axis measures, with its unit, such as "t (s)". */
	xLabel?: string
	yLabel?: string
	parameters: ShapeParameter[]
	xMin: number
	xMax: number
	yMin: number
	yMax: number
	/** Key points to mark, such as a maximum or where two curves meet. */
	points?: GraphPoint[]
}

declare module 'tldraw' {
	export interface TLGlobalShapePropsMap {
		[GRAPH_TYPE]: GraphShapeProps
	}
}

export type GraphShape = TLShape<typeof GRAPH_TYPE>

/** Each plotted function takes the next ink: charcoal, red pencil, blue, forest. */
export const PLOT_INKS = ['#302F2A', '#AE3B2C', '#2F5D8C', '#344C41']

/** The ink of a graph's curve. */
export function curveInk(functions: GraphFunction[], i: number) {
	const ink = functions[i]?.ink
	return PLOT_INKS[(Number.isInteger(ink) ? ink! : i) % PLOT_INKS.length]
}

/** Each slider row, and the space around the rows. */
export const PARAMETER_ROW = 28
export const PARAMETER_PAD = 10

/** How much of a shape's height its sliders take. */
export function parametersHeight(parameters: ShapeParameter[]): number {
	return parameters.length > 0 ? parameters.length * PARAMETER_ROW + PARAMETER_PAD * 2 : 0
}

/** A line the agent reads about a graph: what it plots, over what range, with what values. */
export function describeGraph(props: GraphShapeProps): string {
	// The ink by the board's color name, so the agent can color the matching equation the same.
	const inkNames = ['black', 'red', 'blue', 'green']
	const fns = props.functions.map((f, i) => `y = ${f.expression}${f.label ? ` ("${f.label}")` : ''}, drawn in ${inkNames[(f.ink ?? i) % inkNames.length]}`).join('; ')
	const params = describeParameters(props.parameters)
	const marks = (props.points ?? []).map((p) => `(${p.x}, ${p.y})${p.label ? ` "${p.label}"` : ''}`).join('; ')
	const axes = props.xLabel || props.yLabel ? ` Axes: x is ${props.xLabel || 'unlabeled'}, y is ${props.yLabel || 'unlabeled'}.` : ''
	return `Graph of ${fns || 'nothing yet'}, x from ${props.xMin} to ${props.xMax}, y from ${props.yMin} to ${props.yMax}.${axes}${params ? ` Parameters: ${params}.` : ''}${marks ? ` Marked points: ${marks}.` : ''}`
}

/** A round number near a value, for a suggested axis end. */
function niceEnd(value: number, up: boolean) {
	if (value === 0) return 0
	const power = Math.pow(10, Math.floor(Math.log10(Math.abs(value))) - 1)
	return (up ? Math.ceil(value / power) : Math.floor(value / power)) * power
}

/**
 * Problems a reader would see in a graph's ranges: curves squeezed into a
 * small band of a much taller y range, even with every slider at either end.
 * Each problem names the range that would fit, so the agent can set it.
 */
export function checkGraph(props: GraphShapeProps): { key: string; text: string }[] {
	const { xMin, xMax, yMin, yMax, parameters } = props
	if (!(xMax > xMin) || !(yMax > yMin)) return []
	const fns = props.functions.map((f) => {
		try {
			return compileExpression(f.expression)
		} catch {
			return null
		}
	})
	if (!fns.some(Boolean)) return []
	// The curves as they are, and with each slider at its ends: the range must hold them all.
	const base = parameterScope(parameters)
	const scopes = [base, ...parameters.flatMap((p) => [{ ...base, [p.name]: p.min }, { ...base, [p.name]: p.max }])]
	let lo = Infinity
	let hi = -Infinity
	for (const scope of scopes) {
		for (const fn of fns) {
			if (!fn) continue
			for (let i = 0; i <= 120; i++) {
				const x = xMin + ((xMax - xMin) * i) / 120
				const y = fn({ ...scope, x })
				if (!Number.isFinite(y)) continue
				lo = Math.min(lo, y)
				hi = Math.max(hi, y)
			}
		}
	}
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) return []
	// Marked points must stay in view too.
	for (const p of props.points ?? []) {
		lo = Math.min(lo, p.y)
		hi = Math.max(hi, p.y)
	}
	const span = Math.max(hi - lo, 1e-9)
	const share = span / (yMax - yMin)
	if (share >= 0.45 || lo < yMin || hi > yMax) return []
	const margin = span * 0.15
	const fitMin = yMin <= 0 && lo >= 0 ? Math.min(0, niceEnd(lo - margin, false)) : niceEnd(lo - margin, false)
	const fitMax = niceEnd(hi + margin, true)
	return [
		{
			key: 'graph:y-range',
			text: `its curves fill only ${Math.round(share * 100)} percent of the y range ${yMin} to ${yMax}, even with every slider at its ends, so the curves look flat and the space is empty: set yMin ${fitMin} and yMax ${fitMax}`,
		},
	]
}

/**
 * The space between grid lines for a range drawn across so many pixels: a
 * round 1, 2, or 5 times a power of ten. Labels are at least 60 pixels apart,
 * and further for long numbers, so they never run into each other.
 */
export function gridStep(range: number, pixels: number, largest = 0, vertical = false): number {
	const chars = Math.max(2, formatTick(largest || range, range / 10).length)
	// Numbers stacked up an axis need only their height and a gap; numbers side by side need their width.
	const gap = vertical ? 36 : Math.max(60, chars * 8 + 20)
	const raw = (range * gap) / Math.max(pixels, 1)
	const power = Math.pow(10, Math.floor(Math.log10(raw)))
	return ([1, 2, 5, 10].map((m) => m * power).find((step) => step >= raw) ?? 10 * power)
}

/**
 * A tick value as text: plain with the decimals the step needs, or with an
 * exponent for very large or very small numbers, such as 1.5e7.
 */
function formatTick(value: number, step: number): string {
	const rounded = Math.round(value / step) * step
	if (rounded === 0) return '0'
	if (Math.abs(rounded) >= 1e5 || step < 1e-3) {
		// Enough significant digits to tell neighboring ticks apart, such as 1.00002e5.
		const digits = Math.min(15, Math.max(1, Math.floor(Math.log10(Math.abs(rounded))) - Math.floor(Math.log10(step)) + 1))
		return Number(rounded.toPrecision(digits)).toExponential().replace('e+', 'e')
	}
	const decimals = Math.max(0, -Math.floor(Math.log10(step)))
	return rounded.toFixed(decimals).replace(/^-0$/, '0')
}

/** Labels for an axis, so no two ticks read the same, and none is cut at the edge. */
export function axisLabels(step: number, visible?: [number, number], unitsPerPixel = 0) {
	// A number within this many units of the plot's edge would be cut, so it is left out.
	const margin = unitsPerPixel * 10
	return (value: number) => {
		if (visible && (value - visible[0] < margin || visible[1] - value < margin)) return ''
		return formatTick(value, step)
	}
}

/**
 * A live graph on the board, drawn with Mafs. It plots functions of x whose
 * parameters are sliders on the shape. The user drags a slider or the agent
 * sets a value, and both see the same curve.
 */
export class GraphShapeUtil extends ShapeUtil<GraphShape> {
	static override type = GRAPH_TYPE
	static override props: RecordProps<GraphShape> = {
		w: T.number,
		h: T.number,
		functions: T.arrayOf(T.object({ expression: T.string, label: T.string.optional(), ink: T.number.optional() })),
		xLabel: T.string.optional(),
		yLabel: T.string.optional(),
		parameters: T.arrayOf(shapeParameterValidator),
		xMin: T.number,
		xMax: T.number,
		yMin: T.number,
		yMax: T.number,
		points: T.arrayOf(T.object({ x: T.number, y: T.number, label: T.string.optional() })).optional(),
	}

	override getDefaultProps(): GraphShapeProps {
		return { w: 360, h: 240, functions: [{ expression: 'sin(x)' }], parameters: [], xMin: -6, xMax: 6, yMin: -3, yMax: 3 }
	}

	override canResize() {
		return true
	}

	/** The line the agent reads about this shape, wherever it sees the shape. */
	override getText(shape: GraphShape) {
		return describeGraph(shape.props)
	}

	override getGeometry(shape: GraphShape): Geometry2d {
		return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
	}

	/**
	 * A marked point that sits on a curve stays on it when a parameter changes,
	 * whoever changes it: a "t = 3 s" mark on v = a t moves up the line as a
	 * slider makes the line steeper, instead of being left behind.
	 */
	override onBeforeUpdate(prev: GraphShape, next: GraphShape) {
		// A revert writes the merged record as it is, so newer human points stay where they were.
		if (isRestoringRecords()) return next
		const points = keepPointsOnCurves(prev.props, next.props)
		return points ? { ...next, props: { ...next.props, points } } : next
	}

	override onResize(shape: GraphShape, info: { scaleX: number; scaleY: number }) {
		const sliders = parametersHeight(shape.props.parameters)
		const plot = Math.max(80, (shape.props.h - sliders) * Math.abs(info.scaleY))
		return { props: { w: Math.max(160, shape.props.w * Math.abs(info.scaleX)), h: plot + sliders } }
	}

	override component(shape: GraphShape) {
		return <Graph shape={shape} />
	}

	override getIndicatorPath(shape: GraphShape) {
		const path = new Path2D()
		path.roundRect(0, 0, shape.props.w, shape.props.h, 6)
		return path
	}
}

function Graph({ shape }: { shape: GraphShape }) {
	const { w, h, functions, parameters, xMin, xMax, yMax } = shape.props
	const plotHeight = Math.max(40, h - parametersHeight(parameters))
	const yMin = viewYMin(shape.props.yMin, yMax, plotHeight)
	const points = (shape.props.points ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
	const compiled = useMemo(
		() =>
			functions.map((f) => {
				try {
					return { fn: compileExpression(f.expression), error: null as string | null }
				} catch (error) {
					return { fn: null as CompiledExpression | null, error: error instanceof Error ? error.message : String(error) }
				}
			}),
		[functions]
	)
	const scope = parameterScope(parameters)
	const xStep = gridStep(xMax - xMin, w, Math.max(Math.abs(xMin), Math.abs(xMax)))
	const yStep = gridStep(yMax - yMin, plotHeight, Math.max(Math.abs(yMin), Math.abs(yMax)), true)
	const errors = compiled.filter((c) => c.error).map((c) => c.error)

	return (
		<HTMLContainer className="graph-container">
			<div className="graph-sheet" style={{ width: w, height: h }}>
				<div className="graph-plot" style={{ height: plotHeight }}>
					<Mafs
						width={w}
						height={plotHeight}
						pan={false}
						zoom={false}
						preserveAspectRatio={false}
						viewBox={{ x: [xMin, xMax], y: [yMin, yMax], padding: 0 }}
					>
						<Coordinates.Cartesian
							subdivisions={false}
							xAxis={{ lines: xStep, labels: false }}
							yAxis={{ lines: yStep, labels: false }}
						/>
						{compiled.map((c, i) =>
							c.fn ? (
								<Plot.OfX key={i} y={(x) => c.fn!({ ...scope, x })} color={curveInk(functions, i)} weight={2.5} />
							) : null
						)}
						{points.map((p, i) => {
							const color = pointInk(p, compiled, scope, functions)
							const toX = xMin <= 0 && xMax >= 0 ? 0 : xMin
							const toY = yMin <= 0 && yMax >= 0 ? 0 : yMin
							return (
								<g key={`p${i}`}>
									<Line.Segment point1={[p.x, p.y]} point2={[p.x, toY]} color={color} opacity={0.55} weight={1.5} style="dashed" />
									<Line.Segment point1={[p.x, p.y]} point2={[toX, p.y]} color={color} opacity={0.55} weight={1.5} style="dashed" />
									<Point x={p.x} y={p.y} color={color} />
								</g>
							)
						})}
						{/* The axis numbers go over the curves, with a halo, so a curve never crosses them out. */}
						<g className="graph-axis-labels">
							<Coordinates.Cartesian
								subdivisions={false}
								xAxis={{ lines: xStep, labels: axisLabels(xStep, [xMin, xMax], (xMax - xMin) / w) }}
								yAxis={{ lines: yStep, labels: axisLabels(yStep, [yMin, yMax], (yMax - yMin) / plotHeight) }}
							/>
						</g>
					</Mafs>
					{graphLabels({
						fns: compiled.map((c, i) => ({
							fn: c.fn ? (x: number) => c.fn!({ ...scope, x }) : null,
							label: functions[i].label?.trim() ?? '',
							color: curveInk(functions, i),
						})),
						xLabel: shape.props.xLabel?.trim() ?? '',
						yLabel: shape.props.yLabel?.trim() ?? '',
						marks: points.map((p) => ({ x: p.x, y: p.y, label: p.label?.trim() ?? '', color: pointInk(p, compiled, scope, functions) })),
						view: { xMin, xMax, yMin, yMax },
						w,
						h: plotHeight,
					}).map((l, i) => (
						<span
							key={i}
							className={`graph-label graph-label-${l.kind}`}
							style={{ left: l.x, top: l.y, color: l.color }}
						>
							{l.text}
						</span>
					))}
					{errors.length > 0 && <p className="graph-error">{errors[0]}</p>}
				</div>
				<ParameterSliders shape={shape} />
			</div>
		</HTMLContainer>
	)
}

/**
 * The bottom of the view. When the x axis lies on or near the plot's bottom
 * edge, as it does for a height that starts at zero, its tick numbers would
 * fall below the plot and be cut; the view then reaches a little below zero,
 * so the numbers have their own margin under the axis.
 */
export function viewYMin(yMin: number, yMax: number, plotHeight: number) {
	const room = 26
	if (!(yMin <= 0 && yMax > 0) || plotHeight <= room * 2) return yMin
	const above = ((0 - yMin) / (yMax - yMin)) * plotHeight
	if (above >= room) return yMin
	return yMax - (yMax * plotHeight) / (plotHeight - room)
}

/** How far a marked point may be from a curve and still be on it. */
function onCurveTolerance(y: number) {
	return Math.max(1e-6, Math.abs(y) * 0.05 + 0.05)
}

/**
 * The marked points after a parameter change, with each point that was on a
 * curve moved to stay on it. Null when nothing moves: no parameter changed,
 * the functions changed too, or no point was on a curve. A point the same
 * update moved itself is left where it was put.
 */
export function keepPointsOnCurves(prev: GraphShapeProps, next: GraphShapeProps): GraphPoint[] | null {
	const points = next.points ?? []
	if (points.length === 0 || prev.parameters === next.parameters) return null
	const before = parameterScope(prev.parameters)
	const after = parameterScope(next.parameters)
	if (Object.keys(after).every((k) => before[k] === after[k])) return null
	if (prev.functions.length !== next.functions.length || prev.functions.some((f, i) => f.expression !== next.functions[i].expression)) return null
	const fns = next.functions.map((f) => {
		try {
			return compileExpression(f.expression)
		} catch {
			return null
		}
	})
	let changed = false
	const moved = points.map((p, i) => {
		const old = prev.points?.[i]
		if (!old || old.x !== p.x || old.y !== p.y) return p
		let best: { fn: CompiledExpression; d: number } | null = null
		for (const fn of fns) {
			if (!fn) continue
			const d = Math.abs(fn({ ...before, x: p.x }) - p.y)
			if (Number.isFinite(d) && d <= onCurveTolerance(p.y) && (!best || d < best.d)) best = { fn, d }
		}
		if (!best) return p
		const y = best.fn({ ...after, x: p.x })
		if (!Number.isFinite(y) || y === p.y) return p
		changed = true
		return { ...p, y: Math.round(y * 1e6) / 1e6 }
	})
	return changed ? moved : null
}

/** A marked point takes the ink of the curve it lies on, so its label reads with that curve. */
function pointInk(p: GraphPoint, compiled: { fn: CompiledExpression | null }[], scope: Record<string, number>, functions: GraphFunction[]) {
	let best = { i: -1, d: Infinity }
	compiled.forEach((c, i) => {
		if (!c.fn) return
		const y = c.fn({ ...scope, x: p.x })
		const d = Math.abs(y - p.y)
		if (Number.isFinite(d) && d < best.d) best = { i, d }
	})
	const tolerance = onCurveTolerance(p.y)
	return best.i >= 0 && best.d <= tolerance ? curveInk(functions, best.i) : curveInk(functions, 0)
}

/** Type sizes of a graph's own labels, in px. */
const AXIS_TITLE_SIZE = 15
const CURVE_LABEL_SIZE = 15
const POINT_LABEL_SIZE = 15

export interface GraphLabel {
	kind: 'axis' | 'curve' | 'point'
	text: string
	color: string
	/** Top left, in the plot's pixels. */
	x: number
	y: number
}

type Rect = { minX: number; minY: number; maxX: number; maxY: number }

let measureContext: CanvasRenderingContext2D | null | undefined

/**
 * How wide a label is drawn, in px: measured in the board's serif where a
 * canvas exists, and never less than a generous estimate, since the serif may
 * still be loading and a fallback face runs narrower. An estimate alone ran
 * short, so a curve could pass through a label's last letter.
 */
function labelWidth(text: string, size: number): number {
	const estimate = text.length * size * 0.56
	if (measureContext === undefined) {
		try {
			measureContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
		} catch {
			measureContext = null
		}
	}
	if (!measureContext) return estimate
	measureContext.font = `italic 500 ${size}px 'Source Serif 4 Variable', Georgia, serif`
	return Math.max(estimate, measureContext.measureText(text).width * 1.06)
}

/** A label's box, with room for its halo. */
function labelBox(text: string, size: number, x: number, y: number): Rect {
	return { minX: x, minY: y, maxX: x + labelWidth(text, size) + 6, maxY: y + size * 1.3 }
}

function collides(a: Rect, b: Rect, pad = 3) {
	return Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > -pad && Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > -pad
}

/**
 * Where a graph's words go. Each axis names its quantity and unit at its far
 * end, as a textbook prints it: the x title above the right end of the x
 * axis, the y title beside the top of the y axis. Each curve is named at its
 * right end, in its own ink, instead of in a legend, so the eye never travels
 * to a key and back (direct labeling: Tufte, "The Visual Display of
 * Quantitative Information"; Few, "Show Me the Numbers"). A curve that leaves
 * through the top or bottom edge is named where it leaves. A label that would
 * touch another, or an axis title, tries the other side of its curve and then
 * steps away from it until it is clear.
 */
export function graphLabels(input: {
	fns: { fn: ((x: number) => number) | null; label: string; color: string }[]
	xLabel: string
	yLabel: string
	marks?: { x: number; y: number; label: string; color: string }[]
	view: { xMin: number; xMax: number; yMin: number; yMax: number }
	w: number
	h: number
}): GraphLabel[] {
	const { fns, xLabel, yLabel, view, w, h } = input
	const marks = input.marks ?? []
	const px = (x: number) => ((x - view.xMin) / (view.xMax - view.xMin)) * w
	const py = (y: number) => ((view.yMax - y) / (view.yMax - view.yMin)) * h
	const out: GraphLabel[] = []
	const taken: Rect[] = []
	const ink = '#5f5a50'
	// The axes sit at zero when zero is in view, else along the plot's edge.
	const axisY = view.yMin <= 0 && view.yMax >= 0 ? py(0) : h
	const axisX = view.xMin <= 0 && view.xMax >= 0 ? px(0) : 0
	// The tick numbers run just under the x axis and just right of the y axis.
	taken.push({ minX: 0, maxX: w, minY: axisY - 2, maxY: axisY + 22 })
	taken.push({ minX: axisX - 2, maxX: axisX + 30, minY: 0, maxY: h })
	// Every curve, sampled in pixels, so no word sits on a line.
	const steps = 240
	const curves = fns.map(({ fn }) => {
		const points: { x: number; y: number }[] = []
		if (!fn) return points
		for (let i = 0; i <= steps; i++) {
			const x = view.xMin + ((view.xMax - view.xMin) * i) / steps
			const y = fn(x)
			if (Number.isFinite(y) && y >= view.yMin && y <= view.yMax) points.push({ x: px(x), y: py(y) })
		}
		return points
	})
	const allPoints = curves.flat()
	for (const m of marks) taken.push({ minX: px(m.x) - 7, maxX: px(m.x) + 7, minY: py(m.y) - 7, maxY: py(m.y) + 7 })
	const clear = (r: Rect) =>
		r.minX >= 2 &&
		r.maxX <= w - 2 &&
		r.minY >= 2 &&
		r.maxY <= h - 2 &&
		!taken.some((t) => collides(t, r)) &&
		!allPoints.some((p) => p.x > r.minX - 3 && p.x < r.maxX + 3 && p.y > r.minY - 3 && p.y < r.maxY + 3)
	/** The first clear spot among the candidates, each tried as given and then stepped up and down. */
	const place = (text: string, size: number, candidates: [number, number][], stepX = 0) => {
		const box = labelBox(text, size, 0, 0)
		const bw = box.maxX
		const bh = box.maxY
		for (let step = 0; step <= 10; step++) {
			for (const [cx, cy] of candidates) {
				const d = step === 0 ? 0 : (step % 2 ? 1 : -1) * Math.ceil(step / 2)
				const x = Math.max(2, Math.min(w - bw - 2, cx + d * stepX))
				const y = Math.max(2, Math.min(h - bh - 2, cy + (stepX ? 0 : d * bh * 0.6)))
				const r = labelBox(text, size, x, y)
				if (clear(r)) return r
			}
		}
		// Crowded near the end: the clear spot nearest to it, anywhere on the plot.
		const [ax, ay] = candidates[0]
		let best: { r: Rect; d: number } | null = null
		for (let y = 2; y + bh <= h - 2; y += 8) {
			for (let x = 2; x + bw <= w - 2; x += 8) {
				const d = Math.hypot(x - ax, y - ay)
				if (best && d >= best.d) continue
				const r = labelBox(text, size, x, y)
				if (clear(r)) best = { r, d }
			}
		}
		return best?.r ?? null
	}
	const titles: { text: string; candidates: () => [number, number][]; stepX: number }[] = []
	if (xLabel) {
		const bw = labelBox(xLabel, AXIS_TITLE_SIZE, 0, 0).maxX
		const bh = AXIS_TITLE_SIZE * 1.3
		// Above the axis's right end, or below it past the tick numbers, sliding left if a curve is
		// there; else in the bottom right corner, under everything, rather than afloat in the plot.
		titles.push({
			text: xLabel,
			stepX: -24,
			candidates: () => [
				[w - bw - 8, axisY - bh - 4],
				[w - bw - 8, axisY + 24],
				[w - bw - 8, h - bh - 4],
			],
		})
	}
	if (yLabel) {
		const bw = labelBox(yLabel, AXIS_TITLE_SIZE, 0, 0).maxX
		// Beside the axis's top end, sliding down if a curve is there.
		titles.push({ text: yLabel, stepX: 0, candidates: () => [[axisX + 32, 4], [axisX - bw - 8, 4]] })
	}
	for (const title of titles) {
		const r = place(title.text, AXIS_TITLE_SIZE, title.candidates(), title.stepX)
		if (!r) continue
		taken.push(r)
		out.push({ kind: 'axis', text: title.text, color: ink, x: r.minX, y: r.minY })
	}
	// Each marked point is named beside its dot, on the side away from the curve.
	for (const m of marks) {
		if (!m.label) continue
		const mx = px(m.x)
		const my = py(m.y)
		const bw = labelBox(m.label, POINT_LABEL_SIZE, 0, 0).maxX
		const bh = POINT_LABEL_SIZE * 1.3
		const r = place(m.label, POINT_LABEL_SIZE, [
			[mx + 10, my - bh - 8],
			[mx - bw - 10, my - bh - 8],
			[mx + 12, my + 8],
			[mx - bw - 12, my + 8],
			[mx - bw / 2, my - bh - 14],
		])
		if (!r) continue
		taken.push(r)
		out.push({ kind: 'point', text: m.label, color: m.color, x: r.minX, y: r.minY })
	}
	fns.forEach(({ label, color }, i) => {
		const points = curves[i]
		if (!label || points.length === 0) return
		// The curve's last point in view: at the right edge, or where it leaves through the top or bottom.
		const end = points[points.length - 1]
		const bw = labelBox(label, CURVE_LABEL_SIZE, 0, 0).maxX
		const bh = CURVE_LABEL_SIZE * 1.3
		const candidates: [number, number][] =
			end.x > w - 12
				? [
						[w - bw - 6, end.y - bh - 6],
						[w - bw - 6, end.y + 8],
					]
				: [
						[end.x + 10, end.y < h / 2 ? end.y + 4 : end.y - bh - 4],
						[end.x - bw - 10, end.y < h / 2 ? end.y + 4 : end.y - bh - 4],
					]
		const r = place(label, CURVE_LABEL_SIZE, candidates)
		if (!r) return
		taken.push(r)
		out.push({ kind: 'curve', text: label, color, x: r.minX, y: r.minY })
	})
	return out
}
