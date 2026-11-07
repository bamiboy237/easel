import { useEffect, useRef, useState } from 'react'
import {
	Geometry2d,
	HTMLContainer,
	Rectangle2d,
	RecordProps,
	ShapeUtil,
	T,
	TLShape,
	TLShapeId,
	useValue,
} from 'tldraw'
import { ProgressBar } from '../components/ProgressBar'
import { cancelVideoJob, freshVideos, isVideoJobRunning, runningVideoJobs, videoJobProgress } from './video/jobs'
import type { AnimationPhase } from './video/pipeline'

/** tldraw has its own `video` shape, for files the user drops, so this one has its own type. */
export const VIDEO_TYPE = 'animation'

export type VideoStatus = 'rendering' | 'ready' | 'failed'

export interface VideoProps {
	w: number
	h: number
	title: string
	/** What the animation should show, as the agent asked for it. */
	brief: string
	status: VideoStatus
	/** Why making the animation failed, for the agent and the user. */
	error: string
	/** The Manim scene the video was rendered from. */
	source: string
	/** The render's cache key: the render service serves its video and poster under it. */
	renderKey: string
	/** The video's length in seconds. */
	duration: number
}

declare module 'tldraw' {
	export interface TLGlobalShapePropsMap {
		[VIDEO_TYPE]: VideoProps
	}
}

export type VideoShape = TLShape<typeof VIDEO_TYPE>

/** The title row above the video. */
const TITLE_BAR = 28
/** The controls row under it. */
const CONTROLS_BAR = 32
/** Renders are 16:9. */
const ASPECT = 9 / 16

export function videoHeightForWidth(w: number) {
	return TITLE_BAR + Math.round(w * ASPECT) + CONTROLS_BAR
}

export function videoUrl(key: string) {
	return `/render/files/${key}/video.mp4`
}

export function posterUrl(key: string) {
	return `/render/files/${key}/poster.png`
}

const PHASE_LABELS: Record<AnimationPhase, string> = {
	writing: 'Writing the animation',
	checking: 'Checking the layout',
	fixing: 'Fixing the layout',
	rendering: 'Rendering the video',
}

/** What the agent reads about an animation: what it shows and how it is doing. */
export function describeVideo(props: VideoProps, id?: TLShapeId): string {
	let status: string
	if (props.status === 'rendering') {
		status = id && !isVideoJobRunning(id) ? 'stopped before it finished; send render_animation again with its shapeId to make it' : 'still being made in the background'
	} else if (props.status === 'failed') status = `failed: ${props.error}`
	else status = `a ${props.duration} second video on the board`
	return `Animation "${props.title}", ${status}. It shows: ${props.brief}.`
}

/**
 * An animation on the board: a Manim video from the local render service. While
 * it is made, the shape shows the scene taking shape, with its progress and a
 * stop button. The video plays here with quiet controls; playback is each
 * viewer's own, never a command.
 */
export class VideoShapeUtil extends ShapeUtil<VideoShape> {
	static override type = VIDEO_TYPE
	static override props: RecordProps<VideoShape> = {
		w: T.number,
		h: T.number,
		title: T.string,
		brief: T.string,
		status: T.literalEnum('rendering', 'ready', 'failed'),
		error: T.string,
		source: T.string,
		renderKey: T.string,
		duration: T.number,
	}

	override getDefaultProps(): VideoProps {
		return { w: 640, h: videoHeightForWidth(640), title: '', brief: '', status: 'rendering', error: '', source: '', renderKey: '', duration: 0 }
	}

	override getGeometry(shape: VideoShape): Geometry2d {
		return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
	}

	override canResize() {
		return true
	}

	override isAspectRatioLocked() {
		return true
	}

	override onResize(shape: VideoShape, info: { scaleX: number }) {
		const w = Math.max(240, Math.min(1600, shape.props.w * Math.abs(info.scaleX)))
		return { props: { w, h: videoHeightForWidth(w) } }
	}

	override getText(shape: VideoShape) {
		return describeVideo(shape.props, shape.id)
	}

	override component(shape: VideoShape) {
		return <Video shape={shape} />
	}

