import { LoadToolsAction } from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { AgentActionUtil, registerActionUtil } from './AgentActionUtil'

/**
 * The agent loads tool groups it needs, such as the pen and the drawing guide.
 * Their schemas and guides join the prompt from the next pass on, and stay for
 * the rest of the conversation, so the agent continues in a follow-up pass.
 */
export const LoadToolsActionUtil = registerActionUtil(
	class LoadToolsActionUtil extends AgentActionUtil<LoadToolsAction> {
		static override type = 'load_tools' as const

		/** Loading tools is housekeeping, not something to show the user. */
		override getInfo(_action: Streaming<LoadToolsAction>) {
			return { icon: 'search' as const, description: null }
		}

		override applyAction(action: Streaming<LoadToolsAction>) {
			if (!action.complete) return
			const added = this.agent.toolGroups.load(action.groups ?? [])
			if (added.length === 0) return
			this.agent.schedule(
				`The ${added.join(' and ')} tools are now loaded. Continue the task: ${action.intent ?? ''}`.trim()
			)
		}
	}
)
