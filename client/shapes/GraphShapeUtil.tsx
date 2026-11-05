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
}

export interface GraphShapeProps {
	w: number
	h: number
	functions: GraphFunction[]
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
	const fns = props.functions.map((f) => `y = ${f.expression}`).join('; ')
	const params = describeParameters(props.parameters)
	return `Graph of ${fns || 'nothing yet'}, x from ${props.xMin} to ${props.xMax}, y from ${props.yMin} to ${props.yMax}.${params ? ` Parameters: ${params}.` : ''}`
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
		functions: T.arrayOf(T.object({ expression: T.string })),
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
						<Coordinates.Cartesian />
						{compiled.map((c, i) =>
							c.fn ? (
								<Plot.OfX key={i} y={(x) => c.fn!({ ...scope, x })} color={PLOT_INKS[i % PLOT_INKS.length]} weight={2.5} />
							) : null
						)}
					</Mafs>
					{errors.length > 0 && <p className="graph-error">{errors[0]}</p>}
				</div>
				<ParameterSliders shape={shape} />
			</div>
		</HTMLContainer>
	)
}
