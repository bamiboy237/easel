import { Coordinates, Mafs, Plot } from 'mafs'
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
}

declare module 'tldraw' {
	export interface TLGlobalShapePropsMap {
		[GRAPH_TYPE]: GraphShapeProps
	}
}

export type GraphShape = TLShape<typeof GRAPH_TYPE>

/** Each plotted function takes the next ink: charcoal, red pencil, blue, forest. */
export const PLOT_INKS = ['#302F2A', '#AE3B2C', '#2F5D8C', '#344C41']

/** Each slider row, and the space around the rows. */
export const PARAMETER_ROW = 28
export const PARAMETER_PAD = 10

/** How much of a shape's height its sliders take. */
export function parametersHeight(parameters: ShapeParameter[]): number {
	return parameters.length > 0 ? parameters.length * PARAMETER_ROW + PARAMETER_PAD * 2 : 0
}

/** A line the agent reads about a graph: what it plots, over what range, with what values. */
export function describeGraph(props: GraphShapeProps): string {
	const fns = props.functions.map((f) => `y = ${f.expression}${f.label ? ` ("${f.label}")` : ''}`).join('; ')
	const params = describeParameters(props.parameters)
	const axes = props.xLabel || props.yLabel ? ` Axes: x is ${props.xLabel || 'unlabeled'}, y is ${props.yLabel || 'unlabeled'}.` : ''
	return `Graph of ${fns || 'nothing yet'}, x from ${props.xMin} to ${props.xMax}, y from ${props.yMin} to ${props.yMax}.${axes}${params ? ` Parameters: ${params}.` : ''}`
}

/**
 * The space between grid lines for a range drawn across so many pixels: a
 * round 1, 2, or 5 times a power of ten. Labels are at least 60 pixels apart,
 * and further for long numbers, so they never run into each other.
 */
export function gridStep(range: number, pixels: number, largest = 0): number {
	const chars = Math.max(2, formatTick(largest || range, range / 10).length)
	const gap = Math.max(60, chars * 8 + 20)
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
		functions: T.arrayOf(T.object({ expression: T.string, label: T.string.optional() })),
		xLabel: T.string.optional(),
		yLabel: T.string.optional(),
		parameters: T.arrayOf(shapeParameterValidator),
		xMin: T.number,
		xMax: T.number,
		yMin: T.number,
		yMax: T.number,
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
	const { w, h, functions, parameters, xMin, xMax, yMin, yMax } = shape.props
	const plotHeight = Math.max(40, h - parametersHeight(parameters))
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
	const yStep = gridStep(yMax - yMin, plotHeight, Math.max(Math.abs(yMin), Math.abs(yMax)))
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
								<Plot.OfX key={i} y={(x) => c.fn!({ ...scope, x })} color={PLOT_INKS[i % PLOT_INKS.length]} weight={2.5} />
							) : null
						)}
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
							color: PLOT_INKS[i % PLOT_INKS.length],
						})),
						xLabel: shape.props.xLabel?.trim() ?? '',
						yLabel: shape.props.yLabel?.trim() ?? '',
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

/** Type sizes of a graph's own labels, in px. */
const AXIS_TITLE_SIZE = 15
const CURVE_LABEL_SIZE = 15

export interface GraphLabel {
	kind: 'axis' | 'curve'
	text: string
	color: string
	/** Top left, in the plot's pixels. */
	x: number
	y: number
}

type Rect = { minX: number; minY: number; maxX: number; maxY: number }

/** A label's box, from a width estimate for the board's serif. */
function labelBox(text: string, size: number, x: number, y: number): Rect {
	return { minX: x, minY: y, maxX: x + text.length * size * 0.52 + 4, maxY: y + size * 1.3 }
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
	view: { xMin: number; xMax: number; yMin: number; yMax: number }
	w: number
	h: number
}): GraphLabel[] {
	const { fns, xLabel, yLabel, view, w, h } = input
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
		// Above the axis's right end, or below it past the tick numbers, sliding left if a curve is there.
		titles.push({ text: xLabel, stepX: -24, candidates: () => [[w - bw - 8, axisY - bh - 4], [w - bw - 8, axisY + 24]] })
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
