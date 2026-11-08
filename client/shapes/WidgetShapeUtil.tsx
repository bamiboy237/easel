import { useEffect, useMemo, useRef, useState } from 'react'
import {
	Geometry2d,
	HTMLContainer,
	Rectangle2d,
	RecordProps,
	ShapeUtil,
	T,
	TLShape,
	TLShapeId,
	useEditor,
	useValue,
	Vec,
} from 'tldraw'
import { parametersHeight } from './GraphShapeUtil'
import { clampParameter, describeParameters, ShapeParameter, shapeParameterValidator, SliderRows } from './math/parameters'
import { MAX_DROPPED, MAX_STATE_CHARS, RateLimiter, readWidgetMessage } from './widget/bridge'
import { EXPECTED_MS, ProgressBar } from '../components/ProgressBar'
import { isWidgetJobRunning, runningWidgetJobs, widgetPreviews } from './widget/jobs'
import { buildWidgetDocument } from './widget/sandbox'

export const WIDGET_TYPE = 'widget'

export type WidgetStatus = 'writing' | 'ready' | 'failed'

export interface WidgetProps {
	w: number
	h: number
	title: string
	/** What the widget should do, as the agent asked for it. */
	brief: string
	html: string
	css: string
	js: string
	status: WidgetStatus
	/** Why writing the widget failed, for the agent and the user. */
	error: string
	params: Record<string, ShapeParameter>
	/** The widget's declared state. A widget may only set keys declared here. */
	state: Record<string, unknown>
}

declare module 'tldraw' {
	export interface TLGlobalShapePropsMap {
		[WIDGET_TYPE]: WidgetProps
	}
}

export type WidgetShape = TLShape<typeof WIDGET_TYPE>

/** The title row above the frame. */
const TITLE_BAR = 28
/** How long a running frame may go without a heartbeat before it is stopped, in milliseconds. */
const HEARTBEAT_TIMEOUT_MS = 3000
/**
 * The shortest time between two edits a frame asks for, in milliseconds: the
 * rate cap on durable changes. A drag inside the frame lands about ten times
 * a second, and stays one undo step.
 */
const FLUSH_MS = 100
/** How long after the pointer leaves a frame its changes still count as the user's, in milliseconds. */
const INPUT_GRACE_MS = 1500
/** The largest zoom step one wheel event makes, as tldraw's own wheel handling caps it. */
const MAX_ZOOM_STEP = 10
/** Changes further apart than this are separate undo steps, in milliseconds. */
const UNDO_GAP_MS = 600
/** How long a snapshot request waits for the frame, in milliseconds. */
const SNAPSHOT_TIMEOUT_MS = 1500
/** How long a frame may take to start. */
const START_TIMEOUT_MS = 6000

export function widgetChromeHeight(props: Pick<WidgetProps, 'params'>): number {
	return TITLE_BAR + parametersHeight(Object.values(props.params))
}

/** What the agent reads about a widget: what it is for, its values, and how it is doing. */
export function describeWidget(props: WidgetProps, id?: TLShapeId): string {
	if (props.status === 'writing' && id && !isWidgetJobRunning(id)) {
		props = { ...props, status: 'failed', error: 'its code was never finished, because the job stopped; send the widget again to write it' }
	}
	const params = describeParameters(Object.values(props.params))
	let state = JSON.stringify(props.state)
	if (state.length > 400) state = state.slice(0, 400) + '...'
	const status =
		props.status === 'writing'
			? 'still being written in the background'
			: props.status === 'failed'
				? `failed: ${props.error}`
				: props.error
					? `running, but ${props.error.replace(/^Its/, 'its')}`
					: 'running'
	return `Widget "${props.title}", ${status}. It shows: ${props.brief}.${params ? ` Parameters: ${params}.` : ''} State: ${state}.`
}

/**
 * Each mounted widget's way to take a snapshot, so the board's image export,
 * which the agent sees, can show what is inside the frame.
 */
const snapshots = new Map<TLShapeId, { request: () => Promise<string | null>; last: string | null }>()

/**
 * A widget on the board: HTML and JavaScript the model wrote, run in a sandboxed
 * frame. The frame owns no durable state. Its parameters and state are the
 * shape's props, and every change it asks for is an ordinary edit of the shape,
 * so it is a recorded command that undo and revert handle.
 */
