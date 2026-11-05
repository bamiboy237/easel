import { Graph, layout as dagreLayout } from '@dagrejs/dagre'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, SimulationNodeDatum } from 'd3-force'

/**
 * Diagram layout. The model says what is in a diagram; this code decides where
 * each part goes, so boxes, arrows, and arrow labels never pile up.
 *
 * Arrow labels are laid out as boxes of their own, the way dagre does for
 * layered drawings and Hu's vPRISM does for force layouts ("Visualizing Graphs
 * with Node and Edge Labels", 2009): each label gets real space between its two
 * ends, so it is never squeezed or drawn over another label or box. A tldraw
 * arrow is a straight line or one arc, and its label sits at the middle of the
 * arc, so each arrow takes the bend whose arc passes through its label's spot.
 */

export interface LayoutNode {
	id: string
	w: number
	h: number
	/** Top left, set by the layout. */
	x: number
	y: number
}

export interface LayoutEdge {
	from: string
	to: string
	/** The size of the edge's label, 0 by 0 for none. */
	labelW: number
	labelH: number
}

/** Space between boxes in a layer, and between layers, before labels. */
const NODE_GAP = 56
const RANK_GAP = 80
/** Space kept around an arrow label, so its arrow shows on both sides of it. */
const LABEL_MARGIN = 14
/** tldraw squeezes a label to the arrow's length less this, so labels get it as room. */
const LABEL_ARROW_ROOM = 64

/**
 * The bend of each edge, in tldraw's convention: the arc's midpoint moves this
 * far from the middle of the straight line (see bendNormal). One per edge, in
 * the edges' order.
 */
export type Bends = number[]

/**
 * Flow layout: a layered drawing (Sugiyama style) by dagre, top to bottom.
 * Labels sit in their own rank between two layers, cycles are reversed where
 * they close, and long edges route around the boxes in between.
 */
export function layoutFlow(nodes: LayoutNode[], edges: LayoutEdge[]): Bends {
	const g = new Graph({ multigraph: true })
	g.setGraph({
		rankdir: 'TB',
		nodesep: NODE_GAP,
		ranksep: RANK_GAP,
		edgesep: 24,
		marginx: 0,
		marginy: 0,
		// Each step goes one layer below the deepest step that leads to it, so the
		// choices out of one step sit side by side in the next layer. dagre's
		// default, network simplex, shortens edges in total instead, and can push
		// a choice down past its siblings, which a one-arc arrow cannot route around.
		ranker: rankFromSources,
	})
	g.setDefaultEdgeLabel(() => ({}))
	for (const n of nodes) g.setNode(n.id, { width: n.w, height: n.h })
	edges.forEach((e, i) => {
		const labeled = e.labelW > 0
		g.setEdge(
			e.from,
			e.to,
			labeled
				? { width: e.labelW + LABEL_MARGIN * 2, height: e.labelH + LABEL_MARGIN, labelpos: 'c' }
				: {},
			String(i)
		)
	})
	dagreLayout(g)
	const center = new Map<string, { x: number; y: number }>()
	for (const n of nodes) {
		const d = g.node(n.id) as { x: number; y: number }
		center.set(n.id, { x: d.x, y: d.y })
		n.x = d.x - n.w / 2
		n.y = d.y - n.h / 2
	}
	const preferred = edges.map((e, i) => {
		const d = g.edge({ v: e.from, w: e.to, name: String(i) }) as {
			x?: number
			y?: number
			points?: { x: number; y: number }[]
		}
		const a = center.get(e.from)!
		const b = center.get(e.to)!
		// Where the arc should pass: the label's spot, or the middle of the route.
		const through = e.labelW > 0 && d.x !== undefined && d.y !== undefined ? { x: d.x, y: d.y } : midpointOf(d.points ?? [])
		const bend = through ? bendThrough(a, b, through) : 0
		return Math.abs(bend) < 6 ? 0 : bend
	})
	return placeBends(nodes, edges, center, preferred)
}

