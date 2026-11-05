import { Box, TLArrowShape, TLGeoShape, TLShapeId, toRichText } from 'tldraw'
import { DiagramAction } from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { AgentHelpers } from '../AgentHelpers'
import { AgentActionUtil, registerActionUtil } from './AgentActionUtil'
import { layoutFlow, LayoutNode, layoutMap } from '../shapes/diagram/layout'

/** Box sizes for a node: wide enough for a short label on one or two lines. */
const NODE_MIN_W = 120
const NODE_MAX_W = 220
const NODE_H = 64
const NODE_PAD = 36
/** Arrow labels: tldraw's small arrow label size, and the padding around it. */
const EDGE_LABEL_FONT_SIZE = 18
const EDGE_LABEL_PAD = 9
/** Arrow labels wrap past this width, as tldraw wraps a label on a steep arrow. */
const EDGE_LABEL_MAX_W = 220
/** Space kept between a new diagram and what was on the board before it. */
const DIAGRAM_MARGIN = 32

interface DiagramEdge {
	from: string
	to: string
	label: string
}

/** A short, stable hash of a string (FNV-1a), so different ids never share a shape id. */
function hash(value: string) {
	let h = 0x811c9dc5
	for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193)
	return (h >>> 0).toString(36)
}

/** A readable part of an id that tldraw accepts. */
function slug(value: string) {
	return value.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24)
}

/**
 * Shape ids for a diagram's parts. Each carries a hash of the exact ids it
 * comes from, so `a -> b-c` and `a-b -> c`, or nodes `a b` and `a_b`, never
 * share one.
 */
function diagramPrefix(diagramId: string) {
	return `shape:diagram-${slug(diagramId)}-${hash(diagramId)}-`
}

function nodeShapeId(diagramId: string, node: string): TLShapeId {
	return `${diagramPrefix(diagramId)}n-${slug(node)}-${hash(node)}` as TLShapeId
}

function edgeShapeId(diagramId: string, from: string, to: string): TLShapeId {
	return `${diagramPrefix(diagramId)}e-${hash(JSON.stringify([from, to]))}` as TLShapeId
}

/**
 * The agent draws a diagram from nodes and edges. The app lays it out, as a
 * flow or a map, and it lands as ordinary boxes and bound arrows the user can
 * move and edit. Redrawing the same diagram updates it in place: a node the
 * user moved stays where they put it, and parts no longer in the diagram go.
 */
