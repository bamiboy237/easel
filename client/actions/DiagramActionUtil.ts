import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, SimulationNodeDatum } from 'd3-force'
import { TLArrowShape, TLGeoShape, TLShapeId, toRichText } from 'tldraw'
import { DiagramAction } from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { AgentHelpers } from '../AgentHelpers'
import { AgentActionUtil, registerActionUtil } from './AgentActionUtil'

/** Box sizes for a node: wide enough for a short label on one or two lines. */
const NODE_MIN_W = 120
const NODE_MAX_W = 220
const NODE_H = 64
const NODE_PAD = 36
/** Space between layers in a flow, and between nodes in a layer. */
const LAYER_GAP = 72
const SIBLING_GAP = 48

interface DiagramNode {
	id: string
	label: string
	w: number
	h: number
	x: number
	y: number
}

interface DiagramEdge {
	from: string
	to: string
	label: string
}

/** A shape id safe for tldraw, from the diagram's and the node's own ids. */
function diagramShapeId(diagramId: string, part: string): TLShapeId {
	return `shape:diagram-${diagramId}-${part}`.replace(/[^a-zA-Z0-9:_-]/g, '_') as TLShapeId
}

/**
 * Flow layout: each node goes one layer below the deepest node that points to
 * it (cycles are broken where they close), and each layer is ordered by where
 * its parents sit, then centered under the widest layer.
 */
function layoutFlow(nodes: DiagramNode[], edges: DiagramEdge[]) {
	const parents = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
	for (const e of edges) if (parents.has(e.to) && parents.has(e.from) && e.from !== e.to) parents.get(e.to)!.push(e.from)
	const depth = new Map<string, number>()
	const visiting = new Set<string>()
	const depthOf = (id: string): number => {
		if (depth.has(id)) return depth.get(id)!
		if (visiting.has(id)) return 0
		visiting.add(id)
		const d = Math.max(-1, ...parents.get(id)!.map(depthOf)) + 1
		visiting.delete(id)
		depth.set(id, d)
		return d
	}
	nodes.forEach((n) => depthOf(n.id))
	const layers: DiagramNode[][] = []
	for (const n of nodes) (layers[depth.get(n.id)!] ??= []).push(n)
	const centerX = new Map<string, number>()
	const widths = layers.map((layer) => layer.reduce((sum, n) => sum + n.w, 0) + SIBLING_GAP * (layer.length - 1))
	const widest = Math.max(...widths)
	let y = 0
	layers.forEach((layer, i) => {
		// Order by the average place of each node's parents, so edges cross less.
		layer.sort((a, b) => average(parents.get(a.id)!, centerX) - average(parents.get(b.id)!, centerX))
		let x = (widest - widths[i]) / 2
		const rowH = Math.max(...layer.map((n) => n.h))
		for (const n of layer) {
			n.x = x
			n.y = y + (rowH - n.h) / 2
			centerX.set(n.id, x + n.w / 2)
			x += n.w + SIBLING_GAP
		}
		y += rowH + LAYER_GAP
	})
}

function average(ids: string[], at: Map<string, number>) {
	const known = ids.map((id) => at.get(id)).filter((v): v is number => v !== undefined)
	return known.length ? known.reduce((a, b) => a + b, 0) / known.length : Number.MAX_SAFE_INTEGER / 2
}

/**
 * Map layout: a force layout with d3-force, run to rest at once. Linked nodes
 * pull together, all nodes push apart, and no two boxes overlap. It starts
 * from d3's fixed spiral, so the same diagram always lays out the same way.
 */