export class WidgetShapeUtil extends ShapeUtil<WidgetShape> {
	static override type = WIDGET_TYPE
	static override props: RecordProps<WidgetShape> = {
		w: T.number,
		h: T.number,
		title: T.string,
		brief: T.string,
		html: T.string,
		css: T.string,
		js: T.string,
		status: T.literalEnum('writing', 'ready', 'failed'),
		error: T.string,
		params: T.dict(T.string, shapeParameterValidator),
		state: T.dict(T.string, T.jsonValue) as never,
	}

	override getDefaultProps(): WidgetProps {
		return { w: 420, h: 320, title: '', brief: '', html: '', css: '', js: '', status: 'writing', error: '', params: {}, state: {} }
	}

	override getGeometry(shape: WidgetShape): Geometry2d {
		return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
	}

	override onResize(shape: WidgetShape, info: { scaleX: number; scaleY: number }) {
		const chrome = widgetChromeHeight(shape.props)
		const frame = Math.max(80, (shape.props.h - chrome) * Math.abs(info.scaleY))
		return { props: { w: Math.max(160, shape.props.w * Math.abs(info.scaleX)), h: frame + chrome } }
	}

	override getText(shape: WidgetShape) {
		return describeWidget(shape.props, shape.id)
	}

	override component(shape: WidgetShape) {
		return <Widget shape={shape} />
	}

	override getIndicatorPath(shape: WidgetShape) {
		const path = new Path2D()
		path.roundRect(0, 0, shape.props.w, shape.props.h, 6)
		return path
	}

	/** The export shows the frame's latest snapshot, so the agent sees inside it. */
	override async toSvg(shape: WidgetShape) {
		const { w, h, title } = shape.props
		const frameHeight = Math.max(40, h - widgetChromeHeight(shape.props))
		const entry = snapshots.get(shape.id)
		let image: string | null = null
		if (entry) {
			image = (await entry.request()) ?? entry.last
		}
		return (
			<g>
				<rect width={w} height={h} rx={6} fill="#fffdf8" stroke="#d8d2c4" />
				<text x={10} y={19} fontSize={14} fontStyle="italic" fontFamily="Georgia, serif" fill="#302f2a">
					{title}
				</text>
				{image ? (
					<image href={image} x={0} y={TITLE_BAR} width={w} height={frameHeight} preserveAspectRatio="xMidYMid meet" />
				) : (
					<text x={w / 2} y={TITLE_BAR + frameHeight / 2} fontSize={13} textAnchor="middle" fill="#8a8578">
						{shape.props.status === 'writing' ? 'Writing the widget...' : 'Widget'}
					</text>
				)}
			</g>
		)
	}
}

type Phase = { kind: 'starting' } | { kind: 'running' } | { kind: 'stopped'; reason: string }

function Widget({ shape }: { shape: WidgetShape }) {
	const editor = useEditor()
	const { w, h, title, status, params } = shape.props
	const parameters = Object.values(params)
	const jobStartedAt = useValue('widget job started', () => runningWidgetJobs.get().get(shape.id)?.startedAt ?? null, [shape.id])
	const jobRunning = jobStartedAt !== null
	const preview = useValue('widget preview', () => widgetPreviews.get().get(shape.id) ?? null, [shape.id])
	const frameHeight = Math.max(40, h - widgetChromeHeight(shape.props))
	// The frame takes the pointer whenever the select tool is on, so a first
	// press on a control works the control. The title bar is the move handle.
	// With a drawing tool on, the pointer goes to the board, so a stroke can
	// cross a widget.
	const interactive = useValue('widget interactive', () => editor.getCurrentToolId() === 'select', [editor])

	const setParam = (name: string, value: number) => {
		const current = editor.getShape<WidgetShape>(shape.id)
		const p = current?.props.params[name]
		if (!current || !p || editor.getIsReadonly()) return
		const next = clampParameter(p, value)
		if (next === p.value) return
		editor.updateShape<WidgetShape>({
			id: shape.id,
			type: WIDGET_TYPE,
			props: { params: { ...current.props.params, [name]: { ...p, value: next } } },
		})
	}

	return (
		<HTMLContainer className="graph-container widget-container">
			<div className="graph-sheet" style={{ width: w, height: h }}>
				<div className="widget-title" style={{ height: TITLE_BAR }}>
					{title}
				</div>
				<div className="widget-frame" style={{ height: frameHeight }}>
					{status === 'ready' ? (
						<WidgetFrame shape={shape} height={frameHeight} interactive={interactive} />
					) : status === 'writing' && jobRunning && preview ? (
						<WidgetPreview shape={shape} preview={preview} height={frameHeight} />
					) : (
						<div className="widget-placeholder">
							{status === 'writing' && jobRunning ? (
								<>
									<div className="widget-placeholder-head">Writing the widget</div>
									<div className="widget-placeholder-brief">{shape.props.brief}</div>
								</>
							) : (
								<>
									<div className="widget-placeholder-head">This widget could not be written</div>
									<div className="widget-placeholder-brief">
										{status === 'writing' ? 'Its code was never finished. Ask the agent to write it again.' : shape.props.error}
									</div>
								</>
							)}
						</div>
					)}
					{status === 'writing' && jobStartedAt !== null ? (
						<ProgressBar variant="edge" label="Writing the widget" runKey={jobStartedAt} estimate={{ startedAt: jobStartedAt, expectedMs: EXPECTED_MS.widget }} />
					) : null}
				</div>
				<SliderRows parameters={parameters} onSet={setParam} />
			</div>
		</HTMLContainer>
	)
}

