import { UserViewportBoundsPart } from '../../shared/schema/PromptPartDefinitions'
import { getUsableViewBounds } from '../agent/findClearSpace'
import { AgentHelpers } from '../AgentHelpers'
import { PromptPartUtil, registerPromptPartUtil } from './PromptPartUtil'

export const UserViewportBoundsPartUtil = registerPromptPartUtil(
	class UserViewportBoundsPartUtil extends PromptPartUtil<UserViewportBoundsPart> {
		static override type = 'userViewportBounds' as const

		override getPart(_request: unknown, helpers: AgentHelpers): UserViewportBoundsPart {
			// What the user can see: the viewport less the menu and toolbar strips.
			const userBounds = getUsableViewBounds(this.editor)
			const offsetUserBounds = helpers.applyOffsetToBox(userBounds)

			return {
				type: 'userViewportBounds',
				userBounds: helpers.roundBox(offsetUserBounds),
			}
		}
	}
)
