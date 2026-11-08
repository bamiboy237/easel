import { Box, clamp, TLShapeId } from 'tldraw'
import { ClearSpacePart } from '../../shared/schema/PromptPartDefinitions'
import { AgentRequest } from '../../shared/types/AgentRequest'
import { findClearSpaceBeside, findClearSpaceForNewWork, findNoteSpot } from '../agent/findClearSpace'
import { AgentHelpers } from '../AgentHelpers'
import { PromptPartUtil, registerPromptPartUtil } from './PromptPartUtil'

const DEFAULT_SIZE = { w: 640, h: 480 }
/** Room for a short answer about a small selection: a few lines and a small figure or formula. */
const ANSWER_SIZE = { w: 420, h: 240 }

/**
 * Where new work fits. For a request about selected shapes or context, that is
 * clear space beside them. Otherwise it is clear space in the user's view.
 * Follow-up passes and frame fills already know where they work.
 */
export const ClearSpacePartUtil = registerPromptPartUtil(
	class ClearSpacePartUtil extends PromptPartUtil<ClearSpacePart> {
		static override type = 'clearSpace' as const

		override getPart(request: AgentRequest, helpers: AgentHelpers): ClearSpacePart {
			const { editor } = this
			// Follow-up passes know where they work, and an aside has its own space.
			if (request.source === 'self' || this.agent.aside.getActive()) {
				return { type: 'clearSpace', near: 'view', space: null }
			}

			const subjectIds = new Set<TLShapeId>(editor.getSelectedShapeIds())
			const areas: Box[] = []
			for (const item of request.contextItems) {
				if (item.type === 'shape') subjectIds.add(`shape:${item.shape.shapeId}` as TLShapeId)
				if (item.type === 'shapes') for (const shape of item.shapes) subjectIds.add(`shape:${shape.shapeId}` as TLShapeId)
				if (item.type === 'area') areas.push(Box.From(item.bounds))
			}
			const boxes = [...subjectIds].map((id) => editor.getShapePageBounds(id)).filter((b): b is Box => !!b)
			const subject = boxes.length + areas.length > 0 ? Box.Common([...boxes, ...areas]) : null

			let space: Box | null = null
			if (subject) {
				// A small selection, such as one line of an equation, gets an answer the
				// size of a short note, in the nearest clear space on any side, scored by
				// how far the eye travels from the selection to it, as threads are placed.
				// Its own frame's empty space counts. A larger subject gets room beside it
				// as big as itself.
				const small = subject.w <= 600 && subject.h <= 400
				const size = small ? ANSWER_SIZE : { w: clamp(subject.w, 400, 900), h: clamp(subject.h, 300, 800) }
				space = (small ? findNoteSpot(editor, subject, size) : null) ?? findClearSpaceBeside(editor, subject, size)
			} else {
				space = findClearSpaceForNewWork(editor, DEFAULT_SIZE)
			}
			return {
				type: 'clearSpace',
				near: subject ? 'subject' : 'view',
				space: space ? helpers.roundBox(helpers.applyOffsetToBox(space)) : null,
			}
		}
	}
)
