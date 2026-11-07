import { TLShapeId } from 'tldraw'
import type { TldrawAgent } from '../../agent/TldrawAgent'
import { WIDGET_TYPE, widgetChromeHeight, WidgetShape } from '../WidgetShapeUtil'
import { closedWidgetBlocks, parseWidgetCode, WIDGET_STREAM_ERROR } from '../../../shared/widgetCode'
import { runningWidgetJobs, setWidgetPreview } from './jobs'
import { guardLoops } from './sandbox'

/** How often a growing preview is redrawn, in milliseconds: each redraw reloads its frame. */
const PREVIEW_EVERY_MS = 2000

/** How many times the job asks again when the code does not parse. */
const RETRIES = 1

/**
 * Write a widget's code in the background, like a render job: the agent goes on
 * while the placeholder shows. The finished code lands as one agent command,
 * based on the board as it was when the job started, so it is stale only if
 * the user changed the widget's code fields meanwhile, and revert undoes it.
 */
export interface WidgetJobContext {
	/** The pass and request of the action that started the job, so revert and review see its command. */
	passId?: string
	requestId?: string
	/** The user shapes the request allowed the agent to change. */
	allowedShapeIds: ReadonlySet<TLShapeId>
}

export async function runWidgetJob(agent: TldrawAgent, id: TLShapeId, context: WidgetJobContext): Promise<void> {
	const { editor } = agent
	const shape = editor.getShape<WidgetShape>(id)
	if (!shape || shape.type !== WIDGET_TYPE) return
	// A newer job for the same widget replaces this one.
	runningWidgetJobs.get().get(id)?.controller.abort()
	const controller = new AbortController()
	runningWidgetJobs.update((jobs) => new Map(jobs).set(id, { controller, startedAt: Date.now() }))
	const baseRev = agent.commands.getRev()
	const { title, brief, w, h, params, state } = shape.props
	const request = {
		modelName: agent.modelName.getModelName(),
		title,
		brief,
		width: w,
		height: h - widgetChromeHeight(shape.props),
		params: Object.values(params),
		state,
		problem: undefined as string | undefined,
	}

	let outcome: { html: string; css: string; js: string } | { error: string } = { error: 'No reply.' }
	for (let attempt = 0; attempt <= RETRIES; attempt++) {
		try {
			const response = await fetch('/widget', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request),
				signal: controller.signal,
			})
			if (!response.ok || !response.body) {
				outcome = { error: (await response.text()) || `The writer returned ${response.status}.` }
				request.problem = outcome.error
				continue
			}
			// Read the reply as it is written, and show the layout as soon as its
			// html and css blocks are both closed.
			const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
			let text = ''
			let shownAt = 0
			let shownLength = 0
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				text += value
				const blocks = closedWidgetBlocks(text)
				// Once the style sheet is done, the markup shows as it arrives, a few
				// times as it grows: html without its css would read as a bare page.
				const markup = blocks.html ?? blocks.htmlSoFar
				if (blocks.css !== null && markup && markup.length > shownLength) {
					const now = performance.now()
					if (blocks.html !== null || (markup.length > 400 && now - shownAt > PREVIEW_EVERY_MS)) {
						shownAt = now
						shownLength = markup.length
						setWidgetPreview(id, { html: markup, css: blocks.css })
					}
				}
			}
			const failed = text.indexOf(WIDGET_STREAM_ERROR)
			if (failed >= 0) {
				outcome = { error: text.slice(failed + WIDGET_STREAM_ERROR.length) || 'The writer failed.' }
				// The retry is told what went wrong, so it does not repeat it.
				request.problem = outcome.error
				continue
			}
			let code: { html: string; css: string; js: string }
			try {
				code = parseWidgetCode(text)
			} catch (error) {
				outcome = { error: (error as Error).message }
				request.problem = outcome.error
				continue
			}
			const guarded = guardLoops(code.js)
			if ('error' in guarded) {
				outcome = guarded
				request.problem = guarded.error
				continue
			}
			outcome = code
			break
		} catch (error) {
			if (controller.signal.aborted) {
				setWidgetPreview(id, null)
				return
			}
			outcome = { error: (error as Error).message }
		}
	}

	setWidgetPreview(id, null)
	if (controller.signal.aborted) return
	runningWidgetJobs.update((jobs) => {
		const next = new Map(jobs)
		next.delete(id)
		return next
	})
	if (!editor.getShape(id)) return
	const options = { baseRev, allowedShapeIds: context.allowedShapeIds, passId: context.passId, requestId: context.requestId }
	const props = 'error' in outcome ? { status: 'failed' as const, error: outcome.error } : { ...outcome, status: 'ready' as const, error: '' }
	const result = agent.commands.execute('agent', 'widget', () => editor.updateShape<WidgetShape>({ id, type: WIDGET_TYPE, props }), options)
	if (result.status === 'applied') return
	// The user changed the widget meanwhile, or put it inside their own work. The
	// code is not placed, and the widget says why, if the board still allows that.
	console.warn(`Widget ${id} code not placed: ${result.reason}.`)
	const error =
		result.reason === 'stale'
			? 'The widget changed while its code was being written. Ask for it again.'
			: "The widget is now inside the user's own work, so the agent cannot fill it in. Ask for it again."
	agent.commands.execute('agent', 'widget', () => editor.updateShape<WidgetShape>({ id, type: WIDGET_TYPE, props: { status: 'failed', error } }), {
		...options,
		baseRev: agent.commands.getRev(),
	})
}
