import { typesetText } from '../../shared/format/typesetText'
import { TLShapeId } from 'tldraw'
import { ReplyInThreadAction } from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { AgentHelpers } from '../AgentHelpers'
import { findNoteSpot, getUsableViewBounds, overlapsShapes } from '../agent/findClearSpace'
import { getThreadOwnIds, measureThreadHeight, THREAD_TYPE, ThreadShape } from '../shapes/ThreadShapeUtil'
import { Box } from 'tldraw'
import { getCameraFollow } from '../voice/follow'
import { AgentActionUtil, registerActionUtil } from './AgentActionUtil'

/** The agent answers a mark in its thread, on the board beside the mark. */
export const ReplyInThreadActionUtil = registerActionUtil(
	class ReplyInThreadActionUtil extends AgentActionUtil<ReplyInThreadAction> {
		static override type = 'reply_in_thread' as const

		override getInfo(action: Streaming<ReplyInThreadAction>) {
			return {
				icon: 'comment' as const,
				description: action.text ?? null,
				canGroup: () => false,
			}
		}

		override sanitizeAction(action: Streaming<ReplyInThreadAction>, helpers: AgentHelpers) {
			if (!action.complete) return action
			const id = helpers.ensureShapeIdExists(action.thread as never)
			if (!id) return null
			return { ...action, thread: id }
		}

		override applyAction(action: Streaming<ReplyInThreadAction>) {
			const { editor } = this.agent
			if (!action.text) return
			// The model may write the text before the thread ID, and a half-written ID
			// names no shape. Until the ID names a thread, the answer streams onto the
			// thread this mark question belongs to.
			const named = action.thread ? editor.getShape<ThreadShape>(`shape:${action.thread}` as TLShapeId) : undefined
			const fallback = this.agent.marks.getActive()?.threadId
			const thread =
				named?.type === THREAD_TYPE ? named : fallback ? editor.getShape<ThreadShape>(fallback as TLShapeId) : undefined
			if (!thread || thread.type !== THREAD_TYPE) return
			const id = thread.id
			// The answer streams onto the note as it is written. Each partial version
			// replaces the last; only the finished answer is recorded.
			const entries = [...thread.props.entries, { author: 'agent' as const, text: typesetText(action.complete ? action.text.trim() : action.text) }]
			if (!action.complete) {
				editor.updateShape<ThreadShape>({ id, type: THREAD_TYPE, props: { entries } })
				return
			}
			// A longer note must not grow over other work, or out of view when it
			// started in view. If it would, it moves to the next clear spot beside its mark.
			const h = measureThreadHeight(editor, entries)
			const page = editor.getShapePageBounds(id)!
			const grown = new Box(page.x, page.y, thread.props.w, h)
			const own = getThreadOwnIds(editor, thread)
			const view = getUsableViewBounds(editor)
			let position = { x: thread.x, y: thread.y }
			if (overlapsShapes(editor, grown, own) || (view.contains(page) && !view.contains(grown))) {
				const markId = thread.props.markShapeId as TLShapeId
				const subject = (markId && editor.getShapePageBounds(markId)) || editor.getShapePageBounds(id)!
				const spot = findNoteSpot(editor, subject, { w: thread.props.w, h }, own)
				// The spot is on the page; the thread stores its place in its parent's space.
				if (spot) {
					const local = editor.getPointInParentSpace(id, { x: spot.x, y: spot.y })
					position = { x: local.x, y: local.y }
				}
			}
			editor.updateShape<ThreadShape>({ id, type: THREAD_TYPE, ...position, props: { entries } })
			// The answer is to what the user is looking at: when the finished note sits
			// out of view, the camera glides to show it with its mark, unless the user
			// is working. It moves after this step is applied, so it is not a command.
			const markId = thread.props.markShapeId as TLShapeId
			setTimeout(() => {
				// A reply rejected as stale or protected was rolled back: there is nothing to show.
				const current = editor.getShape<ThreadShape>(id)
				if (!current || JSON.stringify(current.props.entries) !== JSON.stringify(entries)) return
				const note = editor.getShapePageBounds(id)
				if (!note) return
				const mark = (markId && editor.getShapePageBounds(markId)) || null
				getCameraFollow(editor).revealWithAnchor(note, mark)
			}, 0)
		}
	}
)