/**
 * Map layout: a force layout by d3-force on the graph with each labeled edge
 * split at a label node, as in Hu's vPRISM, so labels get room of their own and
 * push other labels and boxes away. Force layouts can settle tangled, so it
 * runs from several fixed starts and keeps the drawing with the fewest
 * problems: labels over boxes or labels, arcs over boxes, crossing edges, and
 * then the least area. Every start is fixed, so the same diagram always lays
 * out the same way.
 */
export function layoutMap(nodes: LayoutNode[], edges: LayoutEdge[]): Bends {
	let best: { score: number; centers: Map<string, Point>; bends: Bends } | null = null
	for (let seed = 0; seed < MAP_TRIES; seed++) {
		const centers = runForce(nodes, edges, seed)
		const placed = nodes.map((n) => ({ ...n, x: centers.get(n.id)!.x - n.w / 2, y: centers.get(n.id)!.y - n.h / 2 }))
		const preferred = edges.map((e, i) => {
			const label = centers.get(labelKey(i))
			return label ? bendThrough(centers.get(e.from)!, centers.get(e.to)!, label) : 0
		})
		const bends = placeBends(placed, edges, centers, preferred)
		const score = scoreLayout(placed, edges, centers, bends)
		if (!best || score < best.score) best = { score, centers, bends }
	}
	const { centers, bends } = best!
	const minX = Math.min(...nodes.map((n) => centers.get(n.id)!.x - n.w / 2))
	const minY = Math.min(...nodes.map((n) => centers.get(n.id)!.y - n.h / 2))
	for (const n of nodes) {
		n.x = centers.get(n.id)!.x - n.w / 2 - minX
		n.y = centers.get(n.id)!.y - n.h / 2 - minY
	}
	return bends
}

type Point = { x: number; y: number }
const MAP_TRIES = 8
const labelKey = (i: number) => `\u0000label${i}`

/** A small fixed pseudo-random sequence (mulberry32), so each start is the same every time. */
function random(seed: number) {
	let t = seed * 0x9e3779b9 + 1
	return () => {
		t += 0x6d2b79f5
		let r = Math.imul(t ^ (t >>> 15), 1 | t)
		r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296
	}
}

/** One force layout from one start. Returns the center of every box and label. */
function runForce(nodes: LayoutNode[], edges: LayoutEdge[], seed: number): Map<string, Point> {
	type Body = SimulationNodeDatum & { key: string; w: number; h: number; label: boolean }
	const rand = random(seed)
	const spread = 160 * Math.sqrt(nodes.length)
	const bodies: Body[] = nodes.map((n, i) => ({
		key: n.id,
		w: n.w,
		h: n.h,
		label: false,
		// Seed 0 starts on a circle in the given order; the others start scattered.
		x: seed === 0 ? Math.cos((2 * Math.PI * i) / nodes.length) * spread : (rand() - 0.5) * 2 * spread,
		y: seed === 0 ? Math.sin((2 * Math.PI * i) / nodes.length) * spread : (rand() - 0.5) * 2 * spread,
	}))
	const byKey = new Map(bodies.map((b) => [b.key, b]))
	const reach = (b: Body) => Math.max(b.w, b.h) / 2
	const links: { source: Body; target: Body; distance: number }[] = []
	edges.forEach((e, i) => {
		const a = byKey.get(e.from)!
		const b = byKey.get(e.to)!
		if (e.labelW <= 0) {
			links.push({ source: a, target: b, distance: reach(a) + reach(b) + 90 })
			return
		}
		const label: Body = {
			key: labelKey(i),
			w: e.labelW + LABEL_MARGIN * 2,
			h: e.labelH + LABEL_MARGIN,
			label: true,
			x: (a.x! + b.x!) / 2,
			y: (a.y! + b.y!) / 2,
		}
		bodies.push(label)
		byKey.set(label.key, label)
		// The label sits between its boxes, with the arrow showing on both sides of it.
		const half = label.w / 2 + LABEL_ARROW_ROOM / 2
		links.push({ source: a, target: label, distance: reach(a) + half })
		links.push({ source: label, target: b, distance: half + reach(b) })
	})
	const simulation = forceSimulation<Body>(bodies)
		.force(
			'link',
			forceLink<Body, (typeof links)[number]>(links)
				.distance((l) => l.distance)
				.strength(0.9)
		)
		.force('charge', forceManyBody<Body>().strength((b) => (b.label ? -120 : -600)).distanceMax(900))
		.force('collide', forceCollide<Body>((b) => Math.max(b.w, b.h) / 2 + 8).strength(0.8))
		.force('x', forceX<Body>(0).strength(0.04))
		.force('y', forceY<Body>(0).strength(0.06))
		.stop()
	for (let i = 0; i < 320; i++) simulation.tick()
	// Remove what overlap is left, as rectangles, moving things as little as needed.
	for (let i = 0; i < 60; i++) if (!separate(bodies)) break
	return new Map(bodies.map((b) => [b.key, { x: b.x!, y: b.y! }]))
}

