import { Circle, Coordinates, Line, Mafs, MovablePoint, Plot, Point, Polygon, Polyline, Text, Vector } from 'mafs'
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
	Geometry2d,
	HTMLContainer,
	Rectangle2d,
	RecordProps,
	ShapeUtil,
	T,
	TLShape,
	useEditor,
	useValue,
} from 'tldraw'
import { axisLabels, gridStep, parametersHeight } from './GraphShapeUtil'
import { newTemplateId, saveTemplate, SceneTemplate } from './scene/templates'
import { clampParameter, ShapeParameter, shapeParameterValidator, SliderRows } from './math/parameters'
import {
	checkHolds,
	checkScene,
	describeScene,
	dragTargets,
	evaluateIn,
	evaluateScene,
	fillText,
	formatNumber,
	isVisible,
	letsInOrder,
	resolveRef,
	SCENE_INKS,
	SceneObject,
	sceneParameters,
	SceneProps,
	SceneValues,
} from './scene/sceneModel'

export const SCENE_TYPE = 'scene'

declare module 'tldraw' {
	export interface TLGlobalShapePropsMap {
		[SCENE_TYPE]: SceneProps
	}
}

export type SceneShape = TLShape<typeof SCENE_TYPE>

/**
 * What the agent reads about a scene, plus any objects its last scene action
 * could not use, so the agent can fix them instead of guessing from a picture.
 */
export function describeSceneShape(shape: SceneShape): string {
	const dropped = (shape.meta.sceneDropped as string[] | undefined) ?? []
	const text = describeScene(shape.props)
	return dropped.length ? `${text} Not drawn, because they could not be read: ${dropped.join('; ')}.` : text
}

/** The play row, when the scene has a clock. */
const CONTROLS = 34

/** How much of a scene's height its play row and sliders take. */
export function sceneChromeHeight(props: Pick<SceneProps, 'duration' | 'params'>): number {
	return (props.duration > 0 ? CONTROLS : 0) + parametersHeight(sceneParameters(props))
}

/**
 * A scene on the board: a visual described as data, drawn with Mafs. Its
 * parameters are sliders, some points can be dragged, and time can play. Every
 * change goes through the shape's props, so it is an ordinary command, checked
 * field by field so the user and the agent can change different parts at once.
 * Playback is each viewer's own.
 */
export class SceneShapeUtil extends ShapeUtil<SceneShape> {
	static override type = SCENE_TYPE
	static override props: RecordProps<SceneShape> = {
		w: T.number,
		h: T.number,
		title: T.string,
		xMin: T.number,
		xMax: T.number,
		yMin: T.number,
		yMax: T.number,
		duration: T.number,
		axes: T.boolean.optional(),
		pinnedTime: T.number.optional(),
		pinCount: T.number.optional(),
		params: T.dict(T.string, shapeParameterValidator),
		objects: T.dict(T.string, T.jsonValue) as never,
	}

	override getDefaultProps(): SceneProps {
		return { w: 400, h: 300, title: '', xMin: -5, xMax: 5, yMin: -4, yMax: 4, duration: 0, axes: true, params: {}, objects: {} }
	}

	override getGeometry(shape: SceneShape): Geometry2d {
		return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
	}

	override onResize(shape: SceneShape, info: { scaleX: number; scaleY: number }) {
		const chrome = sceneChromeHeight(shape.props)
		const plot = Math.max(80, (shape.props.h - chrome) * Math.abs(info.scaleY))
		return { props: { w: Math.max(160, shape.props.w * Math.abs(info.scaleX)), h: plot + chrome } }
	}

	override getText(shape: SceneShape) {
		return describeSceneShape(shape)
	}

	override component(shape: SceneShape) {
		return <Scene shape={shape} />
	}

	override getIndicatorPath(shape: SceneShape) {
		const path = new Path2D()
		path.roundRect(0, 0, shape.props.w, shape.props.h, 6)
		return path
	}
}

