import { IRequest } from 'itty-router'
import { WIDGET_STREAM_ERROR } from '../../shared/widgetCode'
import { AgentService, WidgetRequest } from '../do/AgentService'
import { Environment } from '../environment'

/**
 * Write a widget's code in the background, from the brief the agent gave. The
 * reply is the model's text as it is written, so the board can show the
 * layout early. An error after the stream starts ends it with a marked line.
 */
export async function writeWidget(request: IRequest, env: Environment) {
	let body: WidgetRequest
	try {
		body = (await request.json()) as WidgetRequest
	} catch {
		return new Response('The request was not JSON.', { status: 400 })
	}
	const encoder = new TextEncoder()
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const chunk of new AgentService(env).streamWidget(body)) controller.enqueue(encoder.encode(chunk))
			} catch (error) {
				console.error('Widget error:', error)
				controller.enqueue(encoder.encode(`${WIDGET_STREAM_ERROR}${(error as Error).message ?? String(error)}`))
			}
			controller.close()
		},
	})
	return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' } })
}
