import { IRequest } from 'itty-router'
import { AgentService, WidgetRequest } from '../do/AgentService'
import { Environment } from '../environment'

/** Write a widget's code in the background, from the brief the agent gave. */
export async function writeWidget(request: IRequest, env: Environment) {
	let body: WidgetRequest
	try {
		body = (await request.json()) as WidgetRequest
	} catch {
		return Response.json({ error: 'The request was not JSON.' }, { status: 400 })
	}
	try {
		const code = await new AgentService(env).writeWidget(body)
		return Response.json(code)
	} catch (error) {
		console.error('Widget error:', error)
		return Response.json({ error: (error as Error).message ?? String(error) }, { status: 500 })
	}
}
