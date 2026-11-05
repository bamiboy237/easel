import { TimePart } from '../../shared/schema/PromptPartDefinitions'
import { PromptPartUtil, registerPromptPartUtil } from './PromptPartUtil'

export const TimePartUtil = registerPromptPartUtil(
	class TimePartUtil extends PromptPartUtil<TimePart> {
		static override type = 'time' as const

		override getPart(): TimePart {
			return {
				type: 'time',
				// To the minute: seconds would change the prompt on every request for no use.
				time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
			}
		}
	}
)
