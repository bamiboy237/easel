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
	for (const controller of runningWidgetJobs.get().values()) controller.abort()
	runningWidgetJobs.set(new Map())
}
