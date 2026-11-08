import { Box, clamp, createShapeId, TLShapeId, toRichText } from 'tldraw'
import { MapAction } from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { MapFrame } from '../agent/managers/AgentFrameFillManager'
import { AgentHelpers } from '../AgentHelpers'
import { AgentActionUtil, registerActionUtil } from './AgentActionUtil'

const FRAME_GAP = 80
const MAP_MARGIN = 200

export const MapActionUtil = registerActionUtil(
	class MapActionUtil extends AgentActionUtil<MapAction> {
		static override type = 'map' as const

		override getInfo(action: Streaming<MapAction>) {
			const titles = action.frames?.map((frame) => frame?.title).filter(Boolean) ?? []
			return {
				icon: 'pencil' as const,
				description: `**Map:** ${titles.join(' · ')}`,
			}
		}

		override sanitizeAction(action: Streaming<MapAction>, helpers: AgentHelpers) {
			if (!action.complete) return action
			for (const frame of action.frames) {
				frame.frameId = helpers.ensureShapeIdIsUnique(frame.frameId)
			}
			return action
		}

		override applyAction(action: Streaming<MapAction>, helpers: AgentHelpers) {
			if (!action.complete || action.frames.length === 0) return
			const { editor } = this

			// The row is read at a glance when the whole map is in view, so frames stay
			// narrow enough for their text to read at that zoom: three 640-wide frames
			// fit a laptop screen at about 0.7, where 22 px body text still shows at
			// about 15 px. Wide frames invite small text and long lines, and a row of
			// them can only be read one frame at a time.
			const n = action.frames.length
			const w = clamp(action.frameWidth, 480, n >= 3 ? 640 : n === 2 ? 860 : 1600)
			const h = clamp(action.frameHeight, 400, n >= 2 ? 900 : 2000)
			const origin = getMapOrigin(editor.getViewportPageBounds(), editor.getCurrentPageBounds())

			const frames: MapFrame[] = action.frames.map((frame, i) => {
				const id = `shape:${frame.frameId}` as TLShapeId
				const x = origin.x + i * (w + FRAME_GAP)
				editor.createShape({
					id,
					type: 'frame',
					x,
					y: origin.y,
					props: { w, h, name: frame.title },
					// Each part is unfinished until its fill lands, so a stopped map shows which parts to fill.
					meta: { fill: 'pending' },
				})
				editor.createShape({
					id: createShapeId(),
					type: 'text',
					parentId: id,
					x: 24,
					y: 24,
					props: { richText: toRichText(frame.description), autoSize: false, w: w - 48 },
					meta: { note: `Description of the ${frame.title} frame` },
				})
				return {
					id,
					title: frame.title,
					description: frame.description,
					modelBounds: helpers.roundBox(helpers.applyOffsetToBox({ x, y: origin.y, w, h })),
				}
			})

			this.agent.frames.enqueue(frames)

			// The user's camera stays where it is. The map's frames show up in the
			// agent's view, and the user can go to them when they want.
		}
	}
)

// The user's space is to the left of the map, so a new map goes right of existing content.
function getMapOrigin(viewport: Box, content: Box | undefined) {
	if (!content) return { x: viewport.x + 80, y: viewport.y + 80 }
	return { x: content.maxX + MAP_MARGIN, y: content.minY }
}
