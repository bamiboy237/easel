import { TLShapeId } from 'tldraw'
import { ClaimUserShapesAction } from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { AgentActionUtil, registerActionUtil } from './AgentActionUtil'

/** Lower case, plain quotes, single spaces, and no punctuation at the ends. */
export function normalizeQuote(text: string): string {
	return text
		.toLowerCase()
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[\s"'.,!?;:]+|[\s"'.,!?;:]+$/g, '')
}

/** The shortest quote that can count as the user asking for a change. */
const MIN_QUOTE_LENGTH = 6

/**
 * The agent claims user shapes that the user's message asks it to change by
 * description, such as "both sticky notes". The claim holds only when its quote
 * is the user's own words from the current request, so the agent cannot unlock
 * the user's work on its own. Claimed shapes stay open to the agent for the rest
 * of the request, including its follow-up passes.
 */
export const ClaimUserShapesActionUtil = registerActionUtil(
	class ClaimUserShapesActionUtil extends AgentActionUtil<ClaimUserShapesAction> {
		static override type = 'claim_user_shapes' as const

		/** A claim is bookkeeping: the change that follows it is what the user sees. */
		override getInfo(_action: Streaming<ClaimUserShapesAction>) {
			return { icon: 'search' as const, description: null }
		}

		override applyAction(action: Streaming<ClaimUserShapesAction>) {
			if (!action.complete) return
			const quote = normalizeQuote(action.quote ?? '')
			const userText = normalizeQuote(this.agent.getRequestUserText())
			const ids = (action.shapeIds ?? [])
				.map((id) => (id.startsWith('shape:') ? id : `shape:${id}`) as TLShapeId)
				.filter((id) => this.editor.getShape(id))

			if (quote.length < MIN_QUOTE_LENGTH || !userText.includes(quote)) {
				console.warn('Claim not granted: the quote is not in the user message.', action.quote)
				this.agent.schedule({
					agentMessages: [
						`Your claim on ${ids.length === 1 ? 'a shape' : 'shapes'} was not granted, because its quote "${action.quote ?? ''}" is not in the user's current message. Claim the user's shapes only when their own words ask for the change, and quote those words exactly. If the user did not ask, leave their shapes as they are and tell them what you could not change.`,
					],
					source: 'self',
				})
				return
			}
			if (ids.length === 0) return
			this.agent.allowShapeIds(ids)
		}
	}
)