/**
 * Push overlapping rectangles apart along the axis that overlaps least, half
 * each. Returns whether anything overlapped.
 */
function separate(bodies: (SimulationNodeDatum & { w: number; h: number })[]) {
	let any = false
	for (let i = 0; i < bodies.length; i++) {
		const p = bodies[i]
		for (let j = i + 1; j < bodies.length; j++) {
			const q = bodies[j]
			const dx = q.x! - p.x!
			const dy = q.y! - p.y!
			const ox = (p.w + q.w) / 2 + 16 - Math.abs(dx)
			const oy = (p.h + q.h) / 2 + 16 - Math.abs(dy)
			if (ox <= 0 || oy <= 0) continue
			any = true
			if (ox < oy) {
				const s = Math.sign(dx) || 1
				p.x! -= (s * ox) / 2
				q.x! += (s * ox) / 2
			} else {
				const s = Math.sign(dy) || 1
				p.y! -= (s * oy) / 2
				q.y! += (s * oy) / 2
			}
		}
	}
	return any
}

/** Lower is better: what a reader would trip over, then the area used. */
function scoreLayout(placed: LayoutNode[], edges: LayoutEdge[], centers: Map<string, Point>, bends: Bends) {
	const boxes = placed.map((n) => ({ minX: n.x, minY: n.y, maxX: n.x + n.w, maxY: n.y + n.h, id: n.id }))
	const center = (id: string) => centers.get(id)!
	// Each label sits where tldraw puts it: the middle of its arc.
	const labelBoxes = edges.flatMap((e, i) => {
		if (e.labelW <= 0) return []
		const a = center(e.from)
		const b = center(e.to)
		const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
		const n = bendNormal(a, b)
		const at = { x: (a.x + b.x) / 2 + n.x * bends[i], y: (a.y + b.y) / 2 + n.y * bends[i] }
		return [{ minX: at.x - e.labelW / 2, maxX: at.x + e.labelW / 2, minY: at.y - e.labelH / 2, maxY: at.y + e.labelH / 2, len, edge: e }]
	})
	const hit = (A: { minX: number; minY: number; maxX: number; maxY: number }, B: typeof A) =>
		Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX) > 0 && Math.min(A.maxY, B.maxY) - Math.max(A.minY, B.minY) > 0
	let problems = 0
	for (let i = 0; i < labelBoxes.length; i++) {
		for (const box of boxes) if (hit(labelBoxes[i], box)) problems += 3
		for (let j = i + 1; j < labelBoxes.length; j++) if (hit(labelBoxes[i], labelBoxes[j])) problems += 3
		// A label wider than the room between its boxes is squeezed onto more lines.
		if (labelBoxes[i].len < labelBoxes[i].edge.labelW + 140) problems += 1
	}
	const arcs = edges.map((e, i) => arcPoints(center(e.from), center(e.to), bends[i], 16))
	edges.forEach((e, i) => {
		for (const box of boxes) {
			if (box.id === e.from || box.id === e.to) continue
			if (arcs[i].some((p) => p.x > box.minX && p.x < box.maxX && p.y > box.minY && p.y < box.maxY)) problems += 2
		}
	})
	// Edge crossings, counted on the arcs' polylines.
	for (let i = 0; i < arcs.length; i++) {
		for (let j = i + 1; j < arcs.length; j++) {
			const shared = [edges[i].from, edges[i].to].some((id) => id === edges[j].from || id === edges[j].to)
			if (!shared && polylinesCross(arcs[i], arcs[j])) problems += 1
		}
	}
	const minX = Math.min(...boxes.map((b) => b.minX))
	const maxX = Math.max(...boxes.map((b) => b.maxX))
	const minY = Math.min(...boxes.map((b) => b.minY))
	const maxY = Math.max(...boxes.map((b) => b.maxY))
	const area = (maxX - minX) * (maxY - minY)
	// Wide is easier to read on a screen than tall.
	const aspect = (maxY - minY) / (maxX - minX || 1) > 1 ? 1 : 0
	return problems * 10 + aspect * 3 + area / 400000
}

