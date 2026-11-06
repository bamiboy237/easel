import { IRequest } from 'itty-router'
import { ANIMATION_STREAM_ERROR } from '../../shared/animationCode'
import { AgentService, AnimationRequest } from '../do/AgentService'
import { Environment } from '../environment'

/**
 * Write a Manim animation from the brief the agent gave, or check frames of a
 * render of it and fix it. The reply is the model's text as it is written; an
 * error after the stream starts ends it with a marked line.
 */
export async function writeAnimation(request: IRequest, env: Environment) {
	let body: AnimationRequest
	try {
		body = (await request.json()) as AnimationRequest
	} catch {
		return new Response('The request was not JSON.', { status: 400 })
	}
	const encoder = new TextEncoder()
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const chunk of new AgentService(env).streamAnimation(body)) controller.enqueue(encoder.encode(chunk))
			} catch (error) {
				console.error('Animation error:', error)
				controller.enqueue(encoder.encode(`${ANIMATION_STREAM_ERROR}${(error as Error).message ?? String(error)}`))
			}
			controller.close()
		},
	})
	return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' } })
}