function Scene({ shape }: { shape: SceneShape }) {
	const editor = useEditor()
	const { w, h, title, xMin, xMax, yMin, yMax, duration, params, objects } = shape.props
	const axes = shape.props.axes !== false
	// While the agent is still writing a new scene, it shows read-only.
	const preview = shape.meta.scenePreview === true
	const parameters = sceneParameters(shape.props)
	const plotHeight = Math.max(60, h - sceneChromeHeight(shape.props))
	const [t, setT] = usePlayback(duration)
	// When the agent pins a time, every viewer stops on it.
	const { pinnedTime, pinCount } = shape.props
	useEffect(() => {
		if (typeof pinnedTime === 'number' && Number.isFinite(pinnedTime)) {
			setT({ time: Math.min(Math.max(0, pinnedTime), duration), playing: false })
		}
	}, [pinnedTime, pinCount, duration, setT])
	const values = useMemo(() => evaluateScene({ params, objects }, t.time), [params, objects, t.time])
	// A stop event stops playback where it stopped the clock.
	useEffect(() => {
		if (t.playing && values.stoppedAt !== null && t.time >= values.stoppedAt) {
			setT({ time: values.stoppedAt, playing: false })
		}
	}, [t.playing, t.time, values.stoppedAt, setT])
	// Each trace is sampled once whenever the scene changes, not every frame.
	const traces = useMemo(() => sampleTraces({ params, objects }, duration), [params, objects, duration])
	// Each viewer can open the formulas behind the picture, as in Desmos.
	const [showFormulas, setShowFormulas] = useState(false)
	const [saved, setSaved] = useState<'saved' | 'problems' | null>(null)
	// Chat-history previews are read-only copies, where a save would go nowhere.
	const readOnlyEditor = useValue('scene read-only', () => editor.getIsReadonly(), [editor])
	const formulas = useMemo(
		() => (showFormulas ? formulaRows(objects, values.scope) : []),
		[showFormulas, objects, values.scope]
	)
	const xStep = gridStep(xMax - xMin, w, Math.max(Math.abs(xMin), Math.abs(xMax)))
	const yStep = gridStep(yMax - yMin, plotHeight, Math.max(Math.abs(yMin), Math.abs(yMax)))
	// Both axes share one scale, set by whichever range is tighter, so the plot
	// shows a little more than the range on the other axis.
	const unitsPerPixel = Math.max((xMax - xMin) / w, (yMax - yMin) / plotHeight)
	const visibleX: [number, number] = [(xMin + xMax) / 2 - (w * unitsPerPixel) / 2, (xMin + xMax) / 2 + (w * unitsPerPixel) / 2]
	const visibleY: [number, number] = [
		(yMin + yMax) / 2 - (plotHeight * unitsPerPixel) / 2,
		(yMin + yMax) / 2 + (plotHeight * unitsPerPixel) / 2,
	]

	// A slider or a point changes only that parameter's value, so the edit is a
	// change to one field, and never conflicts with the agent's work elsewhere.
	const setParam = (name: string, value: number) => {
		const current = editor.getShape<SceneShape>(shape.id)
		if (!current || !Object.hasOwn(current.props.params, name)) return
		const p = current.props.params[name]
		const next = clampParameter(p, value)
		if (next === p.value) return
		editor.updateShape<SceneShape>({
			id: shape.id,
			type: SCENE_TYPE,
			props: { params: { ...current.props.params, [name]: { ...p, value: next } } },
		})
	}

	const readouts = Object.entries(objects).filter(
		([, o]) => o.type === 'readout' && isVisible(o, values.scope)
	) as [string, Extract<SceneObject, { type: 'readout' }>][]
	const errors = Object.entries(values.errors)

	return (
		<HTMLContainer className={`graph-container scene-container${preview ? ' scene-preview' : ''}`}>
			<div className="graph-sheet" style={{ width: w, height: h }}>
				<div
					className="graph-plot"
					style={{ height: plotHeight }}
					onPointerDown={(e) => {
						// Dragging a point is the user's edit of the scene, with its own undo step.
						if ((e.target as Element).closest('.mafs-movable-point')) {
							e.stopPropagation()
							editor.markHistoryStoppingPoint('scene point')
						}
					}}
				>
					<Mafs
						width={w}
						height={plotHeight}
						pan={false}
						zoom={false}
						preserveAspectRatio="contain"
						viewBox={{ x: [xMin, xMax], y: [yMin, yMax], padding: 0 }}
					>
						{axes && (
							<Coordinates.Cartesian
								subdivisions={false}
								xAxis={{ lines: xStep, labels: axisLabels(xStep, visibleX, unitsPerPixel) }}
								yAxis={{ lines: yStep, labels: axisLabels(yStep, visibleY, unitsPerPixel) }}
							/>
						)}
						{renderObjects(
							objects,
							values,
							params,
							setParam,
							duration,
							t.time,
							unitsPerPixel,
							traces,
							{ x: visibleX, y: visibleY },
							preview
						)}
					</Mafs>
					{title && <div className="scene-title">{title}</div>}
					{readouts.length > 0 && (
						<div className="scene-readouts">
							{readouts.map(([id, o]) => (
								<div key={id} className="scene-readout">
									{fillText(o.text, values.scope)}
								</div>
							))}
						</div>
					)}
					{errors.length > 0 && <p className="graph-error">{`${errors[0][0]}: ${errors[0][1]}`}</p>}
					{showFormulas && (
						<div className="scene-formulas" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
							{formulas.length === 0 ? (
								<div className="scene-formula">No formulas in this scene.</div>
							) : (
								formulas.map((row) => (
									<div key={row.id} className={`scene-formula${row.failing ? ' scene-formula-failing' : ''}`}>
										<span className="scene-formula-name">{row.id}</span> {row.text}
									</div>
								))
							)}
						</div>
					)}
					{!readOnlyEditor && (
					<button
						className="scene-save-template"
						title="Save this scene as a template the agent can place again"
						onPointerDown={(e) => e.stopPropagation()}
						onClick={() => {
							// A scene with problems is not saved, since the agent would reuse them.
							const current = editor.getShape<SceneShape>(shape.id)
							if (!current || checkScene(current.props).length > 0) {
								setSaved('problems')
								setTimeout(() => setSaved(null), 2000)
								return
							}
							editor.markHistoryStoppingPoint('save template')
							// Saving the same scene again updates its own template.
							const id = (current.meta.savedTemplateId as string | undefined) ?? newTemplateId(editor, current.props.title)
							editor.run(() => {
								saveTemplate(editor, templateFromScene(current, id))
								editor.updateShape<SceneShape>({ id: current.id, type: SCENE_TYPE, meta: { ...current.meta, savedTemplateId: id } })
							})
							setSaved('saved')
							setTimeout(() => setSaved(null), 1500)
						}}
					>
						{saved === 'saved' ? 'Saved' : saved === 'problems' ? 'Fix its problems first' : 'Save as template'}
					</button>
					)}
					<button
						className="scene-formulas-toggle"
						aria-pressed={showFormulas}
						title={showFormulas ? 'Hide formulas' : 'Show formulas'}
						onPointerDown={(e) => e.stopPropagation()}
						onClick={() => setShowFormulas((v) => !v)}
					>
						f(x)
					</button>
				</div>
				{duration > 0 && (
					<div className="simulation-controls" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
						<button
							className="simulation-play"
							aria-label={t.playing ? 'Pause' : 'Play'}
							onClick={() => setT({ playing: !t.playing, time: !t.playing && t.time >= duration ? 0 : t.time })}
						>
							{t.playing ? <PauseGlyph /> : <PlayGlyph />}
						</button>
						<input
							type="range"
							min={0}
							max={duration}
							step="any"
							value={t.time}
							aria-label="Time"
							onChange={(e) => setT({ playing: false, time: Number(e.currentTarget.value) })}
						/>
					</div>
				)}
				<SliderRows parameters={parameters} onSet={setParam} />
			</div>
		</HTMLContainer>
	)
}

