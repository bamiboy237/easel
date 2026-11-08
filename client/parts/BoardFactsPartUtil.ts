import { BoardFactsPart } from '../../shared/schema/PromptPartDefinitions'
import { getBoardFacts } from '../agent/boardFacts'
import { PromptPartUtil, registerPromptPartUtil } from './PromptPartUtil'

/**
 * The values, units, and names the board already settles, so new work reuses
 * them, and the live sliders, so notes name them instead of quoting values
 * that go stale.
 */
export const BoardFactsPartUtil = registerPromptPartUtil(
	class BoardFactsPartUtil extends PromptPartUtil<BoardFactsPart> {
		static override type = 'boardFacts' as const

		override getPart(): BoardFactsPart {
			return { type: 'boardFacts', ...getBoardFacts(this.editor) }
		}
	}
)
