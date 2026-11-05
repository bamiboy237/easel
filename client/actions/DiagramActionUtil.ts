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
/** How far a curved edge stays from a box it passes, and the least a back edge bends. */
const BEND_CLEARANCE = 28
const BACK_EDGE_BEND = 60
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
 * Flow layout: each node goes one layer below the deepest node that points to
 * it (cycles are broken where they close), and each layer is ordered by where
 * its parents sit, then centered under the widest layer.
 */
function layoutFlow(nodes: DiagramNode[], edges: DiagramEdge[]): Map<string, number> {
	// Break cycles where they close: walk forward from the nodes nothing points
	// to, and drop each edge that leads back to a node still on the walk. So in
	// splash -> menu -> play -> results -> menu, the edge back to menu is the one dropped.
	const children = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
	for (const e of edges) if (children.has(e.from) && children.has(e.to) && e.from !== e.to) children.get(e.from)!.push(e.to)
	const hasParent = new Set(edges.map((e) => e.to))
	const back = new Set<string>()
	const state = new Map<string, 'open' | 'done'>()
	const walk = (id: string) => {
		state.set(id, 'open')
		for (const child of children.get(id)!) {
			if (state.get(child) === 'open') back.add(`${id}\u0000${child}`)
			else if (!state.has(child)) walk(child)
		}
		state.set(id, 'done')
	}
	for (const n of nodes) if (!hasParent.has(n.id) && !state.has(n.id)) walk(n.id)
	for (const n of nodes) if (!state.has(n.id)) walk(n.id)
	const parents = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
	for (const [from, tos] of children) for (const to of tos) if (!back.has(`${from}\u0000${to}`)) parents.get(to)!.push(from)
	// Each node goes one layer below the deepest node that points to it.
	const depth = new Map<string, number>()
	const depthOf = (id: string): number => {
		if (depth.has(id)) return depth.get(id)!
		const d = Math.max(-1, ...parents.get(id)!.map(depthOf)) + 1
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
	// Each node's layer.
	return new Map(layers.flatMap((layer, i) => layer.map((n) => [n.id, i] as const)))
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

			let layerOf: Map<string, number> | null = null
			if (action.layout === 'map') layoutMap(nodes, edges)
			else layerOf = layoutFlow(nodes, edges)
			const nodeById = new Map(nodes.map((n) => [n.id, n]))
			// In a flow, an edge that goes back up, or one whose straight line would cross
			// a box between its ends, curves out to whichever side clears those boxes.
			let curved = 0
			const bendOf = (edge: DiagramEdge) => {
				if (!layerOf) return 0
				const a = nodeById.get(edge.from)!
				const b = nodeById.get(edge.to)!
				const from = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
				const to = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
				const back = layerOf.get(edge.to)! <= layerOf.get(edge.from)!
				// How far the curve must reach to each side to pass every box in the way.
				// An arc's offset at a fraction t of the way along is about 4t(1-t) times its bend.
				let left = 0
				let right = 0
				for (const n of nodes) {
					if (n === a || n === b) continue
					const midY = n.y + n.h / 2
					const t = (midY - from.y) / (to.y - from.y || 1)
					if (!(t > 0 && t < 1)) continue
					const lineX = from.x + (to.x - from.x) * t
					if (lineX < n.x - BEND_CLEARANCE || lineX > n.x + n.w + BEND_CLEARANCE) continue
					const reach = 4 * Math.max(0.1, t * (1 - t))
					left = Math.max(left, (lineX - n.x + BEND_CLEARANCE) / reach)
					right = Math.max(right, (n.x + n.w - lineX + BEND_CLEARANCE) / reach)
				}
				if (left === 0 && right === 0) {
					// Nothing in the way: a forward edge stays straight. A back edge still
					// curves, so it does not lie on top of the forward edge between the same boxes.
					if (!back) return 0
					left = right = BACK_EDGE_BEND
				}
				const goLeft = left < right || (left === right && curved++ % 2 === 0)
				const size = Math.max(goLeft ? left : right, BACK_EDGE_BEND)
				// A positive bend curves to the left of an arrow pointing down the page.
				const down = to.y >= from.y ? 1 : -1
				return (goLeft ? 1 : -1) * down * Math.round(size)
			}

			const origin = helpers.removeOffsetFromVec({ x: action.x ?? 0, y: action.y ?? 0 })

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

			// Parts of this diagram that are no longer in it go. Only the diagram's
			// own parts: a copy the user made keeps the diagram's meta but has its own
			// ids, and is the user's to keep.
			const prefix = diagramPrefix(diagramId)
			const stale = editor
				.getCurrentPageShapes()
				.filter((s) => s.meta.diagram === diagramId && s.id.startsWith(prefix) && !keep.has(s.id))
				.map((s) => s.id)
			if (stale.length) editor.deleteShapes(stale)
		}
	}
)