/** Local playback: time runs from 0 to the duration, and stops there. */
function usePlayback(duration: number) {
	const [state, setState] = useState({ time: 0, playing: false })
	const frame = useRef(0)
	useEffect(() => setState((s) => ({ ...s, time: Math.min(s.time, duration) })), [duration])
	useEffect(() => {
		if (!state.playing) return
		let last = performance.now()
		const step = (now: number) => {
			const dt = (now - last) / 1000
			last = now
			setState((s) => {
				const time = s.time + dt
				return time >= duration ? { time: duration, playing: false } : { ...s, time }
			})
			frame.current = requestAnimationFrame(step)
		}
		frame.current = requestAnimationFrame(step)
		return () => cancelAnimationFrame(frame.current)
	}, [state.playing, duration])
	return [state, setState] as const
}

/**
 * A template from a scene as it is now: its frame, its parameters at their
 * current values, and its objects.
 */
function templateFromScene(shape: SceneShape, id: string): SceneTemplate {
	const { title, w, h, xMin, xMax, yMin, yMax, duration, axes, params, objects } = shape.props
	return {
		id,
		title: title || 'Saved scene',
		useFor: title || 'a scene saved on this board',
		verified: 'saved by a person on this board',
		width: w,
		height: h - sceneChromeHeight(shape.props),
		xMin,
		xMax,
		yMin,
		yMax,
		duration,
		axes: axes !== false,
		params: Object.values(params).map((p) => ({ ...p })),
		objects: Object.entries(objects).map(([objectId, o]) => ({ id: objectId, ...o })),
	}
}

