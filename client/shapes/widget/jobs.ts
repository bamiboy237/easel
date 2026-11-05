import { atom, TLShapeId } from 'tldraw'

/**
 * The widgets whose code is being written now. Jobs live only in this page,
 * so a widget still marked as writing with no job here was left behind, by a
 * reload or a cancel, and shows that instead of waiting forever.
 */
export const runningWidgetJobs = atom<ReadonlyMap<TLShapeId, AbortController>>('running widget jobs', new Map())

export function isWidgetJobRunning(id: TLShapeId): boolean {
	return runningWidgetJobs.get().has(id)
}

/** Stop every widget job, as when the user stops the agent. */
export function cancelWidgetJobs() {
	for (const controller of runningWidgetJobs.get().values()) controller.abort()
	runningWidgetJobs.set(new Map())
}
