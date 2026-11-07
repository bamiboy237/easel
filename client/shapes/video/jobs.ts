import { atom, TLShapeId } from 'tldraw'
import type { AnimationProgress } from './pipeline'
import { animationJobProgress, nextPhaseMark, PhaseMark } from './progress'

/**
 * The animations being made now, and how far each has got. Jobs live only in
 * this page, so an animation still marked as rendering with no job here was
 * left behind, by a reload or a cancel, and shows that instead of waiting.
 * Progress is each viewer's own, never a command.
 */
export interface VideoJob {
	controller: AbortController
	startedAt: number
	progress: AnimationProgress
	/** The phase the job is in, for its one progress bar. */
	mark: PhaseMark
}

export const runningVideoJobs = atom<ReadonlyMap<TLShapeId, VideoJob>>('running video jobs', new Map())

/** Animations that landed in this page, which play once on their own when they appear. */
export const freshVideos = new Set<TLShapeId>()

export function isVideoJobRunning(id: TLShapeId): boolean {
	return runningVideoJobs.get().has(id)
}

export function setVideoJob(id: TLShapeId, job: VideoJob | null) {
	runningVideoJobs.update((all) => {
		const next = new Map(all)
		if (job) next.set(id, job)
		else next.delete(id)
		return next
	})
}

/** Start a job's record, in its first phase. */
export function startVideoJob(id: TLShapeId, controller: AbortController, progress: AnimationProgress, now = Date.now()) {
	setVideoJob(id, { controller, startedAt: now, progress, mark: nextPhaseMark(null, progress.phase, 0, now) })
}

/** Record a job's progress, if the job is still the animation's current one. A new phase starts where the bar stands. */
export function reportVideoJob(id: TLShapeId, controller: AbortController, progress: AnimationProgress, now = Date.now()) {
	const job = runningVideoJobs.get().get(id)
	if (job?.controller !== controller) return
	const mark = nextPhaseMark(job.mark, progress.phase, job.progress.progress, now)
	setVideoJob(id, { ...job, progress, mark })
}

/** The job's progress across all its phases, from 0 to 1, at a moment. */
export function videoJobProgress(job: VideoJob, now = Date.now()): number {
	return animationJobProgress(job.mark, job.progress.progress, now)
}

/** Stop one animation's job, and its renders. */
export function cancelVideoJob(id: TLShapeId) {
	runningVideoJobs.get().get(id)?.controller.abort()
	setVideoJob(id, null)
}

/** Stop every animation job, as when the user stops the agent. */
export function cancelVideoJobs() {
	for (const job of runningVideoJobs.get().values()) job.controller.abort()
	runningVideoJobs.set(new Map())
}