/** The lines of the formulas panel: each let with its formula and value, and each check. */
function formulaRows(objects: Record<string, SceneObject>, scope: Record<string, number>) {
	const rows: { id: string; text: string; failing: boolean }[] = []
	for (const [id, o] of letsInOrder(objects)) {
		rows.push({ id, text: `= ${o.expr} = ${formatNumber(scope[id])}`, failing: !Number.isFinite(scope[id]) })
	}
	for (const [id, o] of Object.entries(objects)) {
		if (o.type !== 'check') continue
		let holds = false
		try {
			holds = checkHolds(evaluateIn(o.expr, scope))
		} catch {
			holds = false
		}
		rows.push({ id, text: `${holds ? 'holds' : 'fails'}: ${o.text || o.expr}`, failing: !holds })
	}
	return rows
}

/** How many samples a trace takes per second of the clock, and at most in all. */
const TRACE_SAMPLES_PER_SECOND = 60
const MAX_TRACE_SAMPLES = 2400

/** The positions each traced point passes through, sampled evenly from time 0 to the end. */
function sampleTraces(props: Pick<SceneProps, 'params' | 'objects'>, duration: number) {
	const traces: Record<string, [number, number][]> = {}
	const traced = Object.entries(props.objects).filter(([, o]) => o.type === 'trace') as [string, Extract<SceneObject, { type: 'trace' }>][]
	if (traced.length === 0 || duration <= 0) return traces
	for (const [id] of traced) traces[id] = []
	const count = Math.min(MAX_TRACE_SAMPLES, Math.max(120, Math.ceil(duration * TRACE_SAMPLES_PER_SECOND)))
	for (let i = 0; i <= count; i++) {
		const values = evaluateScene(props, (duration * i) / count)
		for (const [id, o] of traced) traces[id].push(values.points[o.of] ?? [NaN, NaN])
	}
	return traces
}

/** Space between a label and what it names, in pixels, so it never sits on the line. */
const LABEL_GAP = 10

/**
 * Where a vector's label goes, relative to its tip: a little past the tip
 * along the vector, so it never sits on the arrowhead or the shaft.
 */
function labelOffset(dx: number, dy: number, unitsPerPixel: number): [number, number] {
	const length = Math.hypot(dx, dy)
	const gap = (LABEL_GAP + 8) * unitsPerPixel
	if (!(length > 0)) return [gap, gap]
	return [(dx / length) * gap, (dy / length) * gap]
}

