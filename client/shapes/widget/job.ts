import { TLShapeId } from 'tldraw'
import type { TldrawAgent } from '../../agent/TldrawAgent'
import { WIDGET_TYPE, WidgetShape } from '../WidgetShapeUtil'
import { guardLoops } from './sandbox'

/** The latest job for each widget. A newer brief replaces an older job's result. */
const jobs = new Map<TLShapeId, string>()

/** How many times the job asks again when the code does not parse. */
const RETRIES = 1

/**
 * Write a widget's code in the background, like a render job: the agent goes on
 * while the placeholder shows. The finished code lands as one agent command,
 * based on the board as it was when the job started, so it is stale only if
 * the user changed the widget's code fields meanwhile, and revert undoes it.
 */
export async function runWidgetJob(agent: TldrawAgent, id: TLShapeId): Promise<void> {
	const { editor } = agent
	const shape = editor.getShape<WidgetShape>(id)
	if (!shape || shape.type !== WIDGET_TYPE) return
	const token = crypto.randomUUID()
	jobs.set(id, token)
	const baseRev = agent.commands.getRev()
	const { title, brief, w, h, params, state } = shape.props
	const request = {
		modelName: agent.modelName.getModelName(),
		title,
		brief,
		width: w,
		height: h - 28,
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
			outcome = { error: (error as Error).message }
		}
	}

	// A newer job, or a deleted widget, takes this result's place.
	if (jobs.get(id) !== token) return
	jobs.delete(id)
	if (!editor.getShape(id)) return
	const props = 'error' in outcome ? { status: 'failed' as const, error: outcome.error } : { ...outcome, status: 'ready' as const, error: '' }
	const result = agent.commands.execute(
		'agent',
		'widget',
		() => editor.updateShape<WidgetShape>({ id, type: WIDGET_TYPE, props }),
		{ baseRev, allowedShapeIds: new Set([id]) }
	)
	if (result.status === 'rejected') console.warn(`Widget ${id} code not placed: ${result.reason}.`)
}
