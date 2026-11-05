import { ModePart } from '../../shared/schema/PromptPartDefinitions'
import { getPreloadedToolGroups } from '../../shared/toolGroups'
import { AgentRequest } from '../../shared/types/AgentRequest'
import { PromptPartUtil, registerPromptPartUtil } from './PromptPartUtil'

export const ModePartUtil = registerPromptPartUtil(
	class ModePartUtil extends PromptPartUtil<ModePart> {
		static override type = 'mode' as const

		override getPart(request: AgentRequest): ModePart {
			const modeDefinition = this.agent.mode.getCurrentModeDefinition()

			if (!modeDefinition.active) {
				throw new Error(`Cannot get mode part for inactive mode: ${modeDefinition.type}`)
			}

			// Load the tool groups this request plainly needs before it is sent, so
			// the agent rarely spends a pass on load_tools.
			this.agent.toolGroups.load(
				getPreloadedToolGroups({
					text: [...request.userMessages, ...request.agentMessages].join('\n'),
					selectedCount: this.editor.getSelectedShapeIds().length,
				})
			)

			return {
				type: 'mode',
				modeType: modeDefinition.type,
				partTypes: modeDefinition.parts,
				actionTypes: modeDefinition.actions,
				loadedToolGroups: this.agent.toolGroups.getLoaded(),
			}
		}
	}
)
