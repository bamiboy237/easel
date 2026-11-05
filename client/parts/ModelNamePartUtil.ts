import { DEFAULT_MODEL_NAME } from '../../shared/models'
import { ModelNamePart } from '../../shared/schema/PromptPartDefinitions'
import { AgentRequest } from '../../shared/types/AgentRequest'
import { PromptPartUtil, registerPromptPartUtil } from './PromptPartUtil'

export const ModelNamePartUtil = registerPromptPartUtil(
	class ModelNamePartUtil extends PromptPartUtil<ModelNamePart> {
		static override type = 'modelName' as const

		override getPart(request: AgentRequest): ModelNamePart {
			const effort = this.agent.reasoningEffortOverride ?? undefined
			return {
				type: 'modelName',
				modelName: this.agent.modelName.getModelName() ?? DEFAULT_MODEL_NAME,
				...(effort ? { reasoningEffort: effort } : {}),
			}
		}
	}
)
