import { useEffect, useRef, useState } from 'react'

/**
 * The one progress bar for work that takes time: an animation, a widget, an
 * agent request, a voice `delegate` pass. Styled by `.paper-progress` in
 * client/theme/paper.css; the rules are in docs/design.md (Controls, Progress).
 *
 * It shows real progress where the work reports it, such as render frames,
 * and an honest estimate where it does not: the bar eases toward about 90%
 * over the expected duration, and fills only when the work ends. Either way it
 * never goes backward while the same work runs.
 */

/**
 * How long work with no progress of its own usually takes, in milliseconds,
 * measured on the plan model: see docs/design.md (Controls, Progress). An
 * animation's phases are in client/shapes/video/progress.ts.
 */
export const EXPECTED_MS = {
	/** A widget's code, from the job's start until it lands. */
	widget: 35000,
	/** An agent request, typed or delegated by the voice, from start to end. */
	request: 15000,
}

/** How far an estimate goes before the work ends. */
export const ESTIMATE_CEILING = 0.9

/**
 * An estimate of progress for work that reports none: it eases toward
 * `ceiling` over `expectedMs` (about 81% at the expected duration, about 89%
 * at twice it), and never reaches it.
 */
export function estimateProgress(elapsedMs: number, expectedMs: number, ceiling = ESTIMATE_CEILING): number {
	if (!(elapsedMs > 0) || !(expectedMs > 0)) return 0
	return ceiling * (1 - Math.exp((-2.3 * elapsedMs) / expectedMs))
}

export interface ProgressEstimate {
	/** When the work started, from Date.now(). */
	startedAt: number
	/** How long such work usually takes, in milliseconds. */
	expectedMs: number
}

export interface ProgressBarProps {
	/** Real progress, from 0 to 1. Takes precedence over `estimate`. */
	value?: number | null
	/** Or an estimate, for work that reports no progress. */
	estimate?: ProgressEstimate | null
	/** A function of the clock, for work whose progress mixes both, such as an animation's phases. */
	compute?: (now: number) => number
	/** The work ended: the bar fills. */
	done?: boolean
	/** The bar starts over from 0 only when this changes. */
	runKey?: string | number
	/** The accessible name, such as "Making the animation". */
	label: string
	/** `edge` runs along the bottom of a placeholder (3 px); `inline` sits in a pill or a card (2 px). */
	variant?: 'edge' | 'inline'
	className?: string
}

function prefersReducedMotion() {
	try {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches
	} catch {
		return false
	}
}

/** Read the clock while an estimate runs: often with motion, once a second without it. */
function useClock(running: boolean) {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!running) return
		const timer = setInterval(() => setNow(Date.now()), prefersReducedMotion() ? 1000 : 200)
		return () => clearInterval(timer)
	}, [running])
	return now
}

export function ProgressBar({ value, estimate, compute, done, runKey, label, variant = 'inline', className }: ProgressBarProps) {
	const ticking = !done && value == null && (!!estimate || !!compute)
	const now = useClock(ticking)
	let next = 0
	if (done) next = 1
	else if (value != null) next = value
	else if (compute) next = compute(now)
	else if (estimate) next = estimateProgress(now - estimate.startedAt, estimate.expectedMs)
	next = Math.min(1, Math.max(0, Number.isFinite(next) ? next : 0))

	// Forward only: the same work never shows less than it showed before.
	const shown = useRef({ key: runKey, value: 0 })
	if (shown.current.key !== runKey) shown.current = { key: runKey, value: 0 }
	if (next > shown.current.value) shown.current.value = next
	const fraction = shown.current.value

	// Spans styled as blocks, so the bar is valid wherever it sits, also inside a
	// paragraph of status text (a div inside a p is invalid HTML).
	return (
		<span
			className={`paper-progress paper-progress--${variant}${className ? ` ${className}` : ''}`}
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(fraction * 100)}
			aria-valuetext={value == null && !done ? `About ${Math.round(fraction * 100)}%` : undefined}
			data-progress={fraction.toFixed(4)}
		>
			<span className="paper-progress-fill" style={{ transform: `scaleX(${fraction})` }} />
		</span>
	)
}

/**
 * True while `running`, and for a moment after, so a bar can show its work
 * finished (full) before it goes. The moment is skipped under reduced motion.
 */
export function useLingering(running: boolean, ms = 450): boolean {
	const [lingering, setLingering] = useState(false)
	const was = useRef(running)
	useEffect(() => {
		if (was.current && !running && !prefersReducedMotion()) {
			setLingering(true)
			const timer = setTimeout(() => setLingering(false), ms)
			was.current = running
			return () => clearTimeout(timer)
		}
		was.current = running
		if (running) setLingering(false)
		return undefined
	}, [running, ms])
	return running || lingering
}
