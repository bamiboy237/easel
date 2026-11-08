import { atom, TLShapeId } from 'tldraw'

/**
 * The widgets whose code is being written now. Jobs live only in this page,
 * so a widget still marked as writing with no job here was left behind, by a
 * reload or a cancel, and shows that instead of waiting forever.
 */
export interface WidgetJob {
	controller: AbortController
	/** When the job started, from Date.now(), for its progress bar. */
	startedAt: number
}

export const runningWidgetJobs = atom<ReadonlyMap<TLShapeId, WidgetJob>>('running widget jobs', new Map())

export function isWidgetJobRunning(id: TLShapeId): boolean {
	return runningWidgetJobs.get().has(id)
}

/**
 * The layout of each widget whose code is still being written: its html and
 * css, shown before the script arrives. Each viewer's own, never a command.
 */
export const widgetPreviews = atom<ReadonlyMap<TLShapeId, { html: string; css: string }>>('widget previews', new Map())

export function setWidgetPreview(id: TLShapeId, preview: { html: string; css: string } | null) {
	widgetPreviews.update((all) => {
		const next = new Map(all)
		if (preview) next.set(id, preview)
		else next.delete(id)
		return next
	})
}

/** Stop every widget job, as when the user stops the agent. */
export function cancelWidgetJobs() {
	for (const job of runningWidgetJobs.get().values()) job.controller.abort()
	runningWidgetJobs.set(new Map())
}

/**
 * Widgets that landed in this page: written by a job or placed from a template
 * since the page loaded. Their clocks run at once. Any other widget was
 * restored from the saved board, so its timers and animation frames wait for
 * the user's first touch, and a game does not restart by itself after a reload.
 */
export const freshWidgets = new Set<TLShapeId>()