function polylinesCross(p: Point[], q: Point[]) {
	for (let i = 0; i + 1 < p.length; i++) {
		for (let j = 0; j + 1 < q.length; j++) if (segmentsCross(p[i], p[i + 1], q[j], q[j + 1])) return true
	}
	return false
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point) {
	const o = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
	return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b) && o(a, b, c) !== 0 && o(c, d, a) !== 0
}

/**
 * Longest path from the sources: each node's rank is the largest rank of a
 * node pointing to it plus that edge's length. dagre calls this on its own
 * acyclic copy of the graph, where a labeled edge spans two ranks.
 */
function rankFromSources(g: Graph) {
	const done = new Set<string>()
	const open = new Set<string>()
	const visit = (v: string): number => {
		const node = g.node(v) as { rank?: number }
		if (done.has(v)) return node.rank ?? 0
		let rank = 0
		if (!open.has(v)) {
			open.add(v)
			for (const e of g.inEdges(v) ?? []) {
				const minlen = (g.edge(e) as { minlen?: number }).minlen ?? 1
				rank = Math.max(rank, visit(e.v) + minlen)
			}
			open.delete(v)
		}
		node.rank = rank
		done.add(v)
		return rank
	}
	for (const v of g.nodes()) visit(v)
}

/**
 * The direction a positive bend moves an arc's middle: (-dy, dx) of the
 * arrow's direction, so an arrow pointing right bends down the page and one
 * pointing down bends left. Measured on tldraw 5.6.
 */
function bendNormal(a: Point, b: Point) {
	const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
	return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len }
}

/** The bend that makes the arc from a to b pass through a point on its bisector. */
function bendThrough(a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }) {
	const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
	const normal = bendNormal(a, b)
	return Math.round((p.x - (a.x + b.x) / 2) * normal.x + (p.y - (a.y + b.y) / 2) * normal.y)
}

/** The point halfway along a polyline. */
function midpointOf(points: { x: number; y: number }[]) {
	if (points.length < 2) return null
	const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y))
	let half = lengths.reduce((s, l) => s + l, 0) / 2
	for (let i = 0; i < lengths.length; i++) {
		if (half <= lengths[i]) {
			const t = lengths[i] ? half / lengths[i] : 0
			return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t }
		}
		half -= lengths[i]
	}
	return points[points.length - 1]
}

function clampAbs(value: number, limit: number) {
	return Math.max(-limit, Math.min(limit, value))
}

/** Points along the arc from a to b with this bend, between the two ends. */
function arcPoints(a: { x: number; y: number }, b: { x: number; y: number }, bend: number, steps = 24) {
	const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
	const normal = bendNormal(a, b)
	const points: { x: number; y: number }[] = []
	// A parabola through the three points is close enough to the arc for a clearance test.
	for (let i = 1; i < steps; i++) {
		const t = i / steps
		const off = 4 * t * (1 - t) * bend
		points.push({ x: a.x + (b.x - a.x) * t + normal.x * off, y: a.y + (b.y - a.y) * t + normal.y * off })
	}
	return points
}