export const DiagramActionUtil = registerActionUtil(
	class DiagramActionUtil extends AgentActionUtil<DiagramAction> {
		static override type = 'diagram' as const

		override getInfo(action: Streaming<DiagramAction>) {
			return { icon: 'pencil' as const, description: action.intent ?? '' }
		}

		/** The last preview's layout, so a preview redrawn for every streamed token is laid out once per change. */
		previewLayout: { key: string; positions: { x: number; y: number }[]; bends: number[] } | null = null

		override applyAction(action: Streaming<DiagramAction>, helpers: AgentHelpers) {
			if (!action.diagramId) return
			const { editor } = this
			const diagramId = String(action.diagramId)
			// While the diagram streams, the boxes and arrows written so far show as a
			// locked preview, laid out as they arrive, so the user sees it take shape
			// instead of waiting for the whole action. The app replaces the preview with
			// each new piece, and the finished action draws the diagram for real. A
			// redraw of a diagram already on the board waits for the finished action, so
			// its parts do not flicker away while the new version streams.
			const preview = !action.complete
			if (preview) {
				if (editor.getCurrentPageShapes().some((s) => s.meta.diagram === diagramId)) return
				if (typeof action.x !== 'number' || typeof action.y !== 'number') return
			}
			// In a preview, the last node or edge may still be half written.
			const rawNodes = (action.nodes ?? []).slice(0, preview && !action.edges?.length ? -1 : undefined)
			const rawEdges = (action.edges ?? []).slice(0, preview ? -1 : undefined)
			if (preview && rawNodes.length < 2) return

			// Nodes, sized to their labels, in the board's serif.
			const serif = editor.getCurrentTheme().fonts.serif?.fontFamily ?? 'serif'
			const measure = (text: string, fontSize: number, maxWidth: number) =>
				editor.textMeasure.measureText(text, {
					fontFamily: serif,
					fontSize,
					fontStyle: 'normal',
					fontWeight: '400',
					lineHeight: 1.35,
					maxWidth,
					padding: '0px',
				})
			const seen = new Set<string>()
			const nodes: (LayoutNode & { label: string })[] = []
			for (const raw of rawNodes) {
				const id = String(raw.id ?? '').trim()
				if (!id || seen.has(id)) continue
				seen.add(id)
				const label = String(raw.label ?? id).trim()
				const measured = measure(label, 18, NODE_MAX_W - NODE_PAD)
				const w = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, measured.w + NODE_PAD))
				const h = Math.max(NODE_H, measured.h + 28)
				nodes.push({ id, label, w, h, x: 0, y: 0 })
			}
			if (nodes.length === 0) return
			const edges: DiagramEdge[] = rawEdges
				.map((e) => ({ from: String(e.from), to: String(e.to), label: String(e.label ?? '').trim() }))
				.filter((e) => seen.has(e.from) && seen.has(e.to) && e.from !== e.to)
			// Each label gets its own room in the layout, so it is never squeezed or covered.
			const layoutEdges = edges.map((e) => {
				if (!e.label) return { from: e.from, to: e.to, labelW: 0, labelH: 0 }
				const size = measure(e.label, EDGE_LABEL_FONT_SIZE, EDGE_LABEL_MAX_W)
				return { from: e.from, to: e.to, labelW: size.w + EDGE_LABEL_PAD, labelH: size.h + EDGE_LABEL_PAD }
			})
			const layout = (tries?: number) =>
				action.layout === 'map' ? layoutMap(nodes, layoutEdges, tries) : layoutFlow(nodes, layoutEdges)
			let bends: number[]
			if (preview) {
				const key = JSON.stringify([action.layout, nodes.map((n) => [n.id, n.w, n.h]), layoutEdges])
				if (this.previewLayout?.key !== key) {
					// One start is enough for a preview; the finished diagram tries several.
					const previewBends = layout(1)
					this.previewLayout = { key, positions: nodes.map((n) => ({ x: n.x, y: n.y })), bends: previewBends }
				}
				nodes.forEach((n, i) => Object.assign(n, this.previewLayout!.positions[i]))
				bends = [...this.previewLayout.bends]
			} else {
				this.previewLayout = null
				bends = layout()
			}
			// Two arrows between the same boxes, one each way, would lie on top of each
			// other: give both the same bend, which curves them to opposite sides.
			const pairKey = (e: DiagramEdge) => [e.from, e.to].sort().join(' -> ')
			const pairs = new Map<string, number>()
			for (const e of edges) pairs.set(pairKey(e), (pairs.get(pairKey(e)) ?? 0) + 1)
			edges.forEach((e, i) => {
				if ((pairs.get(pairKey(e)) ?? 0) > 1 && Math.abs(bends[i]) < 30) bends[i] = 40
			})
			const bendOf = (edge: DiagramEdge) => bends[edges.indexOf(edge)] ?? 0

			const origin = helpers.removeOffsetFromVec({ x: action.x ?? 0, y: action.y ?? 0 })
			// The model cannot know how big the layout comes out, so a new diagram can land
			// on a title or note it just wrote above it. Slide it down below what it would cover.
			const prefix = diagramPrefix(diagramId)
			const isNew = nodes.every((node) => !editor.getShape(nodeShapeId(diagramId, node.id)))
			if (isNew) {
				const size = {
					w: Math.max(...nodes.map((n) => n.x + n.w)),
					h: Math.max(...nodes.map((n) => n.y + n.h)),
				}
				const obstacles = editor
					.getCurrentPageShapes()
					.filter((s) => s.type !== 'frame' && s.type !== 'group' && !s.id.startsWith(prefix))
					.map((s) => editor.getShapePageBounds(s))
					.filter((b): b is Box => !!b)
				for (let i = 0; i < 8; i++) {
					const area = new Box(origin.x, origin.y, size.w, size.h).expandBy(DIAGRAM_MARGIN)
					const hits = obstacles.filter((b) => b.collides(area) && !b.contains(area))
					if (hits.length === 0) break
					origin.y = Math.max(...hits.map((b) => b.maxY)) + DIAGRAM_MARGIN + 1
				}
			}

			// Boxes: new ones are created; existing ones take their new place and label,
			// unless the user moved them away from where the layout last put them.
			const keep = new Set<string>()
			const movedNodes = new Set<string>()
			for (const node of nodes) {
				const id = nodeShapeId(diagramId, node.id)
				keep.add(id)
				const at = { x: origin.x + node.x, y: origin.y + node.y }
				const meta = { diagram: diagramId, node: node.id, laidOutAt: at }
				const existing = editor.getShape<TLGeoShape>(id)
				const props = { w: node.w, h: node.h, richText: toRichText(node.label) }
				if (!existing) {
					editor.createShape<TLGeoShape>({
						id,
						type: 'geo',
						x: at.x,
						y: at.y,
						meta,
						isLocked: preview,
						props: { ...props, geo: 'rectangle', size: 's', font: 'serif', fill: 'none' },
					})
					continue
				}
				const last = existing.meta.laidOutAt as { x: number; y: number } | undefined
				const movedByUser = !!last && (Math.abs(existing.x - last.x) > 1 || Math.abs(existing.y - last.y) > 1)
				if (movedByUser) movedNodes.add(node.id)
				editor.updateShape<TLGeoShape>({
					id,
					type: 'geo',
					...(movedByUser ? {} : { x: at.x, y: at.y }),
					meta: { ...existing.meta, ...meta, laidOutAt: movedByUser ? last : at },
					props,
				})
			}

			// Arrows, bound to the boxes at both ends, so they follow when a box moves.
			for (const edge of edges) {
				const id = edgeShapeId(diagramId, edge.from, edge.to)
				keep.add(id)
				const fromId = nodeShapeId(diagramId, edge.from)
				const toId = nodeShapeId(diagramId, edge.to)
				const existing = editor.getShape<TLArrowShape>(id)
				const bend = bendOf(edge)
				if (existing) {
					// The bend follows the layout only while it is still the layout's: not
					// once the user bent the arrow or moved a box at either end.
					const laidOutBend = existing.meta.bend as number | undefined
					const ownBend =
						laidOutBend === existing.props.bend && !movedNodes.has(edge.from) && !movedNodes.has(edge.to)
					editor.updateShape<TLArrowShape>({
						id,
						type: 'arrow',
						meta: ownBend ? { ...existing.meta, bend } : existing.meta,
						props: { richText: toRichText(edge.label), ...(ownBend ? { bend } : {}) },
					})
					continue
				}
				const label = { richText: toRichText(edge.label), bend }
				const from = editor.getShapePageBounds(fromId)!
				const to = editor.getShapePageBounds(toId)!
				editor.createShape<TLArrowShape>({
					id,
					type: 'arrow',
					x: from.midX,
					y: from.midY,
					meta: { diagram: diagramId, bend },
					isLocked: preview,
					props: { ...label, size: 's', font: 'serif', start: { x: 0, y: 0 }, end: { x: to.midX - from.midX, y: to.midY - from.midY } },
				})
				for (const [terminal, target] of [
					['start', fromId],
					['end', toId],
				] as const) {
					editor.createBinding({
						type: 'arrow',
						fromId: id,
						toId: target,
						props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
					} as Parameters<typeof editor.createBinding>[0])
				}
			}

			// Parts of this diagram that are no longer in it go. Only the diagram's
			// own parts: a copy the user made keeps the diagram's meta but has its own
			// ids, and is the user's to keep.
			if (preview) return
			const stale = editor
				.getCurrentPageShapes()
				.filter((s) => s.meta.diagram === diagramId && s.id.startsWith(prefix) && !keep.has(s.id))
				.map((s) => s.id)
			if (stale.length) editor.deleteShapes(stale)
		}
	}
)
