import { useEffect, useRef, useState } from 'react'
import { Geometry2d, HTMLContainer, Rectangle2d, RecordProps, ShapeUtil, T, TLShape } from 'tldraw'
import { parametersHeight } from './GraphShapeUtil'
import { ParameterSliders, rangeFill, ShapeParameter, shapeParameterValidator } from './math/parameters'

export const SIMULATION_TYPE = 'simulation'

/** The simulations Easel can run. Each is a pure function of its parameters and time. */
export type SimulationKind = 'projectile'

export interface SimulationShapeProps {
	w: number
	h: number
	kind: SimulationKind
	parameters: ShapeParameter[]
}

declare module 'tldraw' {
	export interface TLGlobalShapePropsMap {
		[SIMULATION_TYPE]: SimulationShapeProps
	}
}

export type SimulationShape = TLShape<typeof SIMULATION_TYPE>

/** A projectile's parameters, with their ranges, as the simulation starts. */
export const PROJECTILE_PARAMETERS: ShapeParameter[] = [
	{ name: 'speed', value: 20, min: 1, max: 60, step: 0.5 },
	{ name: 'angle', value: 45, min: 0, max: 90, step: 1 },
	{ name: 'gravity', value: 9.8, min: 0.5, max: 25, step: 0.1 },
	{ name: 'height', value: 0, min: 0, max: 50, step: 0.5 },
]

/** The controls row: play or pause, and the time scrubber. */
const CONTROLS = 34

interface Projectile {
	speed: number
	angle: number
	gravity: number
	height: number
}

function projectileFrom(parameters: ShapeParameter[]): Projectile {
	const get = (name: keyof Projectile) =>
		parameters.find((p) => p.name === name)?.value ?? PROJECTILE_PARAMETERS.find((p) => p.name === name)!.value
	return { speed: get('speed'), angle: get('angle'), gravity: get('gravity'), height: get('height') }
}

/** Where the projectile is at time t, in metres. The same inputs always give the same point. */
export function projectileAt(p: Projectile, t: number) {
	const a = (p.angle * Math.PI) / 180
	return {
		x: p.speed * Math.cos(a) * t,
		y: p.height + p.speed * Math.sin(a) * t - 0.5 * p.gravity * t * t,
	}
}

/** Time of flight, range, and greatest height of a projectile. */
export function projectileSummary(p: Projectile) {
	const a = (p.angle * Math.PI) / 180
	const vy = p.speed * Math.sin(a)
	const flight = (vy + Math.sqrt(vy * vy + 2 * p.gravity * p.height)) / p.gravity
	return {
		flight,
		range: p.speed * Math.cos(a) * flight,
		peak: p.height + (vy * vy) / (2 * p.gravity),
	}
}

/** A line the agent reads about a simulation: its parameters and what they give. */
export function describeSimulation(props: SimulationShapeProps): string {
	const p = projectileFrom(props.parameters)
	const s = projectileSummary(p)
	const f = (n: number) => Math.round(n * 100) / 100
	return `Projectile simulation: speed ${f(p.speed)} m/s, angle ${f(p.angle)} degrees, gravity ${f(p.gravity)} m/s², launch height ${f(p.height)} m. Flight time ${f(s.flight)} s, range ${f(s.range)} m, greatest height ${f(s.peak)} m.`
}

/**
 * A deterministic 2D simulation on the board: a projectile, drawn from its
 * parameters at a time the user plays, pauses, or scrubs. Its parameters are
 * sliders that the user and the agent both change, and the same parameters
 * always give the same frames. Playback is the viewer's own; only the
 * parameters are part of the board.
 */
export class SimulationShapeUtil extends ShapeUtil<SimulationShape> {
	static override type = SIMULATION_TYPE
	static override props: RecordProps<SimulationShape> = {
		w: T.number,
		h: T.number,
		kind: T.literalEnum('projectile'),
		parameters: T.arrayOf(shapeParameterValidator),
	}

	override getDefaultProps(): SimulationShapeProps {
		return { w: 420, h: 260 + CONTROLS + parametersHeight(PROJECTILE_PARAMETERS), kind: 'projectile', parameters: PROJECTILE_PARAMETERS }
	}

	override canResize() {
		return false
	}