	override getIndicatorPath(shape: VideoShape) {
		const path = new Path2D()
		path.roundRect(0, 0, shape.props.w, shape.props.h, 6)
		return path
	}

	/** The export shows the poster, the video's last frame, so the agent sees what it shows. */
	override async toSvg(shape: VideoShape) {
		const { w, h, title, status, renderKey } = shape.props
		const area = h - TITLE_BAR - CONTROLS_BAR
		let image: string | null = null
		if (status === 'ready' && renderKey) image = await toDataUrl(posterUrl(renderKey))
		if (!image && status === 'rendering') {
			const frame = runningVideoJobs.get().get(shape.id)?.progress.frame
			if (frame) image = await toDataUrl(frame)
		}
		return (
			<g>
				<rect width={w} height={h} rx={6} fill="#fffdf8" stroke="#d8d2c4" />
				<text x={10} y={19} fontSize={14} fontStyle="italic" fontFamily="Georgia, serif" fill="#302f2a">
					{title}
				</text>
				{image ? (
					<image href={image} x={0} y={TITLE_BAR} width={w} height={area} preserveAspectRatio="xMidYMid meet" />
				) : (
					<text x={w / 2} y={TITLE_BAR + area / 2} fontSize={13} textAnchor="middle" fill="#8a8578">
						{status === 'rendering' ? 'Making the animation...' : status === 'failed' ? 'The animation failed' : 'Animation'}
					</text>
				)}
			</g>
		)
	}
}

async function toDataUrl(url: string): Promise<string | null> {
	try {
		const blob = await (await fetch(url)).blob()
		return await new Promise((resolve) => {
			const reader = new FileReader()
			reader.onload = () => resolve(reader.result as string)
			reader.onerror = () => resolve(null)
			reader.readAsDataURL(blob)
		})
	} catch {
		return null
	}
}

/** Controls take their own pointer events, so using them does not move the shape. */
const keep = (e: { stopPropagation: () => void }) => e.stopPropagation()

function Video({ shape }: { shape: VideoShape }) {
	const { w, h, title, status } = shape.props
	const area = h - TITLE_BAR - CONTROLS_BAR
	const job = useValue('video job', () => runningVideoJobs.get().get(shape.id) ?? null, [shape.id])
	return (
		<HTMLContainer className="graph-container video-container">
			<div className="graph-sheet" style={{ width: w, height: h }}>
				<div className="widget-title" style={{ height: TITLE_BAR }}>
					{title}
				</div>
				{status === 'ready' && shape.props.renderKey ? (
					<Player shape={shape} height={area} />
				) : (
					<>
						<div className="widget-frame" style={{ height: area }}>
							{status === 'rendering' && job ? (
								<Making shape={shape} />
							) : (
								<div className="widget-placeholder">
									<div className="widget-placeholder-head">
										{status === 'rendering' ? 'This animation was stopped' : 'This animation could not be made'}
									</div>
									<div className="widget-placeholder-brief">
										{status === 'rendering' ? 'Ask the agent to make it again.' : shape.props.error}
									</div>
								</div>
							)}
						</div>
						<div className="video-controls" style={{ height: CONTROLS_BAR }} />
					</>
				)}
			</div>
		</HTMLContainer>
	)
}

/**
 * The placeholder while the animation is made: the scene so far, the phase,
 * the time, a stop button, and one bar for the whole job along the bottom.
 */
function Making({ shape }: { shape: VideoShape }) {
	const job = useValue('video job', () => runningVideoJobs.get().get(shape.id) ?? null, [shape.id])
	const [, tick] = useState(0)
	useEffect(() => {
		const timer = setInterval(() => tick((n) => n + 1), 1000)
		return () => clearInterval(timer)
	}, [])
	if (!job) return null
	const { phase, frame } = job.progress
	const seconds = Math.round((Date.now() - job.startedAt) / 1000)
	// The percent shows only where the bar is driven by real render frames.
	const real = (phase === 'rendering' || phase === 'fixing') && job.progress.progress > 0
	const percent = real ? Math.round(videoJobProgress(job) * 100) : null
	return (
		<div className="video-making">
			{frame ? (
				<img className="video-making-frame" src={frame} alt="" draggable={false} />
			) : (
				<div className="widget-placeholder">
					<div className="widget-placeholder-brief">{shape.props.brief}</div>
				</div>
			)}
			<div className="video-making-status">
				<span className="video-making-phase">
					<span className="chat-working-dots" aria-hidden>
						<span />
						<span />
						<span />
					</span>
					{PHASE_LABELS[phase]}
					{percent !== null ? <span className="video-making-percent">{percent}%</span> : null}
					<span className="video-making-time">{seconds} s</span>
				</span>
				<button
					className="video-stop"
					onPointerDown={keep}
					onClick={(e) => {
						keep(e)
						cancelVideoJob(shape.id)
					}}
				>
					Stop
				</button>
			</div>
			<ProgressBar variant="edge" label="Making the animation" runKey={job.startedAt} compute={(now) => videoJobProgress(job, now)} />
		</div>
	)
}