/**
 * The layout of a widget whose script is still being written: its html and
 * css in the same sandbox, with no script, under a note that it is not ready.
 */
function WidgetPreview({ shape, preview, height }: { shape: WidgetShape; preview: { html: string; css: string }; height: number }) {
	const built = useMemo(() => buildWidgetDocument({ html: preview.html, css: preview.css, js: '' }, { params: {}, state: {} }), [preview.html, preview.css])
	if ('error' in built) return null
	return (
		<>
			<iframe
				title={`${shape.props.title || 'Widget'} (preview)`}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				allow=""
				srcDoc={built.doc}
				style={{ width: '100%', height, border: 0, display: 'block', pointerEvents: 'none', opacity: 0.5 }}
			/>
			<div className="widget-writing-badge">
				<span className="chat-working-dots" aria-hidden>
					<span />
					<span />
					<span />
				</span>
				Writing the script
			</div>
		</>
	)
}

function WidgetFrame({ shape, height, interactive }: { shape: WidgetShape; height: number; interactive: boolean }) {
	const editor = useEditor()
	const frameRef = useRef<HTMLIFrameElement>(null)
	// The runtime sends a change only from a trusted input event. The board
	// also checks that the user is at this frame: the pointer is over it, has
	// just left it, or the frame has keyboard focus. Anything else, such as a
	// timer or a frame reacting to the agent's change, is never the user's.
	const pointerOver = useRef(false)
	const pointerLeftAt = useRef(0)
	const userAtFrame = () =>
		pointerOver.current ||
		performance.now() - pointerLeftAt.current < INPUT_GRACE_MS ||
		(!!frameRef.current && document.activeElement === frameRef.current)
	const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
	const [restarts, setRestarts] = useState(0)
	const [scriptError, setScriptError] = useState<string | null>(null)
	const { html, css, js, params, state } = shape.props

	const values = useMemo(
		() => ({ params: Object.fromEntries(Object.values(params).map((p) => [p.name, p.value])), state }),
		[params, state]
	)
	const valuesRef = useRef(values)
	valuesRef.current = values

	// The document is built only when the code changes or the user restarts it,
	// never on a value change, so the frame keeps running as values arrive.
	const built = useMemo(
		() => buildWidgetDocument({ html, css, js }, valuesRef.current),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[html, css, js, restarts]
	)

	const stop = (reason: string) => setPhase((p) => (p.kind === 'stopped' ? p : { kind: 'stopped', reason }))
	const post = (message: unknown) => frameRef.current?.contentWindow?.postMessage(message, '*')

	// Board keys pressed inside the frame do what they do on the board.
	const onBoardKey = (k: { key: string; ctrl: boolean; meta: boolean; shift: boolean }) => {
		const mod = k.ctrl || k.meta
		const key = k.key.toLowerCase()
		if (mod && (key === 'z' || key === 'y')) {
			if (key === 'y' || k.shift) editor.redo()
			else editor.undo()
			return
		}
		if (k.key === 'Escape') {
			frameRef.current?.blur()
			editor.focus()
			if (editor.getSelectedShapeIds().includes(shape.id)) editor.selectNone()
			return
		}
		if (k.key === 'Delete' || k.key === 'Backspace') {
			const selected = editor.getSelectedShapeIds()
			if (!selected.length || editor.getIsReadonly()) return
			frameRef.current?.blur()
			editor.focus()
			editor.deleteShapes(selected)
		}
	}
	// A wheel the widget did not use pans or zooms the board, at the pointer.
	const onBoardWheel = (w: { dx: number; dy: number; x: number; y: number; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }) => {
		const frame = frameRef.current
		if (!frame) return
		const rect = frame.getBoundingClientRect()
		const k = frame.clientWidth ? rect.width / frame.clientWidth : 1
		let { dx, dy } = w
		let dz = 0
		const isMac = /mac/i.test(navigator.platform)
		if (w.ctrl || w.alt || w.meta) dz = (Math.abs(dy) > MAX_ZOOM_STEP ? MAX_ZOOM_STEP * Math.sign(dy) : dy) / 100
		else if (w.shift && !isMac) {
			dx = dy
			dy = 0
		}
		if (!dx && !dy && !dz) return
		editor.dispatch({
			type: 'wheel',
			name: 'wheel',
			delta: { x: -dx * k, y: -dy * k, z: -dz },
			point: new Vec(rect.left + w.x * k, rect.top + w.y * k),
			shiftKey: w.shift,
			altKey: w.alt,
			ctrlKey: w.meta || w.ctrl,
			metaKey: w.meta,
			accelKey: isMac ? w.meta : w.ctrl,
		})
	}

	// Messages from the frame: checked, rate capped, then applied as edits of the shape.
	const lastBeat = useRef(performance.now())
	const lastEditAt = useRef(0)
	const pendingSnapshots = useRef(new Map<string, (url: string | null) => void>())
	useEffect(() => {
		if (phase.kind === 'stopped') return
		const limiter = new RateLimiter()
		// Changes the frame asks for are batched, at most one edit of the shape per
		// interval, so a widget that sets values on every frame does not flood the
		// board's history.
		const pending: { params: Record<string, number>; state: Record<string, unknown> } = { params: {}, state: {} }
		let flushTimer: ReturnType<typeof setTimeout> | null = null
		const scheduleFlush = () => {
			flushTimer ??= setTimeout(flush, FLUSH_MS)
		}
		const flush = () => {
			flushTimer = null
			const current = editor.getShape<WidgetShape>(shape.id)
			const { params: asked, state: askedState } = pending
			pending.params = {}
			pending.state = {}
			if (!current || editor.getIsReadonly()) return
			const params = { ...current.props.params }
			let changed = false
			for (const [name, value] of Object.entries(asked)) {
				if (!Object.hasOwn(params, name)) continue
				const p = params[name]
				const next = clampParameter(p, value)
				if (next === p.value) continue
				params[name] = { ...p, value: next }
				changed = true
			}
			const state = { ...current.props.state }
			for (const [key, value] of Object.entries(askedState)) {
				// A widget may set only the state it declared.
				if (!Object.hasOwn(state, key)) {
					console.warn(`Widget ${shape.id} tried to set undeclared state "${key}".`)
					continue
				}
				if (JSON.stringify(state[key]) === JSON.stringify(value)) continue
				state[key] = value
				changed = true
			}
			if (!changed) return
			if (JSON.stringify(state).length > MAX_STATE_CHARS) {
				console.warn(`Widget ${shape.id} state would pass ${MAX_STATE_CHARS} characters.`)
				return
			}
			// One undo step per burst of changes, such as one drag inside the frame.
			const now = performance.now()
			if (now - lastEditAt.current > UNDO_GAP_MS) editor.markHistoryStoppingPoint('widget change')
			lastEditAt.current = now
			editor.updateShape<WidgetShape>({ id: shape.id, type: WIDGET_TYPE, props: { params, state } })
		}
		const onMessage = (event: MessageEvent) => {
			if (!frameRef.current || event.source !== frameRef.current.contentWindow) return
			if (!limiter.take()) {
				if (limiter.dropped > MAX_DROPPED) stop('It sent too many messages.')
				return
			}
			const read = readWidgetMessage(event.data)
			if ('refused' in read) {
				console.warn(`Widget ${shape.id} message refused: ${read.refused}`)
				return
			}
			const message = read.message
			lastBeat.current = performance.now()
			switch (message.type) {
				case 'ready':
					setPhase({ kind: 'running' })
					post({ type: 'values', ...valuesRef.current })
					break
				case 'heartbeat':
					break
				case 'set-param':
					if (!userAtFrame()) return
					pending.params[message.name] = message.value
					scheduleFlush()
					break
				case 'set-state':
					if (!userAtFrame()) return
					pending.state[message.key] = message.value
					scheduleFlush()
					break
				case 'press':
					// A press inside a widget selects it, as a press on any shape does.
					if (editor.getOnlySelectedShapeId() !== shape.id && editor.getCurrentToolId() === 'select') editor.select(shape.id)
					break
				case 'key':
					onBoardKey(message)
					break
				case 'wheel':
					onBoardWheel(message)
					break
				case 'smoke':
					break
				case 'snapshot': {
					const resolve = pendingSnapshots.current.get(message.id)
					pendingSnapshots.current.delete(message.id)
					resolve?.(message.dataUrl)
					break
				}
				case 'error':
					if (message.kind === 'loop') stop(message.message)
					else setScriptError(message.message)
					break
			}
		}
		window.addEventListener('message', onMessage)
		return () => {
			window.removeEventListener('message', onMessage)
			// Changes asked for just before the frame's phase changed still land.
			if (flushTimer) {
				clearTimeout(flushTimer)
				flush()
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [phase.kind, shape.id, editor])

	// New values go to the running frame.
	useEffect(() => {
		if (phase.kind === 'running') post({ type: 'values', ...values })
	}, [values, phase.kind])

	// The watchdog: a frame that stops sending heartbeats is stopped. Where the
	// frame has its own process, this ends a loop the guard did not catch.
	useEffect(() => {
		if (phase.kind === 'stopped') return
		const startedAt = performance.now()
		lastBeat.current = startedAt
		// A hidden tab throttles timers in the frame, so the watchdog waits for it.
		const onVisible = () => {
			lastBeat.current = performance.now()
		}
		document.addEventListener('visibilitychange', onVisible)
		const timer = setInterval(() => {
			if (document.hidden) return
			const now = performance.now()
			if (phase.kind === 'starting' && now - startedAt > START_TIMEOUT_MS) stop('It did not start.')
			if (phase.kind === 'running' && now - lastBeat.current > HEARTBEAT_TIMEOUT_MS) stop('It stopped responding.')
		}, 500)
		return () => {
			clearInterval(timer)
			document.removeEventListener('visibilitychange', onVisible)
		}
	}, [phase.kind, restarts])

	// Snapshots for the board's image export.
	useEffect(() => {
		const entry = {
			last: snapshots.get(shape.id)?.last ?? null,
			request: () =>
				new Promise<string | null>((resolve) => {
					if (!frameRef.current?.contentWindow) return resolve(null)
					const id = crypto.randomUUID()
					// A frame that never answers does not keep its request forever.
					const timeout = setTimeout(() => {
						pendingSnapshots.current.delete(id)
						resolve(null)
					}, SNAPSHOT_TIMEOUT_MS)
					pendingSnapshots.current.set(id, (url) => {
						clearTimeout(timeout)
						if (url && url.length > 'data:image/png;base64,'.length + 100) entry.last = url
						resolve(url)
					})
					post({ type: 'snapshot-request', id })
				}),
		}
		snapshots.set(shape.id, entry)
		return () => {
			if (snapshots.get(shape.id) === entry) snapshots.delete(shape.id)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [shape.id])

	// A frame that loads a second page navigated away from its own document.
	const loads = useRef(0)
	useEffect(() => {
		loads.current = 0
	}, [built, restarts])

	if ('error' in built) {
		return <div className="widget-placeholder"><div className="widget-placeholder-head">This widget could not run</div><div className="widget-placeholder-brief">{built.error}</div></div>
	}
	if (phase.kind === 'stopped') {
		return (
			<div className="widget-placeholder">
				<div className="widget-placeholder-head">This widget was stopped</div>
				<div className="widget-placeholder-brief">{phase.reason}</div>
				<button
					className="widget-restart"
					onPointerDown={(e) => e.stopPropagation()}
					onClick={() => {
						setScriptError(null)
						setPhase({ kind: 'starting' })
						setRestarts((n) => n + 1)
					}}
				>
					Restart
				</button>
			</div>
		)
	}
	return (
		<>
			<iframe
				key={restarts}
				ref={frameRef}
				title={shape.props.title || 'Widget'}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				allow=""
				srcDoc={built.doc}
				style={{ width: '100%', height, border: 0, display: 'block', pointerEvents: interactive ? 'all' : 'none' }}
				onPointerEnter={() => (pointerOver.current = true)}
				onPointerLeave={() => {
					pointerOver.current = false
					pointerLeftAt.current = performance.now()
				}}
				onLoad={() => {
					loads.current++
					if (loads.current > 1) stop('It tried to leave its own page.')
				}}
			/>
			{scriptError && <div className="widget-error">{scriptError}</div>}
		</>
	)
}