/**
 * Choose every arrow's bend together, one edge at a time, from a set of
 * candidate bends: the classic candidate-position approach to edge label
 * placement (Kakoulis and Tollis). A candidate costs more when its arc runs
 * over a box, when its label (at the arc's middle) covers a box or a label
 * already placed, when the label would be squeezed onto more lines, and the
 * further it bends. Short edges go first, since they have the fewest good
 * places.
 */
function placeBends(nodes: LayoutNode[], edges: LayoutEdge[], centers: Map<string, Point>, preferred: Bends): Bends {
	type Rect = { minX: number; minY: number; maxX: number; maxY: number }
	const boxes = new Map<string, Rect>(nodes.map((n) => [n.id, { minX: n.x, minY: n.y, maxX: n.x + n.w, maxY: n.y + n.h }]))
	const overlap = (A: Rect, B: Rect, pad = 0) =>
		Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX) > -pad && Math.min(A.maxY, B.maxY) - Math.max(A.minY, B.minY) > -pad
	const placedLabels: Rect[] = []
	const placedArcs: Point[][] = []
	const bends: Bends = edges.map(() => 0)
	const order = edges
		.map((e, i) => ({ i, len: Math.hypot(centers.get(e.to)!.x - centers.get(e.from)!.x, centers.get(e.to)!.y - centers.get(e.from)!.y) }))
		.sort((p, q) => (edges[q.i].labelW > 0 ? 1 : 0) - (edges[p.i].labelW > 0 ? 1 : 0) || p.len - q.len)
	for (const { i, len } of order) {
		const e = edges[i]
		const a = centers.get(e.from)!
		const b = centers.get(e.to)!
		const normal = bendNormal(a, b)
		const limit = Math.min(260, len * 0.6)
		const candidates = new Set<number>([Math.round(clampAbs(preferred[i], limit)), 0])
		for (let step = 20; step <= limit; step += 20) {
			candidates.add(step)
			candidates.add(-step)
		}
		const ownA = boxes.get(e.from)!
		const ownB = boxes.get(e.to)!
		// The room for a label along a mostly level arrow is its length between the two boxes.
		const levelRoom = Math.abs(b.x - a.x) - (ownA.maxX - ownA.minX) / 2 - (ownB.maxX - ownB.minX) / 2
		const level = Math.abs(b.x - a.x) > Math.abs(b.y - a.y)
		let best = { cost: Infinity, bend: 0, label: null as Rect | null, arc: [] as Point[] }
		for (const bend of candidates) {
			const arc = arcPoints(a, b, bend, 12)
			let cost = Math.abs(bend - preferred[i]) / 40 + Math.abs(bend) / 80
			for (const [id, box] of boxes) {
				if (id === e.from || id === e.to) continue
				const inside = arc.filter((p) => p.x > box.minX - 10 && p.x < box.maxX + 10 && p.y > box.minY - 10 && p.y < box.maxY + 10).length
				cost += inside * 6
			}
			let label: Rect | null = null
			if (e.labelW > 0) {
				const at = { x: (a.x + b.x) / 2 + normal.x * bend, y: (a.y + b.y) / 2 + normal.y * bend }
				label = { minX: at.x - e.labelW / 2, maxX: at.x + e.labelW / 2, minY: at.y - e.labelH / 2, maxY: at.y + e.labelH / 2 }
				for (const box of boxes.values()) if (overlap(label, box, 6)) cost += 30
				for (const other of placedLabels) if (overlap(label, other, 6)) cost += 30
				for (const other of placedArcs) if (other.some((p) => p.x > label!.minX && p.x < label!.maxX && p.y > label!.minY && p.y < label!.maxY)) cost += 8
				if (level && bend === 0 && levelRoom < e.labelW + LABEL_ARROW_ROOM) cost += 10
			}
			// An arc that runs through a label already placed hides it.
			for (const other of placedLabels) if (arc.some((p) => p.x > other.minX && p.x < other.maxX && p.y > other.minY && p.y < other.maxY)) cost += 8
			if (cost < best.cost) best = { cost, bend, label, arc }
		}
		bends[i] = best.bend
		if (best.label) placedLabels.push(best.label)
		placedArcs.push(best.arc)
	}
	return bends
}