function formatTime(seconds: number) {
	const s = Math.max(0, Math.floor(seconds))
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The finished video, with play and pause, a scrubber, the time, and loop. */
function Player({ shape, height }: { shape: VideoShape; height: number }) {
	const ref = useRef<HTMLVideoElement>(null)
	const [playing, setPlaying] = useState(false)
	const [time, setTime] = useState(0)
	const [loop, setLoop] = useState(false)
	const [failed, setFailed] = useState(false)
	const { renderKey, duration } = shape.props
	const total = duration || ref.current?.duration || 0

	// A video that just landed plays once on its own.
	useEffect(() => {
		if (!freshVideos.has(shape.id)) return
		freshVideos.delete(shape.id)
		void ref.current?.play().catch(() => {})
	}, [shape.id, renderKey])

	const toggle = () => {
		const video = ref.current
		if (!video) return
		if (video.paused) {
			if (video.ended || video.currentTime >= (video.duration || total) - 0.05) video.currentTime = 0
			void video.play().catch(() => {})
		} else video.pause()
	}

	return (
		<>
			<div className="widget-frame video-frame" style={{ height }}>
				<video
					ref={ref}
					src={videoUrl(renderKey)}
					poster={posterUrl(renderKey)}
					preload="metadata"
					muted
					playsInline
					loop={loop}
					onPlay={() => setPlaying(true)}
					onPause={() => setPlaying(false)}
					onEnded={() => setPlaying(false)}
					onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
					onError={() => setFailed(true)}
					style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
				/>
				{failed ? <div className="widget-error">The video is not available. Is the render service running?</div> : null}
			</div>
			<div className="video-controls" style={{ height: CONTROLS_BAR }} onPointerDown={keep}>
				<button className="video-button" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
					{playing ? (
						<svg width="12" height="12" viewBox="0 0 12 12">
							<rect x="2" y="1.5" width="2.6" height="9" rx="0.6" fill="currentColor" />
							<rect x="7.4" y="1.5" width="2.6" height="9" rx="0.6" fill="currentColor" />
						</svg>
					) : (
						<svg width="12" height="12" viewBox="0 0 12 12">
							<path d="M3 1.6 L10.2 6 L3 10.4 Z" fill="currentColor" />
						</svg>
					)}
				</button>
				<input
					className="paper-range video-scrubber"
					type="range"
					min={0}
					max={total || 1}
					step={0.01}
					value={Math.min(time, total || 1)}
					aria-label="Position"
					onChange={(e) => {
						const video = ref.current
						if (!video) return
						video.currentTime = Number(e.currentTarget.value)
						setTime(video.currentTime)
					}}
					style={{ ['--fill' as string]: `${total ? (Math.min(time, total) / total) * 100 : 0}%` }}
				/>
				<span className="video-time">
					{formatTime(time)} / {formatTime(total)}
				</span>
				<button className={`video-button${loop ? ' video-button-on' : ''}`} aria-label="Loop" aria-pressed={loop} onClick={() => setLoop((l) => !l)}>
					<svg width="14" height="12" viewBox="0 0 14 12">
						<path d="M2.5 6 A3.5 3.5 0 0 1 6 2.5 H9.5 M8 1 L9.8 2.5 L8 4 M11.5 6 A3.5 3.5 0 0 1 8 9.5 H4.5 M6 8 L4.2 9.5 L6 11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</button>
			</div>
		</>
	)
}