function layoutMap(nodes: DiagramNode[], edges: DiagramEdge[]) {
	type Sim = SimulationNodeDatum & { node: DiagramNode }
	const simNodes: Sim[] = nodes.map((node) => ({ node }))
	const byId = new Map(simNodes.map((s) => [s.node.id, s]))
	const links = edges
		.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to)
		.map((e) => ({ source: byId.get(e.from)!, target: byId.get(e.to)! }))
	const simulation = forceSimulation(simNodes)
		.force('link', forceLink(links).distance(190).strength(0.7))
		.force('charge', forceManyBody().strength(-600))
		.force('collide', forceCollide<Sim>((s) => Math.hypot(s.node.w, s.node.h) / 2 + 18).iterations(3))
		.force('center', forceCenter(0, 0))
		.stop()
	for (let i = 0; i < 400; i++) simulation.tick()
	const minX = Math.min(...simNodes.map((s) => (s.x ?? 0) - s.node.w / 2))
	const minY = Math.min(...simNodes.map((s) => (s.y ?? 0) - s.node.h / 2))
	for (const s of simNodes) {
		s.node.x = (s.x ?? 0) - s.node.w / 2 - minX
		s.node.y = (s.y ?? 0) - s.node.h / 2 - minY
	}
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

		override applyAction(action: Streaming<DiagramAction>, helpers: AgentHelpers) {
			if (!action.complete || !action.diagramId) return
			const { editor } = this
			const diagramId = String(action.diagramId)

			// Nodes, sized to their labels.
			const seen = new Set<string>()
			const nodes: DiagramNode[] = []
			for (const raw of action.nodes ?? []) {
				const id = String(raw.id ?? '').trim()
				if (!id || seen.has(id)) continue
				seen.add(id)
				const label = String(raw.label ?? id).trim()
				const measured = editor.textMeasure.measureText(label, {
					fontFamily: "'Source Serif 4 Variable', Georgia, serif",
					fontSize: 18,
					fontStyle: 'normal',
					fontWeight: '400',
					lineHeight: 1.35,
					maxWidth: NODE_MAX_W - NODE_PAD,
					padding: '0px',
				})
				const w = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, measured.w + NODE_PAD))
				const h = Math.max(NODE_H, measured.h + 28)
				nodes.push({ id, label, w, h, x: 0, y: 0 })
			}
			if (nodes.length === 0) return
			const edges: DiagramEdge[] = (action.edges ?? [])
				.map((e) => ({ from: String(e.from), to: String(e.to), label: String(e.label ?? '') }))
				.filter((e) => seen.has(e.from) && seen.has(e.to) && e.from !== e.to)

			if (action.layout === 'map') layoutMap(nodes, edges)
			else layoutFlow(nodes, edges)

			const origin = helpers.removeOffsetFromVec({ x: action.x ?? 0, y: action.y ?? 0 })

			// Boxes: new ones are created; existing ones take their new place and label,
			// unless the user moved them away from where the layout last put them.
			const keep = new Set<string>()
			for (const node of nodes) {
				const id = diagramShapeId(diagramId, `n-${node.id}`)
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
						props: { ...props, geo: 'rectangle', size: 's', font: 'serif', fill: 'none' },
					})
					continue
				}
				const last = existing.meta.laidOutAt as { x: number; y: number } | undefined
				const movedByUser = !!last && (Math.abs(existing.x - last.x) > 1 || Math.abs(existing.y - last.y) > 1)
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
				const id = diagramShapeId(diagramId, `e-${edge.from}-${edge.to}`)
				keep.add(id)
				const fromId = diagramShapeId(diagramId, `n-${edge.from}`)
				const toId = diagramShapeId(diagramId, `n-${edge.to}`)
				const existing = editor.getShape<TLArrowShape>(id)
				const label = { richText: toRichText(edge.label) }
				if (existing) {
					editor.updateShape<TLArrowShape>({ id, type: 'arrow', props: label })
					continue
				}
				const from = editor.getShapePageBounds(fromId)!
				const to = editor.getShapePageBounds(toId)!
				editor.createShape<TLArrowShape>({
					id,
					type: 'arrow',
					x: from.midX,
					y: from.midY,
					meta: { diagram: diagramId },
					props: { ...label, size: 's', start: { x: 0, y: 0 }, end: { x: to.midX - from.midX, y: to.midY - from.midY } },
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

			// Parts of this diagram that are no longer in it go.
			const stale = editor
				.getCurrentPageShapes()
				.filter((s) => s.meta.diagram === diagramId && !keep.has(s.id))
				.map((s) => s.id)
			if (stale.length) editor.deleteShapes(stale)
		}
	}
)