	/** The line the agent reads about this shape, wherever it sees the shape. */
	override getText(shape: SimulationShape) {
		return describeSimulation(shape.props)
	}

	override getGeometry(shape: SimulationShape): Geometry2d {
		return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
	}

	override component(shape: SimulationShape) {
		return <Simulation shape={shape} />
	}

	override getIndicatorPath(shape: SimulationShape) {
		const path = new Path2D()
		path.roundRect(0, 0, shape.props.w, shape.props.h, 6)
		return path
	}
}

/** Space around the drawing inside the plot, in pixels. */
const MARGIN = 22

function Simulation({ shape }: { shape: SimulationShape }) {
	const { w, h, parameters } = shape.props
	const projectile = projectileFrom(parameters)
	const summary = projectileSummary(projectile)
	const plotHeight = Math.max(80, h - CONTROLS - parametersHeight(parameters))
	const [time, setTime] = useState(summary.flight)
	const [playing, setPlaying] = useState(false)
	const frame = useRef(0)

	// A new flight time, from new parameters, keeps the playhead inside the flight.
	useEffect(() => setTime((t) => Math.min(t, summary.flight)), [summary.flight])

	useEffect(() => {
		if (!playing) return
		let last = performance.now()
		const step = (now: number) => {
			const dt = (now - last) / 1000
			last = now
			setTime((t) => {
				const next = t + dt
				if (next >= summary.flight) {
					setPlaying(false)
					return summary.flight
				}
				return next
			})
			frame.current = requestAnimationFrame(step)
		}
		frame.current = requestAnimationFrame(step)
		return () => cancelAnimationFrame(frame.current)
	}, [playing, summary.flight])

	// One scale for both axes, so the arc keeps its true shape.
	const worldW = Math.max(summary.range, 1)
	const worldH = Math.max(summary.peak, projectile.height, 1)
	const scale = Math.min((w - MARGIN * 2) / worldW, (plotHeight - MARGIN * 2) / worldH)
	const ground = plotHeight - MARGIN
	const toScreen = (x: number, y: number) => ({ x: MARGIN + x * scale, y: ground - y * scale })
	const samples = 60
	const path = Array.from({ length: samples + 1 }, (_, i) => {
		const point = projectileAt(projectile, (summary.flight * i) / samples)
		const s = toScreen(point.x, Math.max(0, point.y))
		return `${i === 0 ? 'M' : 'L'}${s.x.toFixed(1)},${s.y.toFixed(1)}`
	}).join(' ')
	const now = projectileAt(projectile, time)
	const ball = toScreen(now.x, Math.max(0, now.y))
	const f = (n: number) => (Math.round(n * 10) / 10).toString()

	return (
		<HTMLContainer className="simulation-container">
			<div className="graph-sheet simulation-sheet" style={{ width: w, height: h }}>
				<svg width={w} height={plotHeight} className="simulation-plot" aria-label={describeSimulation(shape.props)}>
					<line x1={MARGIN / 2} x2={w - MARGIN / 2} y1={ground} y2={ground} className="simulation-ground" />
					<path d={path} className="simulation-path" />
					<circle cx={ball.x} cy={ball.y} r={7} className="simulation-ball" />
					<text x={w - MARGIN} y={MARGIN} textAnchor="end" className="simulation-readout">
						range {f(summary.range)} m · peak {f(summary.peak)} m · t {f(time)} / {f(summary.flight)} s
					</text>
				</svg>
				<div
					className="simulation-controls"
					onPointerDown={(e) => e.stopPropagation()}
					onWheel={(e) => e.stopPropagation()}
				>
					<button
						className="simulation-play"
						aria-label={playing ? 'Pause' : 'Play'}
						onClick={() => {
							if (!playing && time >= summary.flight) setTime(0)
							setPlaying((p) => !p)
						}}
					>
						{playing ? <PauseGlyph /> : <PlayGlyph />}
					</button>
					<input
						className="paper-range"
						type="range"
						min={0}
						max={summary.flight}
						step="any"
						value={time}
						style={rangeFill(time, 0, summary.flight)}
						aria-label="Time"
						onChange={(e) => {
							setPlaying(false)
							setTime(Number(e.currentTarget.value))
						}}
					/>
				</div>
				<ParameterSliders shape={shape} />
			</div>
		</HTMLContainer>
	)
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
