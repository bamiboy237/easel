import { TLShapeId } from 'tldraw'
import type { TldrawAgent } from '../../agent/TldrawAgent'
import { WIDGET_TYPE, widgetChromeHeight, WidgetShape } from '../WidgetShapeUtil'
import { runningWidgetJobs } from './jobs'
import { guardLoops } from './sandbox'

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
	runningWidgetJobs.get().get(id)?.abort()
	const controller = new AbortController()
	runningWidgetJobs.update((jobs) => new Map(jobs).set(id, controller))
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
			const body = (await response.json()) as { html?: string; css?: string; js?: string; error?: string }
			if (!response.ok || body.error) {
				outcome = { error: body.error ?? `The writer returned ${response.status}.` }
				continue
			}
			const code = { html: body.html ?? '', css: body.css ?? '', js: body.js ?? '' }
			const guarded = guardLoops(code.js)
			if ('error' in guarded) {
				outcome = guarded
				request.problem = guarded.error
				continue
			}
			outcome = code
			break
		} catch (error) {
			if (controller.signal.aborted) return
			outcome = { error: (error as Error).message }
		}
	}

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
