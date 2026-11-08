import { estimateProgress } from '../../components/ProgressBar'
import type { AnimationPhase } from './pipeline'

/**
 * One bar for a whole animation job, across its phases, so it never jumps
 * back to a low number when a new phase starts.
 *
 * Each phase owns a stretch of the bar, from where the bar stood when the
 * phase started up to the phase's end. Inside that stretch the bar is an
 * estimate that eases toward about 90% of it over the phase's expected
 * duration, or the real render progress where the phase has one, whichever is
 * further. A phase that comes back, such as a rewrite after a failed sketch,
 * starts from where the bar stands. The video landing replaces the bar.
 *
 * The expected durations are measured: see docs/design.md (Controls, Progress).
 */
export const ANIMATION_PHASES: Record<AnimationPhase, { end: number; expectedMs: number }> = {
	// The writer writes the scene, then the whole scene sketches. The first
	// sketch shows during it. Measured 39 and 43 s on the Phase 12 gate
	// (November 8, 2026), about 70 percent of the job.
	writing: { end: 0.7, expectedMs: 40000 },
	// The writer's check of the sketch, which is dropped after 15 s. Measured 9 s,
	// and 15 s for one that was dropped.
	checking: { end: 0.85, expectedMs: 10000 },
	// A fix: its sketch and its final video, side by side. Measured 8 s.
	fixing: { end: 0.95, expectedMs: 10000 },
	// The final video, with real progress from its frames. It usually ends
	// during the check: measured under 1 s left after it.
	rendering: { end: 1, expectedMs: 10000 },
}

/** The phase the job is in, when it started, where the bar stood then, and the furthest it has shown. */
export interface PhaseMark {
	phase: AnimationPhase
	at: number
	floor: number
	/** The furthest the bar has reached, so a render that starts over, such as a fix's, never pulls it back. */
	peak: number
}

/** The whole job's progress, from 0 to 1, at a moment. Below 1 until the video lands. */
export function animationJobProgress(mark: PhaseMark, renderProgress: number, now: number): number {
	const plan = ANIMATION_PHASES[mark.phase]
	const lo = Math.min(1, Math.max(0, mark.floor))
	const hi = Math.max(plan.end, lo)
	const estimate = lo + (hi - lo) * estimateProgress(now - mark.at, plan.expectedMs)
	// Render frames are real progress. In these two phases the render that runs
	// is the job's last step, so it fills the rest of the bar.
	const realPhase = mark.phase === 'rendering' || mark.phase === 'fixing'
	const real = realPhase && renderProgress > 0 ? lo + (1 - lo) * Math.min(1, renderProgress) : 0
	return Math.min(0.99, Math.max(lo, mark.peak, estimate, real))
}

/**
 * The mark for the next report, given the render progress reported before it:
 * the same phase with its peak raised, or a new phase that starts where the
 * bar stands.
 */
export function nextPhaseMark(previous: PhaseMark | null, phase: AnimationPhase, renderProgress: number, now: number): PhaseMark {
	if (!previous) return { phase, at: now, floor: 0, peak: 0 }
	const reached = animationJobProgress(previous, renderProgress, now)
	if (previous.phase === phase) return { ...previous, peak: reached }
	return { phase, at: now, floor: reached, peak: reached }
}