/** Draw order: areas and curves first, then lines, then points and labels on top. */
const LAYER: Record<SceneObject['type'], number> = {
	let: -1,
	readout: -1,
	check: -1,
	state: -1,
	event: -1,
	polygon: 0,
	circle: 0,
	plot: 1,
	curve: 1,
	trace: 1,
	segment: 2,
	line: 2,
	vector: 2,
	point: 3,
	label: 4,
}

function renderObjects(
	objects: Record<string, SceneObject>,
	values: SceneValues,
	params: Record<string, ShapeParameter>,
	setParam: (name: string, value: number) => void,
	duration: number,
	time: number,
	unitsPerPixel: number,
	traces: Record<string, [number, number][]>,
	view: { x: [number, number]; y: [number, number] },
	readOnly: boolean
): ReactNode[] {
	// Text keeps this far inside the plot, so no label is cut at an edge.
	const inset = 12 * unitsPerPixel
	const textWidth = (text: string) => text.length * 7.5 * unitsPerPixel
	const clampY = (y: number) => Math.min(view.y[1] - inset, Math.max(view.y[0] + inset, y))
	const clampCenterX = (x: number, text: string) =>
		Math.min(view.x[1] - inset - textWidth(text) / 2, Math.max(view.x[0] + inset + textWidth(text) / 2, x))
	const finite = (p: [number, number]) => Number.isFinite(p[0]) && Number.isFinite(p[1])
	const at = (fn: () => ReactNode) => {
		try {
			return fn()
		} catch {
			return null
		}
	}
	return Object.entries(objects)
		.filter(([, o]) => LAYER[o.type] >= 0 && isVisible(o, values.scope))
		.sort((a, b) => LAYER[a[1].type] - LAYER[b[1].type])
		.map(([id, o]) => {
			const color = SCENE_INKS[o.ink ?? 0]
			return (
				<g key={id} data-scene-object={id}>
					{at(() => {
						switch (o.type) {
							case 'point': {
								const p = values.points[id]
								if (!p || !finite(p)) return null
								const drag = readOnly ? null : dragTargets(o, params)
								const labelText = o.label ? fillText(o.label, values.scope) : ''
								// Above and to the right, or to the left when the right edge is near.
								const toLeft = p[0] + 6 * unitsPerPixel + textWidth(labelText) > view.x[1] - inset
								const label = labelText ? (
									<Text
										x={p[0] + (toLeft ? -6 : 6) * unitsPerPixel}
										y={clampY(p[1] + LABEL_GAP * unitsPerPixel)}
										attach={toLeft ? 'w' : 'e'}
										size={15}
										color={color}
									>
										{labelText}
									</Text>
								) : null
								if (drag) {
									return (
										<>
											<MovablePoint
												point={p}
												// A handle is red unless the agent gives it an ink, so its notes
												// can name it by color ("drag the blue tip").
												color={o.ink !== undefined ? color : SCENE_INKS[1]}
												constrain={
													drag.x && drag.y
														? undefined
														: drag.x
															? ([x]: [number, number]): [number, number] => [x, p[1]]
															: ([, y]: [number, number]): [number, number] => [p[0], y]
												}
												onMove={([x, y]) => {
													if (drag.x) setParam(drag.x.name, x)
													if (drag.y) setParam(drag.y.name, y)
												}}
											/>
											{label}
										</>
									)
								}
								return (
									<>
										<Point x={p[0]} y={p[1]} color={color} />
										{label}
									</>
								)
							}
							case 'segment':
							case 'line': {
								const a = resolveRef(o.from, values)
								const b = resolveRef(o.to, values)
								if (!finite(a) || !finite(b)) return null
								if (o.type === 'line') return <Line.ThroughPoints point1={a} point2={b} color={color} />
								return (
									<>
										<Line.Segment point1={a} point2={b} color={color} />
										{o.label && (
											<Text
												x={(a[0] + b[0]) / 2 + labelOffset(a[1] - b[1], b[0] - a[0], unitsPerPixel)[0]}
												y={(a[1] + b[1]) / 2 + labelOffset(a[1] - b[1], b[0] - a[0], unitsPerPixel)[1]}
												size={14}
												color={color}
											>
												{fillText(o.label, values.scope)}
											</Text>
										)}
									</>
								)
							}
							case 'vector': {
								const tail = resolveRef(o.from, values)
								const tip: [number, number] = [
									tail[0] + evaluateIn(o.dx, values.scope),
									tail[1] + evaluateIn(o.dy, values.scope),
								]
								if (!finite(tail) || !finite(tip)) return null
								const pixels = Math.hypot(tip[0] - tail[0], tip[1] - tail[1]) / unitsPerPixel
								// A vector too short to see is left out; a short one is a plain line,
								// since an arrowhead alone would overshoot its tail.
								if (pixels < 2) return null
								return (
									<>
										{pixels < 16 ? (
											<Line.Segment point1={tail} point2={tip} color={color} weight={2.5} />
										) : (
											<Vector tail={tail} tip={tip} color={color} weight={2.5} />
										)}
										{o.label && (
											<Text
												x={tip[0] + labelOffset(tip[0] - tail[0], tip[1] - tail[1], unitsPerPixel)[0]}
												y={tip[1] + labelOffset(tip[0] - tail[0], tip[1] - tail[1], unitsPerPixel)[1]}
												size={14}
												color={color}
											>
												{fillText(o.label, values.scope)}
											</Text>
										)}
									</>
								)
							}
							case 'circle': {
								const c = resolveRef(o.center, values)
								const r = evaluateIn(o.r, values.scope)
								if (!finite(c) || !(r > 0)) return null
								return <Circle center={c} radius={r} color={color} fillOpacity={o.fill ? 0.35 : 0} />
							}
							case 'polygon': {
								const points = o.points.map((p) => resolveRef(p, values))
								if (!points.every(finite)) return null
								return <Polygon points={points} color={color} fillOpacity={o.fill ? 0.2 : 0} />
							}
							case 'plot':
								return <Plot.OfX y={(x) => evaluateIn(o.y, { ...values.scope, x })} color={color} weight={2.5} />
							case 'curve': {
								const from = evaluateIn(o.from, values.scope)
								const to = evaluateIn(o.to, values.scope)
								if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return null
								return (
									<Plot.Parametric
										domain={[from, to]}
										xy={(s) => [evaluateIn(o.x, { ...values.scope, s }), evaluateIn(o.y, { ...values.scope, s })]}
										color={color}
										weight={2.5}
									/>
								)
							}
							case 'trace': {
								// The path a point has followed from time 0 to now.
								const samples = traces[id]
								if (!samples || duration <= 0 || time <= 0) return null
								const upTo = samples.slice(0, Math.max(2, Math.ceil((time / duration) * (samples.length - 1)) + 1))
								const path = upTo.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
								if (path.length < 2) return null
								return (
									<Polyline
										points={path}
										color={color}
										weight={1.5}
										strokeStyle="dashed"
										fillOpacity={0}
										strokeOpacity={0.7}
									/>
								)
							}
							case 'label': {
								const p = resolveRef(o.at, values)
								if (!finite(p)) return null
								const text = fillText(o.text, values.scope)
								return (
									<Text x={clampCenterX(p[0], text)} y={clampY(p[1])} size={15} color={color}>
										{text}
									</Text>
								)
							}
							default:
								return null
						}
					})}
				</g>
			)
		})
}

function PlayGlyph() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
			<path d="M7 4.5v15l13-7.5z" />
		</svg>
	)
}

function PauseGlyph() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
			<rect x="6" y="4.5" width="4" height="15" rx="1" />
			<rect x="14" y="4.5" width="4" height="15" rx="1" />
		</svg>
	)
}
