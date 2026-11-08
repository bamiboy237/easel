import { TLShapeId } from 'tldraw'
import type { TldrawAgent } from '../../agent/TldrawAgent'
import { WIDGET_TYPE, widgetChromeHeight, WidgetShape } from '../WidgetShapeUtil'
import { closedWidgetBlocks, parseWidgetCode, WIDGET_STREAM_ERROR } from '../../../shared/widgetCode'
import { freshWidgets, runningWidgetJobs, setWidgetPreview } from './jobs'
import { guardLoops } from './sandbox'
import { smokeTestWidget } from './smoke'

/**
 * How many times the job asks again when the code does not parse, or its smoke
 * test finds a control that does nothing: the writer is told the problem once.
 */
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

	let outcome: { html: string; css: string; js: string; note?: string } | { error: string } = { error: 'No reply.' }
	// The best code that ran, kept in case the retry does worse.
	let best: { code: { html: string; css: string; js: string }; problems: string[]; fatal: boolean } | null = null
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
			let shown = false
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				text += value
				// The layout shows once its style sheet and markup are both complete,
				// faded like any work still being written. A half-written page reads
				// as broken, so nothing shows before that.
				const blocks = closedWidgetBlocks(text)
				if (!shown && blocks.css !== null && blocks.html !== null) {
					shown = true
					setWidgetPreview(id, { html: blocks.html, css: blocks.css })
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
			// Run it before it is shown: it must start cleanly, and every control must do something.
			const smoke = await smokeTestWidget(code, { params: Object.fromEntries(Object.values(params).map((p) => [p.name, p.value])), state }, { width: request.width, height: request.height })
			if (controller.signal.aborted) break
			console.info(`Widget ${id} smoke test: ${smoke.tested} controls, ${smoke.problems.length} problems.`, smoke.problems)
			if (!best || (best.fatal && !smoke.fatal) || (best.fatal === smoke.fatal && smoke.problems.length < best.problems.length)) best = { code, ...smoke }
			if (smoke.problems.length && attempt < RETRIES) {
				request.problem = `It was run and its controls were used before showing it, and this did not work:\n- ${smoke.problems.join('\n- ')}\nFix these, and keep everything else that works.`
				outcome = { error: smoke.problems[0] }
				continue
			}
			break
		} catch (error) {
			if (controller.signal.aborted) {
				setWidgetPreview(id, null)
				return
			}
			outcome = { error: (error as Error).message }
		}
	}

	if (best) {
		outcome = best.fatal
			? { error: `It was written, but it does not work: ${best.problems[0]}` }
			: { ...best.code, note: best.problems.length ? `Its smoke test found: ${best.problems.join(' ')}` : '' }
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
	const props =
		'error' in outcome
			? { status: 'failed' as const, error: outcome.error }
			: { html: outcome.html, css: outcome.css, js: outcome.js, status: 'ready' as const, error: outcome.note ?? '' }
	freshWidgets.add(id)
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
