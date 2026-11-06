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
	/** The box's text, which can say it is a date on a timeline. */
	label?: string
}

/** A label that starts with a year or a date, such as "1939 · Germany invades Poland" or "July 1969: Apollo 11". */
const DATED = /^\s*(c\.\s*)?((\d{1,2}\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?\d{3,4}\s*(bce?|ce|ad)?\b/i

/**
 * Whether a chain is a timeline: most of its steps are dated. Time reads left
 * to right on every row of a timeline (Tufte's time-series convention, and
 * every printed timeline), so its rows never turn back as a process's do.
 */
function isTimeline(nodes: LayoutNode[]) {
	return nodes.filter((n) => DATED.test(n.label ?? '')).length >= Math.ceil(nodes.length * 0.6)
}

export interface LayoutEdge {
	from: string
	to: string
	/** The size of the edge's label, 0 by 0 for none. */
	labelW: number
	labelH: number
	/** The label's text, which can say which side a branch goes to. */
	label?: string
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
export type Bends = number[] & {
	/** Edges drawn as right-angled (elbow) arrows instead of arcs, by edge index. */
	routes?: (EdgeRoute | null)[]
}

/**
 * A right-angled arrow: where it leaves and enters its boxes, as tldraw's
 * normalized anchors, and where its middle run sits, as a fraction of the way
 * from its start to its end (tldraw's elbowMidPoint).
 */
export interface EdgeRoute {
	start: Point
	end: Point
	mid: number
}

/**
 * Flow layout: a layered drawing (Sugiyama style) by dagre, top to bottom.
 * Labels sit in their own rank between two layers, cycles are reversed where
 * they close, and long edges route around the boxes in between.
 */
export function layoutFlow(nodes: LayoutNode[], edges: LayoutEdge[]): Bends {
	const snake = layoutSnake(nodes, edges) ?? layoutLoop(nodes, edges)
	if (snake) return snake
	// A label on a slanting arrow is squeezed when the arrow is wider than tall and
	// too short for it; more room between layers makes such arrows steeper.
	const run = (rankdir: 'TB' | 'LR') => {
		let bends: Bends = []
		let squeezed = false
		for (let attempt = 0; attempt < 3; attempt++) {
			const centers = new Map<string, Point>()
			bends = layoutFlowOnce(nodes, edges, RANK_GAP + attempt * 48, centers, rankdir)
			squeezed = edges.some((e, i) => isSqueezed(nodes, e, centers, bends[i]))
			if (!squeezed) break
		}
		const w = Math.max(...nodes.map((n) => n.x + n.w)) - Math.min(...nodes.map((n) => n.x))
		const h = Math.max(...nodes.map((n) => n.y + n.h)) - Math.min(...nodes.map((n) => n.y))
		return { bends, squeezed, fit: Math.min(1, FIT_W / w, FIT_H / h), at: nodes.map((n) => ({ x: n.x, y: n.y })) }
	}
	const down = run('TB')
	// A long flow with branches drawn top to bottom can come out far taller than
	// a screen, which shrinks its text past reading size at fit. The same flow
	// read left to right often fits; it wins when it reads larger and keeps every
	// label whole. A tree keeps top to bottom, as trees are drawn.
	// A process that branches only at its end, such as a bill's path to the
	// President's choices, is a tree too, but a tall one: it may still wrap its
	// lead-in into rows.
	if (down.fit >= MIN_FIT) {
		// A short pipeline drawn top to bottom, such as a request path through a
		// system's parts, comes out a thin column that leaves most of a screen
		// empty. When it runs three steps or more in a line before it branches, it
		// reads left to right, as the request travels, if that fits as well.
		const at = nodes.map((n) => ({ x: n.x, y: n.y }))
		const w = Math.max(...nodes.map((n) => n.x + n.w)) - Math.min(...nodes.map((n) => n.x))
		const h = Math.max(...nodes.map((n) => n.y + n.h)) - Math.min(...nodes.map((n) => n.y))
		if (h > 1.5 * w && leadRun(nodes, edges) >= 2) {
			const across = run('LR')
			const value = (o: { fit: number; at: Point[]; bends: Bends }) => Math.min(1, o.fit) - flowPenalty(nodes, edges, o.at, o.bends)
			if (!across.squeezed && across.fit >= MIN_FIT && value(across) >= value(down) - 0.1) {
				nodes.forEach((n, i) => Object.assign(n, across.at[i]))
				return across.bends
			}
		}
		nodes.forEach((n, i) => Object.assign(n, at[i]))
		return down.bends
	}
	const options = [down]
	if (!isTree(nodes, edges)) {
		const across = run('LR')
		if (!across.squeezed) options.push(across)
	}
	const leadIn = layoutLeadIn(nodes, edges)
	if (leadIn) options.push(leadIn)
	const spine = layoutSpine(nodes, edges)
	if (spine) options.push(spine)
	const procedure = layoutProcedure(nodes, edges)
	if (procedure) options.push(procedure)
	const columns = layoutColumns(nodes, edges)
	if (columns) options.push(columns)
	// A drawing that fits but reads badly loses: crossing arrows, arrows that run
	// back up the page, and arrows through boxes each cost it.
	// A procedure that reads straight down its columns wins over rows that turn back, unless it is much smaller.
	const value = (o: (typeof options)[number] & { continued?: Set<number>; procedure?: boolean }) =>
		Math.min(1, o.fit) - flowPenalty(nodes, edges, o.at, o.bends, o.continued) + (o.procedure ? PROCEDURE_BONUS : 0)
	const best = options.reduce((a, b) => (value(b) > value(a) + 0.05 ? b : a))
	nodes.forEach((n, i) => Object.assign(n, best.at[i]))
	return best.bends
}

/**
 * A flow that runs a long way in a single line before it branches, such as a
 * bill's path through Congress before the President's choices, drawn as one
 * column is far taller than a screen. Its lead-in wraps into rows, as a
 * process wraps (see layoutSnake), and the branching part hangs below the
 * lead-in's last step, laid out top to bottom. Returns null for a flow without
 * such a lead-in.
 */
function layoutLeadIn(nodes: LayoutNode[], edges: LayoutEdge[]) {
	const into = new Map<string, number>(nodes.map((n) => [n.id, 0]))
	const outOf = new Map<string, number[]>(nodes.map((n) => [n.id, []]))
	edges.forEach((e, i) => {
		into.set(e.to, into.get(e.to)! + 1)
		outOf.get(e.from)!.push(i)
	})
	const sources = nodes.filter((n) => into.get(n.id) === 0)
	if (sources.length !== 1) return null
	const byId = new Map(nodes.map((n) => [n.id, n]))
	const lead: LayoutNode[] = [sources[0]]
	for (;;) {
		const last = lead[lead.length - 1]
		const out = outOf.get(last.id)!
		if (out.length !== 1) break
		const next = byId.get(edges[out[0]].to)!
		if (into.get(next.id) !== 1 || lead.includes(next)) break
		lead.push(next)
	}
	// The head is where the flow branches; it goes with the part below.
	const head = lead.pop()!
	if (lead.length < 3 || outOf.get(head.id)!.length < 2) return null
	const inLead = new Set(lead.map((n) => n.id))
	const rest = nodes.filter((n) => !inLead.has(n.id))
	const restEdges = edges.map((e, i) => ({ e, i })).filter(({ e }) => !inLead.has(e.from) && !inLead.has(e.to))
	const restCenters = new Map<string, Point>()
	const restNodes = rest.map((n) => ({ ...n }))
	const restBends = layoutDown(
		restNodes,
		restEdges.map(({ e }) => e),
		restCenters
	)
	// The lead-in, with the head as its last step, in rows of up to four.
	const chain = [...lead, head]
	const chainEdges = chain.slice(0, -1).map((n) => edges[outOf.get(n.id)![0]])
	const cellW = Math.max(...chain.map((n) => n.w))
	const cellH = Math.max(...chain.map((n) => n.h))
	const cols = Math.min(4, Math.ceil(chain.length / Math.ceil(chain.length / 4)))
	const gapX = Math.max(72, ...chainEdges.map((e) => (e.labelW > 0 ? e.labelW + LABEL_ARROW_ROOM + LABEL_MARGIN : 0)))
	const gapY = Math.max(64, ...chainEdges.map((e) => (e.labelH > 0 ? e.labelH + LABEL_ARROW_ROOM : 0)))
	const at = new Map<string, Point>()
	chain.forEach((n, k) => {
		const row = Math.floor(k / cols)
		const col = row % 2 === 0 ? k % cols : cols - 1 - (k % cols)
		at.set(n.id, { x: col * (cellW + gapX) + (cellW - n.w) / 2, y: row * (cellH + gapY) + (cellH - n.h) / 2 })
	})
	// The part below hangs from the head: shift it so the head lands on its place in the rows.
	const restHead = restNodes.find((n) => n.id === head.id)!
	const dx = at.get(head.id)!.x - restHead.x
	const dy = at.get(head.id)!.y - restHead.y
	for (const n of restNodes) if (n.id !== head.id) at.set(n.id, { x: n.x + dx, y: n.y + dy })
	const bends: Bends = edges.map(() => 0)
	restEdges.forEach(({ i }, k) => (bends[i] = restBends[k]))
	const placed = nodes.map((n) => ({ ...n, ...at.get(n.id)! }))
	// The part below must not run into the rows above it.
	const rows = placed.filter((n) => inLead.has(n.id))
	const below = placed.filter((n) => !inLead.has(n.id) && n.id !== head.id)
	if (below.some((b) => rows.some((r) => b.x < r.x + r.w + 16 && r.x < b.x + b.w + 16 && b.y < r.y + r.h + 16 && r.y < b.y + b.h + 16))) return null
	const minX = Math.min(...placed.map((n) => n.x))
	const minY = Math.min(...placed.map((n) => n.y))
	const w = Math.max(...placed.map((n) => n.x + n.w)) - minX
	const h = Math.max(...placed.map((n) => n.y + n.h)) - minY
	return { bends, squeezed: false, fit: Math.min(1, FIT_W / w, FIT_H / h), at: placed.map((n) => ({ x: n.x - minX, y: n.y - minY })) }
}

/**
 * A flow's main line: from its one source, each step goes on to one step, and
 * any other way out is a quick end (an exit). A detour that rejoins the main
 * line, such as chambers that reconcile their versions, stays on it, and the
 * direct way past it is a skip. Null when the flow has no single source.
 */
function mainLine(nodes: LayoutNode[], edges: LayoutEdge[]) {
	const into = new Map<string, number>(nodes.map((n) => [n.id, 0]))
	const outOf = new Map<string, number[]>(nodes.map((n) => [n.id, []]))
	edges.forEach((e, i) => {
		into.set(e.to, into.get(e.to)! + 1)
		outOf.get(e.from)!.push(i)
	})
	const sources = nodes.filter((n) => into.get(n.id) === 0)
	if (sources.length !== 1) return null
	const byId = new Map(nodes.map((n) => [n.id, n]))
	const isExit = (id: string) => outOf.get(id)!.length === 0 && into.get(id) === 1
	// The main line: each step goes on to one step, and any other way out is a quick end.
	const chain: LayoutNode[] = [sources[0]]
	const exitsOf = new Map<string, number[]>()
	// A detour: a choice whose one way goes through a few steps and comes back to
	// where its other way goes (chambers that disagree reconcile, then the bill
	// goes on to the President). The detour joins the main line, and the direct
	// way arcs over it. No row breaks inside a detour.
	const skips: number[] = []
	const noBreak = new Set<string>()
	let joinAt: string | null = null
	const nextOn = (id: string) => outOf.get(id)!.filter((i) => !isExit(edges[i].to))
	const detour = (on: number[]) => {
		for (const [a, b] of [
			[0, 1],
			[1, 0],
		]) {
			const target = edges[on[b]].to
			let at = edges[on[a]].to
			let steps = 0
			while (at !== target && steps < 3) {
				const next = nextOn(at)
				if (next.length !== 1 || into.get(at) !== 1 || chain.some((n) => n.id === at)) break
				at = edges[next[0]].to
				steps++
			}
			if (at === target && steps >= 1 && into.get(target) === 2) return { side: on[a], skip: on[b], target }
		}
		return null
	}
	for (;;) {
		const last = chain[chain.length - 1]
		const out = outOf.get(last.id)!
		const ends = out.filter((i) => isExit(edges[i].to))
		const on = out.filter((i) => !isExit(edges[i].to))
		if (ends.length > 2) break
		let step = on.length === 1 ? on[0] : -1
		if (on.length === 2 && !joinAt) {
			const d = detour(on)
			if (!d) break
			skips.push(d.skip)
			joinAt = d.target
			step = d.side
		}
		if (step < 0) break
		const next = byId.get(edges[step].to)!
		const joins = next.id === joinAt
		if ((into.get(next.id) !== 1 && !joins) || chain.includes(next)) break
		if (joinAt) noBreak.add(last.id)
		if (joins) joinAt = null
		exitsOf.set(last.id, ends)
		chain.push(next)
	}
	// A detour left open at the end does not join; the main line stops before it.
	if (joinAt) {
		while (chain.length > 1 && noBreak.has(chain[chain.length - 2].id)) {
			const gone = chain.pop()!
			exitsOf.delete(gone.id)
		}
		exitsOf.delete(chain[chain.length - 1].id)
		skips.pop()
	}
	return { chain, exitsOf, skips, noBreak, into, outOf, byId }
}

/** Room an elbow arrow takes past the boxes it runs above and below (tldraw's leg for size s, and a margin). */
const ELBOW_ROOM = 40

/**
 * A long procedure, such as a bill's path through Congress, drawn the way a
 * printed flowchart is: its main line runs straight down a column, and every
 * quick end ("Bill fails") sits to the right of the step it leaves, on that
 * step's row, so the eye reads down and the failures stay on one side. A
 * detour, such as reconciling two versions, steps out to the right and comes
 * back to the step it rejoins, while the direct way runs straight down. A
 * line too tall for a screen continues at the top of the next column, joined
 * by a right-angled arrow that runs down the gutter between them, as a poster
 * continues. The part after the main line's first real fork hangs below the
 * main line's last step, top to bottom. Returns null when the flow has no
 * such main line.
 */
function layoutProcedure(nodes: LayoutNode[], edges: LayoutEdge[]) {
	const line = mainLine(nodes, edges)
	if (!line) return null
	const { exitsOf, byId } = line
	let { chain, skips } = line
	// A step with two quick ends, such as a President who signs, vetoes, or does
	// nothing, is a fork: the main line stops there, and its choices fan out below it.
	const fork = chain.findIndex((n, k) => k > 0 && k < chain.length - 1 && (exitsOf.get(n.id)?.length ?? 0) >= 2)
	if (fork > 0) {
		const spans = skips.map((i) => [chain.findIndex((n) => n.id === edges[i].from), chain.findIndex((n) => n.id === edges[i].to)])
		if (!spans.some(([a, b]) => a < fork && fork < b)) {
			for (const n of chain.slice(fork)) exitsOf.delete(n.id)
			skips = skips.filter((_, j) => spans[j][1] <= fork)
			chain = chain.slice(0, fork + 1)
		}
	}
	// Where the main line ends in three or more choices and one of them ends at
	// once ("signs: becomes law"), that end sits beside the last step, as the
	// quick ends above it do, and only the longer choices fan out below.
	{
		const last = chain[chain.length - 1]
		const outs = edges.map((e, i) => ({ e, i })).filter(({ e }) => e.from === last.id)
		const isLeaf = (id: string) => !edges.some((e) => e.from === id) && edges.filter((e) => e.to === id).length === 1
		const leaves = outs.filter(({ e }) => isLeaf(e.to))
		if (outs.length >= 3 && leaves.length === 1) exitsOf.set(last.id, [leaves[0].i])
	}
	const exitCount = [...exitsOf.values()].reduce((s, a) => s + a.length, 0)
	if (chain.length < 5 || exitCount === 0) return null
	const head = chain[chain.length - 1]
	const inChain = new Set(chain.map((n) => n.id))
	const exitIds = new Set([...exitsOf.values()].flat().map((i) => edges[i].to))
	const rest = nodes.filter((n) => !inChain.has(n.id) && !exitIds.has(n.id))
	const restSet = new Set([head.id, ...rest.map((n) => n.id)])
	const edgeOf = (from: string, to: string) => edges.findIndex((e) => e.from === from && e.to === to)
	const restEdges = edges.map((e, i) => ({ e, i })).filter(({ e }) => restSet.has(e.from) && restSet.has(e.to))
	// Detours: the steps between a skip's ends step out to the right.
	const detours = skips.map((i) => {
		const a = chain.findIndex((n) => n.id === edges[i].from)
		const b = chain.findIndex((n) => n.id === edges[i].to)
		return { skip: i, a, b, inner: chain.slice(a + 1, b) }
	})
	if (detours.some((d) => d.a < 0 || d.b <= d.a + 1 || d.inner.length > 2)) return null
	const innerIds = new Set(detours.flatMap((d) => d.inner.map((n) => n.id)))
	const spine = chain.filter((n) => !innerIds.has(n.id))
	const mainIdx = spine.slice(0, -1).map((n, k) => edgeOf(n.id, spine[k + 1].id))
	if (mainIdx.some((i) => i < 0)) return null
	const chainIdx = chain.slice(0, -1).map((n, k) => edgeOf(n.id, chain[k + 1].id))
	// Every arrow is on the main line, a quick end, a detour, or in the part below.
	const covered = new Set([...chainIdx, ...skips, ...[...exitsOf.values()].flat(), ...restEdges.map(({ i }) => i)])
	if (chainIdx.some((i) => i < 0) || covered.size !== edges.length) return null
	const gapFor = (i: number) => {
		const e = edges[i]
		return Math.max(64, e.labelW > 0 ? e.labelW + LABEL_ARROW_ROOM + LABEL_MARGIN : 0)
	}
	const exits = (n: LayoutNode) => (exitsOf.get(n.id) ?? []).map((i) => ({ i, node: byId.get(edges[i].to)! }))
	// Each spine step's row: boxes beside it, as offsets of their left edges from the step's center.
	type Item = { node: LayoutNode; dx: number }
	const rowOf = new Map<string, Item[]>()
	const outward = (items: Item[], side: 1 | -1, from: number, list: { i: number; node: LayoutNode }[]) => {
		let x = from
		for (const { i, node } of list) {
			const gap = gapFor(i)
			if (side > 0) {
				items.push({ node, dx: x + gap })
				x += gap + node.w
			} else {
				items.push({ node, dx: x - gap - node.w })
				x -= gap + node.w
			}
		}
	}
	for (const n of spine) {
		const items: Item[] = []
		const ex = exits(n)
		const k = chain.indexOf(n)
		const d = detours.find((t) => t.a === k || (t.inner.length === 2 && t.b === k))
		if (!d) {
			outward(items, 1, n.w / 2, ex.slice(0, 1))
			outward(items, -1, -n.w / 2, ex.slice(1))
		} else {
			// A detour's steps share a lane right of the spine, one on each of the two rows.
			const start = chain[d.a]
			const join = chain[d.b]
			const first = d.inner[0]
			const last = d.inner[d.inner.length - 1]
			const twoRows = d.inner.length === 2
			const lane =
				Math.max(start.w / 2 + gapFor(edgeOf(start.id, first.id)), twoRows ? join.w / 2 + gapFor(edgeOf(last.id, join.id)) : 0) +
				Math.max(...d.inner.map((m) => m.w)) / 2
			const inner = n === start ? first : last
			items.push({ node: inner, dx: lane - inner.w / 2 })
			outward(items, 1, lane + inner.w / 2, exits(inner))
			outward(items, -1, -n.w / 2, ex)
		}
		rowOf.set(n.id, items)
	}
	const rowH = (n: LayoutNode) => Math.max(n.h, ...rowOf.get(n.id)!.map((x) => x.node.h))
	const left = (n: LayoutNode) => Math.max(n.w / 2, ...rowOf.get(n.id)!.map((x) => -x.dx))
	const right = (n: LayoutNode) => Math.max(n.w / 2, ...rowOf.get(n.id)!.map((x) => x.dx + x.node.w))
	const stepGap = (k: number) => {
		const label = (i: number) => (edges[i].labelH > 0 ? Math.max(64, edges[i].labelH + 34) : 48)
		let gap = label(mainIdx[k])
		// A detour's two steps sit one above the other, with its own arrow between them.
		const d = detours.find((t) => chain[t.a] === spine[k] && t.inner.length === 2)
		if (d) gap = Math.max(gap, label(edgeOf(d.inner[0].id, d.inner[1].id)))
		return gap
	}
	// The part below, laid out once, relative to the head's center.
	const laid = [head, ...rest].map((n) => ({ ...n }))
	const restBends = laid.length > 1 ? layoutFlowOnce(laid, restEdges.map(({ e }) => e), RANK_GAP, new Map()) : []
	// Boxes on one rank of the part below keep a gap, as reordering siblings can close it.
	const ranks = new Map<number, LayoutNode[]>()
	for (const m of laid.slice(1)) {
		const key = Math.round(m.y + m.h / 2)
		const near = [...ranks.keys()].find((k) => Math.abs(k - key) < 24)
		ranks.set(near ?? key, [...(ranks.get(near ?? key) ?? []), m])
	}
	for (const rank of ranks.values()) {
		rank.sort((a, b) => a.x - b.x)
		for (let i = 1; i < rank.length; i++) rank[i].x = Math.max(rank[i].x, rank[i - 1].x + rank[i - 1].w + 32)
	}
	const restHead = laid[0]
	const hx = restHead.x + restHead.w / 2
	const restLeft = Math.max(head.w / 2, ...laid.map((n) => hx - n.x))
	const restRight = Math.max(head.w / 2, ...laid.map((n) => n.x + n.w - hx))
	const restBelow = Math.max(0, ...laid.map((n) => n.y + n.h - (restHead.y + restHead.h)))
	// A column may not end on a detour's first row.
	const inside = new Set(detours.map((d) => spine.indexOf(chain[d.a])))
	type Col = { from: number; to: number; left: number; right: number; height: number }
	const column = (from: number, to: number): Col => {
		const steps = spine.slice(from, to + 1)
		let l = Math.max(...steps.map(left))
		let r = Math.max(...steps.map(right))
		let height = steps.reduce((h, n) => h + rowH(n), 0)
		for (let k = from; k < to; k++) height += stepGap(k)
		if (to === spine.length - 1) {
			l = Math.max(l, restLeft)
			r = Math.max(r, restRight)
			height += restBelow + (rowH(head) > head.h && restBelow > 0 ? 32 : 0)
		}
		return { from, to, left: l, right: r, height }
	}
	const gutter = (k: number) => {
		const e = edges[mainIdx[k]]
		return Math.max(88, e.labelW > 0 ? e.labelW + 48 : 0)
	}
	// Columns: every way to cut the main line into one to four runs.
	const n = spine.length
	let best: { cols: Col[]; score: number } | null = null
	const visit = (start: number, cols: Col[]) => {
		if (start === n) {
			const W = cols.reduce((w, c) => w + c.left + c.right, 0) + cols.slice(1).reduce((w, c) => w + gutter(c.from - 1), 0)
			const tallest = Math.max(...cols.map((c) => c.height))
			const fit = Math.min(1, FIT_W / W, FIT_H / (tallest + (cols.length > 1 ? 2 * ELBOW_ROOM : 0)))
			// Fewer columns read more simply, and columns of about one height look planned.
			const uneven = cols.length > 1 ? (tallest - Math.min(...cols.map((c) => c.height))) / tallest : 0
			const score = fit - (cols.length - 1) * 0.03 - uneven * 0.06
			if (!best || score > best.score) best = { cols: [...cols], score }
			return
		}
		if (cols.length === 4) return
		for (let end = start; end < n; end++) {
			// A column holds three steps or more, unless it is the last, and ends outside a detour.
			if (end < n - 1 && (inside.has(end) || end - start < 2 || cols.length === 3)) continue
			cols.push(column(start, end))
			visit(end + 1, cols)
			cols.pop()
		}
	}
	visit(0, [])
	const chosen = best as { cols: Col[]; score: number } | null
	if (!chosen) return null
	const at = new Map<string, Point>()
	const bends: Bends = edges.map(() => 0)
	const routes: (EdgeRoute | null)[] = edges.map(() => null)
	const top = chosen.cols.length > 1 ? ELBOW_ROOM : 0
	let x = 0
	const spineX: number[] = []
	chosen.cols.forEach((c, ci) => {
		if (ci > 0) x += gutter(c.from - 1)
		const cx = x + c.left
		spineX.push(cx)
		let y = top
		for (let k = c.from; k <= c.to; k++) {
			const step = spine[k]
			const cy = y + rowH(step) / 2
			at.set(step.id, { x: cx - step.w / 2, y: cy - step.h / 2 })
			for (const it of rowOf.get(step.id)!) at.set(it.node.id, { x: cx + it.dx, y: cy - it.node.h / 2 })
			y += rowH(step) + (k < c.to ? stepGap(k) : 0)
		}
		x = cx + c.right
	})
	// The part below hangs from the head.
	const headAt = at.get(head.id)!
	// It starts below anything beside the head, such as a detour's last step.
	const below = (rowH(head) - head.h) / 2 + (rowH(head) > head.h ? 32 : 0)
	for (const m of laid.slice(1)) at.set(m.id, { x: m.x - restHead.x + headAt.x, y: m.y - restHead.y + headAt.y + below })
	restEdges.forEach(({ i }, j) => (bends[i] = restBends[j] ?? 0))
	// From the foot of one column to the head of the next, down the gutter.
	chosen.cols.slice(1).forEach((c, k) => {
		const i = mainIdx[c.from - 1]
		const ax = spineX[k]
		const bx = spineX[k + 1]
		const gx = spineX[k] + chosen.cols[k].right + gutter(c.from - 1) / 2
		routes[i] = { start: { x: 0.5, y: 1 }, end: { x: 0.5, y: 0 }, mid: (gx - ax) / (bx - ax) }
	})
	bends.routes = routes
	if (nodes.some((m) => !at.has(m.id))) return null
	const placed = nodes.map((m) => ({ ...m, ...at.get(m.id)! }))
	const touch = (a: LayoutNode, b: LayoutNode) => a.x < b.x + b.w + 12 && b.x < a.x + a.w + 12 && a.y < b.y + b.h + 12 && b.y < a.y + a.h + 12
	if (placed.some((a, i) => placed.some((b, j) => j > i && touch(a, b)))) return null
	const minX = Math.min(...placed.map((m) => m.x))
	const minY = Math.min(0, ...placed.map((m) => m.y))
	const w = Math.max(...placed.map((m) => m.x + m.w)) - minX
	const h = Math.max(...placed.map((m) => m.y + m.h)) - minY + (chosen.cols.length > 1 ? ELBOW_ROOM : 0)
	return { bends, squeezed: false, fit: Math.min(1, FIT_W / w, FIT_H / h), at: placed.map((m) => ({ x: m.x - minX, y: m.y - minY })), procedure: true }
}

/**
 * A process whose main line runs a long way while its choices drop off to
 * quick ends ("No: bill stalls"), as most decision flows do, drawn top to
 * bottom is a column far taller than a screen: every early exit costs a
 * rank. Its main line wraps into rows that read left to right, then right to
 * left, as a process poster does, and each early exit hangs just under the
 * step it leaves. Rows break where no exit hangs, so each turn is a short
 * step straight down. The part after the main line's first real fork hangs
 * below the last row, laid out top to bottom. Returns null when the flow has
 * no such main line.
 */
function layoutSpine(nodes: LayoutNode[], edges: LayoutEdge[]) {
	const line = mainLine(nodes, edges)
	if (!line) return null
	const { chain, exitsOf, skips, noBreak, outOf, byId } = line
	const exitCount = [...exitsOf.values()].reduce((s, a) => s + a.length, 0)
	if (chain.length < 5 || exitCount === 0) return null
	// The head, the main line's last step, goes with the part below it.
	const head = chain[chain.length - 1]
	const inChain = new Set(chain.map((n) => n.id))
	const exitIds = new Set([...exitsOf.values()].flat().map((i) => edges[i].to))
	const cellH = Math.max(...chain.map((n) => n.h))
	const exitH = Math.max(0, ...[...exitIds].map((id) => byId.get(id)!.h))
	const exitRow = (id: string) => (exitsOf.get(id) ?? []).map((i) => byId.get(edges[i].to)!)
	const cellW = Math.max(...chain.map((n) => Math.max(n.w, exitRow(n.id).reduce((s, x) => s + x.w, 0) + (exitRow(n.id).length - 1) * 24)))
	const mainEdges = chain.slice(0, -1).map((n, k) => edges[outOf.get(n.id)!.find((i) => edges[i].to === chain[k + 1].id)!])
	const gapX = Math.max(72, ...mainEdges.map((e) => (e.labelW > 0 ? e.labelW + LABEL_ARROW_ROOM + LABEL_MARGIN : 0)))
	const exitEdges = [...exitsOf.values()].flat().map((i) => edges[i])
	const exitGap = Math.max(56, ...exitEdges.map((e) => (e.labelH > 0 ? e.labelH + LABEL_ARROW_ROOM : 0)))
	const turnGap = Math.max(64, ...mainEdges.map((e) => (e.labelH > 0 ? e.labelH + LABEL_ARROW_ROOM : 0)))
	let chosen: { fit: number; value: number; at: Map<string, Point>; bends: Bends } | null = null
	// The part after the main line, laid out once: top to bottom, or in columns.
	const restLaid = (() => {
		const rest = nodes.filter((n) => !inChain.has(n.id) && !exitIds.has(n.id))
		const laid = [head, ...rest].map((n) => ({ ...n }))
		const set = new Set(laid.map((n) => n.id))
		const restEdges = edges.map((e, i) => ({ e, i })).filter(({ e }) => set.has(e.from) && set.has(e.to))
		const restBends = laid.length > 1 ? layoutDown(laid, restEdges.map(({ e }) => e), new Map()) : []
		return { nodes: laid, restEdges, restBends }
	})()
	// The part below either hangs centered under the head, or wholly to the far
	// side of it, so its arrows do not cut through the quick ends of the steps
	// before the head.
	for (const [cols, away] of [3, 4, 5].flatMap((c) => [[c, false] as const, [c, true] as const])) {
		// Rows of up to cols steps, each ending on a step with no exit when it can.
		const rows: LayoutNode[][] = []
		let k = 0
		while (k < chain.length) {
			let len = Math.min(cols, chain.length - k)
			// A row that would end inside a detour takes the rest of the detour, up to
			// two steps more, so the arc over it stays in one row.
			let longer = len
			while (longer < cols + 2 && k + longer < chain.length && noBreak.has(chain[k + longer - 1].id)) longer++
			if (k + longer >= chain.length || !noBreak.has(chain[k + longer - 1].id)) len = longer
			while (len > 2 && k + len < chain.length && ((exitsOf.get(chain[k + len - 1].id)?.length ?? 0) > 1 || noBreak.has(chain[k + len - 1].id))) len--
			rows.push(chain.slice(k, k + len))
			k += len
		}
		const at = new Map<string, Point>()
		// Each step's column; each column as wide as its widest step and exits.
		const colOf = new Map<string, number>()
		{
			let col = 0
			let dir = 1
			rows.forEach((row, r) => {
				if (r > 0) dir = -dir
				row.forEach((n, j) => {
					if (j > 0) col += dir
					colOf.set(n.id, col)
				})
			})
		}
		const cols0 = Math.min(...colOf.values())
		const widthOf = new Map<number, number>()
		for (const n of chain) {
			const c = colOf.get(n.id)!
			const ex = exitRow(n.id)
			const need = Math.max(n.w, ex.reduce((s, x) => s + x.w, 0) + (ex.length - 1) * 24)
			widthOf.set(c, Math.max(widthOf.get(c) ?? 0, need))
		}
		const centerOf = new Map<number, number>()
		{
			let x = 0
			for (let c = cols0; widthOf.has(c); c++) {
				centerOf.set(c, x + widthOf.get(c)! / 2)
				x += widthOf.get(c)! + gapX
			}
		}
		let y = 0
		rows.forEach((row, r) => {
			// A step that ends a row turns down to the next row, so its one quick end
			// goes out to the side, past the row's end, clear of the turn.
			const turnsHere = (n: LayoutNode, j: number) => j === row.length - 1 && r < rows.length - 1 && exitRow(n.id).length === 1
			const hasExits = row.some((n, j) => (exitsOf.get(n.id)?.length ?? 0) > 0 && !turnsHere(n, j))
			const dir = r % 2 === 0 ? 1 : -1
			row.forEach((n, j) => {
				const cx = centerOf.get(colOf.get(n.id)!)!
				at.set(n.id, { x: cx - n.w / 2, y: y + (cellH - n.h) / 2 })
				const ex = exitRow(n.id)
				if (turnsHere(n, j)) {
					const e = ex[0]
					const edge = edges[exitsOf.get(n.id)![0]]
					const gap = Math.max(72, edge.labelW > 0 ? edge.labelW + LABEL_ARROW_ROOM + LABEL_MARGIN : 0)
					at.set(e.id, { x: dir > 0 ? cx + n.w / 2 + gap : cx - n.w / 2 - gap - e.w, y: y + (cellH - e.h) / 2 })
					return
				}
				const total = ex.reduce((s, x) => s + x.w, 0) + (ex.length - 1) * 24
				let x = cx - total / 2
				for (const e of ex) {
					at.set(e.id, { x, y: y + cellH + exitGap })
					x += e.w + 24
				}
			})
			y += cellH + (hasExits ? exitGap + exitH : 0) + turnGap
		})
		// The rest hangs below the head, clear of every row.
		const restNodes = restLaid.nodes.map((n) => ({ ...n }))
		const restSet = new Set(restNodes.map((n) => n.id))
		const { restEdges, restBends } = restLaid
		const restHead = restNodes[0]
		const headAt = at.get(head.id)!
		let dx = headAt.x - restHead.x
		let dy = headAt.y - restHead.y
		const others = restNodes.slice(1)
		if (away && others.length) {
			const lastRow = rows.length - 1
			const forward = lastRow % 2 === 0 ? 1 : -1
			if (forward > 0) dx += headAt.x - Math.min(...others.map((n) => n.x + dx))
			else dx += headAt.x + head.w - Math.max(...others.map((n) => n.x + dx + n.w))
		}
		if (others.length) {
			const rowsBottom = Math.max(...[...at.entries()].filter(([id]) => id !== head.id).map(([id, p]) => p.y + byId.get(id)!.h))
			const top = Math.min(...others.map((n) => n.y + dy))
			if (top < rowsBottom + 48) dy += rowsBottom + 48 - top
		}
		for (const n of others) at.set(n.id, { x: n.x + dx, y: n.y + dy })
		// Boxes on one rank of the part below keep a gap, as reordering can close it.
		const ranks = new Map<number, LayoutNode[]>()
		for (const n of others) {
			const key = Math.round(at.get(n.id)!.y + n.h / 2)
			const near = [...ranks.keys()].find((k) => Math.abs(k - key) < 24)
			ranks.set(near ?? key, [...(ranks.get(near ?? key) ?? []), n])
		}
		for (const rank of ranks.values()) {
			rank.sort((a, b) => at.get(a.id)!.x - at.get(b.id)!.x)
			for (let i = 1; i < rank.length; i++) {
				const prev = at.get(rank[i - 1].id)!
				const cur = at.get(rank[i].id)!
				const min = prev.x + rank[i - 1].w + 32
				if (cur.x < min) at.set(rank[i].id, { x: min, y: cur.y })
			}
		}
		const bends: Bends = edges.map(() => 0)
		restEdges.forEach(({ i }, j) => (bends[i] = restBends[j] ?? 0))
		const placed = nodes.map((n) => ({ ...n, ...at.get(n.id)! }))
		// The rows and their exits must stay clear of each other and of the part below.
		const inRest = (id: string) => restSet.has(id)
		const touch = (a: LayoutNode, b: LayoutNode) => a.x < b.x + b.w + 12 && b.x < a.x + a.w + 12 && a.y < b.y + b.h + 12 && b.y < a.y + a.h + 12
		if (placed.some((a, i) => placed.some((b, j) => j > i && !(inRest(a.id) && inRest(b.id)) && touch(a, b)))) continue
		// The direct way past a detour arcs clear of the detour's steps.
		// It arcs over the row, away from the quick ends that hang below it.
		for (const i of skips) {
			const a = at.get(edges[i].from)!
			const b = at.get(edges[i].to)!
			const rightward = b.x > a.x
			bends[i] = (rightward ? -1 : 1) * (cellH / 2 + 40)
		}
		const minX = Math.min(...placed.map((n) => n.x))
		const minY = Math.min(...placed.map((n) => n.y))
		const w = Math.max(...placed.map((n) => n.x + n.w)) - minX
		const h = Math.max(...placed.map((n) => n.y + n.h)) - minY
		const fit = Math.min(1, FIT_W / w, FIT_H / h)
		const value = fit - flowPenalty(nodes, edges, placed, bends)
		if (!chosen || value > chosen.value + 0.02) {
			chosen = { fit, value, bends, at: new Map(placed.map((n) => [n.id, { x: n.x - minX, y: n.y - minY }])) }
		}
	}
	const result = chosen as { fit: number; value: number; at: Map<string, Point>; bends: Bends } | null
	if (!result) return null
	return { bends: result.bends, squeezed: false, fit: result.fit, at: nodes.map((n) => result.at.get(n.id)!) }
}

/**
 * The part of a flow below its wrapped lead-in, top to bottom, or in columns
 * (see layoutColumns) when that part alone is too tall for a screen.
 */
function layoutDown(nodes: LayoutNode[], edges: LayoutEdge[], center: Map<string, Point>): Bends {
	const bends = layoutFlowOnce(nodes, edges, RANK_GAP, center)
	const minY = Math.min(...nodes.map((n) => n.y))
	const h = Math.max(...nodes.map((n) => n.y + n.h)) - minY
	if (h <= FIT_H * 0.75 || nodes.length < 6) return bends
	const minX = Math.min(...nodes.map((n) => n.x))
	const w = Math.max(...nodes.map((n) => n.x + n.w)) - minX
	const down = { fit: Math.min(1, FIT_W / w, FIT_H / h), at: nodes.map((n) => ({ x: n.x - minX, y: n.y - minY })), bends }
	const columns = layoutColumns(nodes, edges)
	const value = (o: { fit: number; at: Point[]; bends: Bends; continued?: Set<number> }) => Math.min(1, o.fit) - flowPenalty(nodes, edges, o.at, o.bends, o.continued)
	if (!columns || value(columns) <= value(down) + 0.05) return bends
	nodes.forEach((n, i) => {
		Object.assign(n, columns.at[i])
		center.set(n.id, { x: n.x + n.w / 2, y: n.y + n.h / 2 })
	})
	return columns.bends
}

/**
 * Any flow too tall for a screen, branches that rejoin included (two choices
 * that both lead to the President), wraps into two to four columns, as a
 * process poster continues in its next column. The top to bottom drawing is
 * cut between two of its layers, near where the parts come out the same
 * height, where at most three arrows cross the cut and each goes on to the
 * next part. Each quick end stays with the step it leaves. Each part is laid
 * out again on its own and the parts stand side by side. A later part either
 * drops so the step it starts on sits level with a step that leads into it,
 * so the arrow across is short and runs sideways, or starts at the top, with
 * the arrow across reading as "continued". Returns null when no cut helps.
 */
function layoutColumns(nodes: LayoutNode[], edges: LayoutEdge[]) {
	if (nodes.length < 6) return null
	const base = nodes.map((n) => ({ ...n }))
	const baseCenters = new Map<string, Point>()
	layoutFlowOnce(base, edges, RANK_GAP, baseCenters)
	// Layers of the drawing, top to bottom.
	const levels: number[] = []
	for (const y of [...baseCenters.values()].map((c) => c.y).sort((a, b) => a - b)) {
		if (!levels.length || y - levels[levels.length - 1] > 12) levels.push(y)
	}
	if (levels.length < 4) return null
	const levelOf = (id: string) => levels.findIndex((y) => Math.abs(baseCenters.get(id)!.y - y) <= 12)
	const into = new Map<string, number[]>(nodes.map((n) => [n.id, []]))
	const outOf = new Map<string, number[]>(nodes.map((n) => [n.id, []]))
	edges.forEach((e, i) => {
		into.get(e.to)!.push(i)
		outOf.get(e.from)!.push(i)
	})
	// A quick end goes with the step it leaves.
	const partOf = (cuts: number[]) => {
		const part = new Map<string, number>()
		for (const n of nodes) part.set(n.id, cuts.filter((c) => levelOf(n.id) > c).length)
		for (const n of nodes) {
			const ins = into.get(n.id)!
			if (outOf.get(n.id)!.length === 0 && ins.length === 1) part.set(n.id, part.get(edges[ins[0]].from)!)
		}
		return part
	}
	type Option = { bends: Bends; squeezed: boolean; fit: number; at: Point[]; cost: number; continued?: Set<number> }
	let best: Option | null = null
	// Whether a cut is clean: each part holds two steps or more, at most three
	// arrows cross it, and every one goes on to the next part.
	const clean = (cuts: number[]) => {
		const part = partOf(cuts)
		const count = cuts.length + 1
		const sizes = Array.from({ length: count }, (_, k) => nodes.filter((n) => part.get(n.id) === k).length)
		if (sizes.some((m) => m < 2)) return false
		const across = edges.filter((e) => part.get(e.from) !== part.get(e.to))
		return across.length <= 3 && across.every((e) => part.get(e.to)! === part.get(e.from)! + 1)
	}
	const tryCuts = (cuts: number[], level: 'low' | 'high' | 'top') => {
		const part = partOf(cuts)
		const count = cuts.length + 1
		const members = Array.from({ length: count }, (_, k) => nodes.filter((n) => part.get(n.id) === k))
		const across = edges.map((e, i) => ({ e, i })).filter(({ e }) => part.get(e.from) !== part.get(e.to))
		const at = new Map<string, Point>()
		const bends: Bends = edges.map(() => 0)
		let left = 0
		for (let k = 0; k < count; k++) {
			const own = members[k].map((n) => ({ ...n }))
			const ownSet = new Set(own.map((n) => n.id))
			const ownEdges = edges.map((e, i) => ({ e, i })).filter(({ e }) => ownSet.has(e.from) && ownSet.has(e.to))
			const ownBends = layoutFlowOnce(own, ownEdges.map(({ e }) => e), RANK_GAP, new Map())
			ownEdges.forEach(({ i }, j) => (bends[i] = ownBends[j] ?? 0))
			const minX = Math.min(...own.map((n) => n.x))
			const minY = Math.min(...own.map((n) => n.y))
			// Level the step this part starts on with the step that leads into it.
			const inbound = across.filter(({ e }) => ownSet.has(e.to))
			let dy = 0
			if (inbound.length && level !== 'top') {
				// Level with the lowest step that leads in, so no arrow across runs back
				// up, or with the highest, for a shorter drawing.
				const sources = inbound.map(({ e }) => ({ e, y: at.get(e.from)!.y + nodes.find((n) => n.id === e.from)!.h / 2 }))
				const pick = sources.reduce((a, b) => ((level === 'low' ? b.y > a.y : b.y < a.y) ? b : a))
				const target = own.find((n) => n.id === pick.e.to)!
				dy = Math.max(0, pick.y - (target.y - minY + target.h / 2))
			}
			const labelRoom = Math.max(0, ...inbound.map(({ e }) => (e.labelW > 0 ? e.labelW + LABEL_ARROW_ROOM + LABEL_MARGIN : 0)))
			const gap = k === 0 ? 0 : Math.max(120, labelRoom)
			for (const n of own) at.set(n.id, { x: left + gap + n.x - minX, y: dy + n.y - minY })
			left += gap + Math.max(...own.map((n) => n.x + n.w)) - minX
		}
		const placed = nodes.map((n) => ({ ...n, ...at.get(n.id)! }))
		const touch = (a: LayoutNode, b: LayoutNode) => a.x < b.x + b.w + 12 && b.x < a.x + a.w + 12 && a.y < b.y + b.h + 12 && b.y < a.y + a.h + 12
		if (placed.some((a, i) => placed.some((b, j) => j > i && touch(a, b)))) return
		const centers = new Map(placed.map((n) => [n.id, { x: n.x + n.w / 2, y: n.y + n.h / 2 }]))
		const placedBends = placeBends(placed, edges, centers, bends)
		// An arrow across must not run through a box on its way.
		for (const { e, i } of across) {
			const arc = arcPoints(centers.get(e.from)!, centers.get(e.to)!, placedBends[i], 24)
			if (placed.some((b) => b.id !== e.from && b.id !== e.to && arc.some((p) => p.x > b.x - 6 && p.x < b.x + b.w + 6 && p.y > b.y - 6 && p.y < b.y + b.h + 6))) return
		}
		const w = Math.max(...placed.map((n) => n.x + n.w))
		const h = Math.max(...placed.map((n) => n.y + n.h))
		const fit = Math.min(1, FIT_W / w, FIT_H / h)
		const length = across.reduce((s, { e }) => s + Math.hypot(centers.get(e.to)!.x - centers.get(e.from)!.x, centers.get(e.to)!.y - centers.get(e.from)!.y), 0)
		const at2 = placed.map((n) => ({ x: n.x, y: n.y }))
		const continued = level === 'top' ? new Set(across.map(({ i }) => i)) : undefined
		const cost = -Math.min(1, fit) + flowPenalty(nodes, edges, at2, placedBends, continued) + across.length * 0.02 + length / 40000 + (count - 2) * 0.08 + (level === 'top' ? 0.02 : 0)
		if (!best || cost < best.cost) best = { bends: placedBends, squeezed: false, fit, at: placed.map((n) => ({ x: n.x, y: n.y })), cost, continued }
	}
	// Cuts near where the parts come out about the same height, two to four parts.
	const last = levels.length - 1
	const tried = new Set<string>()
	const search = (count: number, spread: number) => {
		const ideal = Array.from({ length: count - 1 }, (_, k) => Math.round(((k + 1) * levels.length) / count) - 1)
		const visit = (k: number, cuts: number[]) => {
			if (k === ideal.length) {
				const key = cuts.join(',')
				if (tried.has(key) || !clean(cuts)) return
				tried.add(key)
				for (const level of count === 2 ? (['low', 'high', 'top'] as const) : (['low', 'top'] as const)) tryCuts(cuts, level)
				return
			}
			for (let d = -spread; d <= spread; d++) {
				const c = ideal[k] + d
				if (c < 0 || c >= last || (cuts.length && c <= cuts[cuts.length - 1])) continue
				visit(k + 1, [...cuts, c])
			}
		}
		visit(0, [])
	}
	search(2, Math.max(2, Math.floor(levels.length / 3)))
	if (levels.length >= 6) search(3, 1)
	if (levels.length >= 9) search(4, 1)
	return best as Option | null
}

/**
 * What a reader trips over in a flow drawing, in the units of fit: each pair of
 * crossing arrows, each arrow that runs back up the page (less for one that
 * continues a flow in its next column), and each arrow through a box that is
 * not one of its ends.
 */
function flowPenalty(nodes: LayoutNode[], edges: LayoutEdge[], at: Point[], bends: Bends, continued?: Set<number>) {
	// A right-angled arrow is routed clear of every box by construction.
	const routed = (i: number) => !!bends.routes?.[i]
	const placed = nodes.map((n, i) => ({ ...n, ...at[i] }))
	const byId = new Map(placed.map((n) => [n.id, n]))
	const center = (id: string) => {
		const n = byId.get(id)!
		return { x: n.x + n.w / 2, y: n.y + n.h / 2 }
	}
	const arcs = edges.map((e, i) => arcPoints(center(e.from), center(e.to), bends[i] ?? 0, 16))
	let penalty = 0
	edges.forEach((e, i) => {
		const a = byId.get(e.from)!
		const b = byId.get(e.to)!
		// The further back up an arrow runs, the more it costs.
		// An arrow from the foot of one column to the head of the next reads as
		// "continued", as on a poster, and costs only a little.
		if (routed(i)) {
			penalty += 0.03
			return
		}
		const rise = a.y - (b.y + b.h)
		if (continued?.has(i)) penalty += 0.08
		else if (rise > 0) penalty += 0.03 + rise / 700
		for (const n of placed) {
			if (n.id === e.from || n.id === e.to) continue
			if (arcs[i].some((p) => p.x > n.x && p.x < n.x + n.w && p.y > n.y && p.y < n.y + n.h)) penalty += 0.3
		}
		for (let j = i + 1; j < edges.length; j++) {
			const f = edges[j]
			if (routed(j)) continue
			if ([e.from, e.to].some((id) => id === f.from || id === f.to)) continue
			if (polylinesCross(arcs[i], arcs[j])) penalty += 0.1
		}
	})
	return penalty
}

/** The screen a diagram is read on, less a margin, and the least zoom at which its text still reads. */
const FIT_W = 1480
const FIT_H = 880
const MIN_FIT = 0.8
/** How much smaller a procedure drawn down its columns may come out and still win. */
const PROCEDURE_BONUS = 0.12

/** How many steps a flow runs in a line from its one start before it first branches; 0 without one start. */
function leadRun(nodes: LayoutNode[], edges: LayoutEdge[]) {
	const pointedTo = new Set(edges.map((e) => e.to))
	const starts = nodes.filter((n) => !pointedTo.has(n.id))
	if (starts.length !== 1) return 0
	let at: string | undefined = starts[0].id
	const seen = new Set<string>()
	let run = 0
	while (at && !seen.has(at)) {
		seen.add(at)
		const out = edges.filter((e) => e.from === at)
		if (out.length !== 1) break
		run++
		at = out[0].to
	}
	return run
}

function isTree(nodes: LayoutNode[], edges: LayoutEdge[]) {
	const into = new Map<string, number>()
	for (const e of edges) into.set(e.to, (into.get(e.to) ?? 0) + 1)
	return edges.length === nodes.length - 1 && [...into.values()].every((k) => k <= 1)
}

/** Where an edge's label puts its child: a "left" or "no" branch first, a "right" or "yes" branch last. */
function sideOf(label: string) {
	if (/^(l|left)\b/i.test(label.trim())) return 0
	if (/^(r|right)\b/i.test(label.trim())) return 2
	return 1
}

/**
 * For a flow that is a tree, lay each node's children out left to right in the
 * order of the edges into them, with an edge labeled left before one labeled
 * right. Each child moves with its whole subtree, and the subtrees keep the
 * same slots and gaps dagre gave them, so nothing new overlaps. Returns
 * whether the flow is a tree.
 */
function orderSiblings(nodes: LayoutNode[], edges: LayoutEdge[], center: Map<string, Point>) {
	if (edges.length !== nodes.length - 1) return false
	const kids = new Map<string, { id: string; side: number; index: number }[]>(nodes.map((n) => [n.id, []]))
	const parent = new Map<string, string>()
	for (const [index, e] of edges.entries()) {
		if (parent.has(e.to)) return false
		parent.set(e.to, e.from)
		kids.get(e.from)!.push({ id: e.to, side: sideOf(e.label ?? ''), index })
	}
	const roots = nodes.filter((n) => !parent.has(n.id))
	if (roots.length !== 1) return false
	const byId = new Map(nodes.map((n) => [n.id, n]))
	const subtree = (id: string): string[] => [id, ...kids.get(id)!.flatMap((k) => subtree(k.id))]
	const extent = (id: string) => {
		const ids = subtree(id)
		return {
			min: Math.min(...ids.map((k) => center.get(k)!.x - byId.get(k)!.w / 2)),
			max: Math.max(...ids.map((k) => center.get(k)!.x + byId.get(k)!.w / 2)),
		}
	}
	const visit = (id: string) => {
		const children = kids.get(id)!
		const sameRank = children.every((k) => Math.abs(center.get(k.id)!.y - center.get(children[0].id)!.y) < 1)
		if (children.length > 1 && sameRank) {
			const blocks = children.map((k) => ({ ...k, ...extent(k.id) }))
			const slots = [...blocks].sort((a, b) => a.min - b.min)
			const gaps = slots.slice(1).map((b, i) => b.min - slots[i].max)
			const wanted = [...blocks].sort((a, b) => a.side - b.side || a.index - b.index)
			let x = slots[0].min
			wanted.forEach((b, i) => {
				const shift = x - b.min
				for (const k of subtree(b.id)) center.get(k)!.x += shift
				x += b.max - b.min + (gaps[i] ?? 0)
			})
		}
		for (const k of children) visit(k.id)
	}
	visit(roots[0].id)
	return true
}

/** A chain at least this long wraps into rows instead of one tall column. */
const SNAKE_MIN = 6

/**
 * A long chain of steps, one after another with no branches, wrapped into rows
 * that read left to right, then right to left, so each turn is a short step
 * straight down (a boustrophedon, as process posters and timelines wrap). One
 * column of ten or more boxes is far taller than a screen, so zoomed to fit,
 * its text shrinks past reading size. Rows are chosen so the drawing comes out
 * about as wide as a screen. A chain that closes into a loop keeps the dagre
 * layout, which routes the closing arrow around the steps. Returns null for
 * anything that is not such a chain.
 */
function layoutSnake(nodes: LayoutNode[], edges: LayoutEdge[]): Bends | null {
	const n = nodes.length
	if (n < SNAKE_MIN || edges.length !== n - 1) return null
	const next = new Map<string, number>()
	const into = new Map<string, number>()
	for (const [i, e] of edges.entries()) {
		if (next.has(e.from) || into.has(e.to)) return null
		next.set(e.from, i)
		into.set(e.to, i)
	}
	const start = nodes.find((node) => !into.has(node.id))
	if (!start) return null
	const byId = new Map(nodes.map((node) => [node.id, node]))
	const order: LayoutNode[] = [start]
	while (next.has(order[order.length - 1].id)) {
		const node = byId.get(edges[next.get(order[order.length - 1].id)!].to)!
		if (order.includes(node)) return null
		order.push(node)
	}
	if (order.length !== n) return null
	const cellW = Math.max(...nodes.map((node) => node.w))
	const cellH = Math.max(...nodes.map((node) => node.h))
	// The room between two boxes in a row, and between rows, each wide enough for its labels.
	const edgeAfter = (k: number) => edges[next.get(order[k].id)!]
	const across = (labelW: number) => (labelW > 0 ? labelW + LABEL_ARROW_ROOM + LABEL_MARGIN : 72)
	const down = (labelH: number) => (labelH > 0 ? labelH + LABEL_ARROW_ROOM : 64)
	// Columns: the count whose drawing is closest to a 16:10 screen, at least 3.
	let best = { cols: 3, cost: Infinity, gapX: 0, gapY: 0 }
	for (let cols = 3; cols <= Math.min(n, 6); cols++) {
		let gapX = 0
		let gapY = 0
		for (let k = 0; k < n - 1; k++) {
			const turn = (k + 1) % cols === 0
			if (turn) gapY = Math.max(gapY, down(edgeAfter(k).labelH))
			else gapX = Math.max(gapX, across(edgeAfter(k).labelW))
		}
		gapY = Math.max(gapY, 64)
		gapX = Math.max(gapX, 72)
		const rows = Math.ceil(n / cols)
		const w = cols * cellW + (cols - 1) * gapX
		const h = rows * cellH + (rows - 1) * gapY
		const cost = Math.abs(Math.log(w / h / 1.6)) + (rows === 1 ? 0.5 : 0)
		if (cost < best.cost) best = { cols, cost, gapX, gapY }
	}
	const { cols, gapX, gapY } = best
	// A timeline starts each row again at the left; its turn is one arrow back
	// across, through the gap between the rows.
	const timeline = isTimeline(nodes)
	order.forEach((node, k) => {
		const row = Math.floor(k / cols)
		const col = timeline || row % 2 === 0 ? k % cols : cols - 1 - (k % cols)
		node.x = col * (cellW + gapX) + (cellW - node.w) / 2
		node.y = row * (cellH + gapY) + (cellH - node.h) / 2
	})
	// Every arrow runs straight: along a row, or down at a turn.
	return edges.map(() => 0)
}

/**
 * A flow that is one closed loop of six or more steps, such as blood through
 * the heart or the water cycle as a process, goes clockwise around a
 * rectangle: along the top, down the right side, back along the bottom, and up
 * the left side, so every arrow, the one that closes the loop too, is a short
 * straight step to a neighbor. dagre draws such a loop as one tall column with
 * the closing arrow arcing back up its whole height. Returns null for anything
 * else.
 */
function layoutLoop(nodes: LayoutNode[], edges: LayoutEdge[]): Bends | null {
	const n = nodes.length
	if (n < SNAKE_MIN || edges.length !== n) return null
	const next = new Map<string, LayoutEdge>()
	for (const e of edges) {
		if (next.has(e.from)) return null
		next.set(e.from, e)
	}
	const byId = new Map(nodes.map((node) => [node.id, node]))
	// The loop starts at the first step the agent listed.
	const order: LayoutNode[] = [nodes[0]]
	for (let k = 1; k < n; k++) {
		const e = next.get(order[k - 1].id)
		const node = e && byId.get(e.to)
		if (!node || order.includes(node)) return null
		order.push(node)
	}
	if (next.get(order[n - 1].id)?.to !== order[0].id) return null
	const cellW = Math.max(...nodes.map((node) => node.w))
	const cellH = Math.max(...nodes.map((node) => node.h))
	const gapX = Math.max(72, ...edges.map((e) => (e.labelW > 0 ? e.labelW + LABEL_ARROW_ROOM + LABEL_MARGIN : 0)))
	const gapY = Math.max(64, ...edges.map((e) => (e.labelH > 0 ? e.labelH + LABEL_ARROW_ROOM : 0)))
	// Columns and rows of the track: room for every step, at most one cell spare,
	// and a drawing as close to a 16:10 screen as that allows.
	let best: { cols: number; rows: number; cost: number } | null = null
	for (let cols = 2; cols <= n; cols++) {
		for (let rows = 2; rows <= n; rows++) {
			const cells = 2 * cols + 2 * (rows - 2)
			if (cells < n || cells > n + 1) continue
			const w = cols * cellW + (cols - 1) * gapX
			const h = rows * cellH + (rows - 1) * gapY
			const cost = Math.abs(Math.log(w / h / 1.6))
			if (!best || cost < best.cost) best = { cols, rows, cost }
		}
	}
	if (!best) return null
	const { cols, rows } = best
	// The cells clockwise from the top left.
	const cells: [number, number][] = []
	for (let c = 0; c < cols; c++) cells.push([c, 0])
	for (let r = 1; r < rows - 1; r++) cells.push([cols - 1, r])
	for (let c = cols - 1; c >= 0; c--) cells.push([c, rows - 1])
	for (let r = rows - 2; r >= 1; r--) cells.push([0, r])
	// With one cell spare, the last step skips the cell just before the start.
	const used = cells.length > n ? [...cells.slice(0, n - 1), cells[cells.length - 1]] : cells
	order.forEach((node, k) => {
		const [c, r] = used[k]
		node.x = c * (cellW + gapX) + (cellW - node.w) / 2
		node.y = r * (cellH + gapY) + (cellH - node.h) / 2
	})
	return edges.map(() => 0)
}

function layoutFlowOnce(
	nodes: LayoutNode[],
	edges: LayoutEdge[],
	rankGap: number,
	center: Map<string, Point>,
	rankdir: 'TB' | 'LR' = 'TB',
	ranking: 'sources' | 'short' = 'sources'
): Bends {
	const g = new Graph({ multigraph: true })
	g.setGraph({
		rankdir,
		nodesep: NODE_GAP,
		ranksep: rankGap,
		edgesep: 24,
		marginx: 0,
		marginy: 0,
		// Each step goes one layer below the deepest step that leads to it, so the
		// choices out of one step sit side by side in the next layer. dagre's
		// default, network simplex, shortens edges in total instead, and can push
		// a choice down past its siblings, which a one-arc arrow cannot route around.
		// A map of causes takes network simplex: each cause sits just above what it
		// leads to, so no arrow runs the whole height of the drawing.
		ranker: ranking === 'short' ? 'network-simplex' : rankFromSources,
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
	for (const n of nodes) {
		const d = g.node(n.id) as { x: number; y: number }
		center.set(n.id, { x: d.x, y: d.y })
	}
	// In a tree, siblings keep the order the agent gave them, so a binary tree's
	// left child stays on the left. dagre reorders siblings to cut crossings,
	// which a tree has none of, and that can swap them.
	const tree = rankdir === 'TB' && orderSiblings(nodes, edges, center)
	for (const n of nodes) {
		const c = center.get(n.id)!
		n.x = c.x - n.w / 2
		n.y = c.y - n.h / 2
	}
	if (tree) return placeBends(nodes, edges, center, edges.map(() => 0))
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
 * Map layout. A map that is a tree gets a mind-map layout (see layoutTree).
 * Any other map is drawn several ways and keeps the drawing with the fewest
 * problems: labels over boxes or labels, arcs over boxes, crossing edges, then
 * the zoom it needs to fit a screen and its area. The candidates: a map with
 * a main loop, such as the water cycle, pinned on a ring with the rest solved
 * around it; a map of causes without loops, in layers from the causes down to
 * the outcome; stress layouts; and force layouts by d3-force. Each labeled edge
 * is split at a label node, as in Hu's vPRISM, so labels get room of their own.
 * Every start is fixed, so the same diagram always lays out the same way.
 */
export function layoutMap(nodes: LayoutNode[], edges: LayoutEdge[], tries = MAP_TRIES): Bends {
	const tree = layoutTree(nodes, edges)
	if (tree) return tree
	let best: { score: number; centers: Map<string, Point>; bends: Bends } | null = null
	const starts: (() => Map<string, Point>)[] = []
	const kinds: string[] = []
	// The main loop goes first and largest: pinned on a ring, with the rest of the
	// map solved around it. Each loop long enough to carry the map is tried.
	for (const cycle of mainCycles(nodes, edges)) {
		const pins = ringPins(nodes, edges, cycle)
		const pinned = runStress(nodes, edges, 0, pins)
		starts.push(() => pinned)
		kinds.push('ring' + cycle.length)
		starts.push(() => compact(pinned, nodes, edges, 0.85))
		kinds.push('ring' + cycle.length + 'c')
	}
	for (let seed = 0; seed < Math.min(tries, STRESS_TRIES); seed++) {
		const stress = runStress(nodes, edges, seed)
		starts.push(() => stress)
		kinds.push('stress')
		// Stress keeps every distance, so it draws roomier than a force layout; a
		// compacted copy (as in FORBID's scaling step) competes on equal terms.
		for (const scale of [0.8, 0.65]) {
			starts.push(() => compact(stress, nodes, edges, scale))
			kinds.push('stress-c')
		}
	}
	for (let seed = 0; seed < tries; seed++) {
		starts.push(() => runForce(nodes, edges, seed))
		kinds.push('force')
	}
	// A map without loops, such as causes that converge on an outcome, can also be
	// drawn in layers, causes first and the outcome last: its streams read in one
	// direction and meet where they meet.
	// Their arrows keep the bends the layers gave them, which route each label
	// through the room the layers kept for it.
	const layeredBends = new Map<number, Bends>()
	if (isAcyclic(nodes, edges)) {
		for (const [rankdir, ranking] of [
			['TB', 'short'],
			['TB', 'sources'],
		] as const) {
			const k = starts.length
			starts.push(() => {
				const copy = nodes.map((n) => ({ ...n }))
				const centers = new Map<string, Point>()
				layeredBends.set(k, layoutFlowOnce(copy, edges, RANK_GAP, centers, rankdir, ranking))
				return centers
			})
			kinds.push('layers-' + rankdir)
		}
	}
	for (const [k, start] of starts.entries()) {
		const centers = start()
		const placed = nodes.map((n) => ({ ...n, x: centers.get(n.id)!.x - n.w / 2, y: centers.get(n.id)!.y - n.h / 2 }))
		const preferred =
			layeredBends.get(k) ??
			edges.map((e, i) => {
				const label = centers.get(labelKey(i))
				return label ? bendThrough(centers.get(e.from)!, centers.get(e.to)!, label) : 0
			})
		const bends = placeBends(placed, edges, centers, preferred)
		// Layers from causes down to the outcome read in one direction, which a
		// reader of a map of causes is looking for: worth more than one problem.
		const score = scoreLayout(placed, edges, centers, bends) - (kinds[k] === 'layers-TB' ? 12 : 0)
		if (!best || score < best.score) best = { score, centers, bends }
	}
	const { centers, bends } = untangle(nodes, edges, best!)
	const minX = Math.min(...nodes.map((n) => centers.get(n.id)!.x - n.w / 2))
	const minY = Math.min(...nodes.map((n) => centers.get(n.id)!.y - n.h / 2))
	for (const n of nodes) {
		n.x = centers.get(n.id)!.x - n.w / 2 - minX
		n.y = centers.get(n.id)!.y - n.h / 2 - minY
	}
	return bends
}

/**
 * Take out crossings a layout left by swapping two boxes' places, keeping a
 * swap only when the whole drawing scores better: the move that local
 * crossing-reduction heuristics make (Brand et al., "Using Reinforcement
 * Learning to Optimize the Global and Local Crossing Number", arXiv
 * 2509.06108), and a cheap stand-in for stress with crossing penalties
 * (Shabbeer et al., arXiv 1210.2041; Devkota et al., SPX, arXiv 1908.01769).
 * Stress keeps distances, not planarity, so a cyclic map such as the water
 * cycle can settle with one store on the wrong side of a loop; one swap puts
 * it back. Boxes of very different sizes are not swapped, so nothing lands on
 * a neighbor.
 */
function untangle(
	nodes: LayoutNode[],
	edges: LayoutEdge[],
	start: { score: number; centers: Map<string, Point>; bends: Bends }
): { score: number; centers: Map<string, Point>; bends: Bends } {
	let best = start
	if (!edges.some((_, i) => crossesAny(edges, best.centers, best.bends, i))) return best
	const evaluate = (centers: Map<string, Point>) => {
		const placed = nodes.map((n) => ({ ...n, x: centers.get(n.id)!.x - n.w / 2, y: centers.get(n.id)!.y - n.h / 2 }))
		const bends = placeBends(placed, edges, centers, edges.map(() => 0))
		return { score: scoreLayout(placed, edges, centers, bends), centers, bends }
	}
	for (let pass = 0; pass < 2; pass++) {
		let improved = false
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const a = nodes[i]
				const b = nodes[j]
				if (Math.abs(a.w - b.w) > 60 || Math.abs(a.h - b.h) > 30) continue
				const centers = new Map(best.centers)
				centers.set(a.id, best.centers.get(b.id)!)
				centers.set(b.id, best.centers.get(a.id)!)
				const next = evaluate(centers)
				if (next.score < best.score - 0.5) {
					best = next
					improved = true
				}
			}
		}
		if (!improved) break
	}
	return best
}

/** Whether every arrow can point forward in some order: no loops. */
function isAcyclic(nodes: LayoutNode[], edges: LayoutEdge[]) {
	const left = new Map<string, number>(nodes.map((n) => [n.id, 0]))
	for (const e of edges) left.set(e.to, left.get(e.to)! + 1)
	const queue = nodes.filter((n) => left.get(n.id) === 0).map((n) => n.id)
	let seen = 0
	while (queue.length) {
		const id = queue.shift()!
		seen++
		for (const e of edges) {
			if (e.from !== id) continue
			left.set(e.to, left.get(e.to)! - 1)
			if (left.get(e.to) === 0) queue.push(e.to)
		}
	}
	return seen === nodes.length
}

/** Whether edge i crosses another edge it shares no box with. */
function crossesAny(edges: LayoutEdge[], centers: Map<string, Point>, bends: Bends, i: number) {
	const arc = (k: number) => arcPoints(centers.get(edges[k].from)!, centers.get(edges[k].to)!, bends[k], 16)
	const mine = arc(i)
	return edges.some((e, k) => {
		if (k === i) return false
		if ([e.from, e.to].some((id) => id === edges[i].from || id === edges[i].to)) return false
		return polylinesCross(mine, arc(k))
	})
}

/**
 * Mind map layout, for a map that is a tree: the root in the middle and its
 * branches split to the left and right, each side a tidy tree growing outward
 * in columns, as mind-map tools draw them. Each subtree takes the height its
 * leaves need, so branches never cross, and each column sits far enough from
 * the last for the widest label on the arrows into it. Returns null for a map
 * that is not a tree, which keeps the force layout.
 */
/**
 * The shape of a map that is a tree: its root, each node's depth, and which of
 * the root's branches each node belongs to (the root's is -1). Null for a map
 * that is not a tree, or is too small to be a mind map.
 */
export interface TreeInfo {
	root: string
	depth: Map<string, number>
	branch: Map<string, number>
	children: Map<string, string[]>
}

export function treeOf(ids: string[], edges: { from: string; to: string }[]): TreeInfo | null {
	if (ids.length < 4 || edges.length !== ids.length - 1) return null
	const neighbors = new Map<string, string[]>(ids.map((id) => [id, []]))
	const pairs = new Set<string>()
	for (const e of edges) {
		const key = [e.from, e.to].sort().join(' ')
		if (pairs.has(key) || !neighbors.has(e.from) || !neighbors.has(e.to)) return null
		pairs.add(key)
		neighbors.get(e.from)!.push(e.to)
		neighbors.get(e.to)!.push(e.from)
	}
	// The root: a node nothing points to, with the most branches.
	const pointedTo = new Set(edges.map((e) => e.to))
	const root = [...ids].sort(
		(a, b) => Number(pointedTo.has(a)) - Number(pointedTo.has(b)) || neighbors.get(b)!.length - neighbors.get(a)!.length
	)[0]
	// Walk the tree from the root; a tree with n - 1 edges that reaches every node is connected.
	const children = new Map<string, string[]>()
	const depth = new Map<string, number>([[root, 0]])
	const branch = new Map<string, number>([[root, -1]])
	const queue = [root]
	while (queue.length) {
		const id = queue.shift()!
		const kids = neighbors.get(id)!.filter((k) => !depth.has(k))
		kids.forEach((k, i) => {
			depth.set(k, depth.get(id)! + 1)
			branch.set(k, id === root ? i : branch.get(id)!)
			queue.push(k)
		})
		children.set(id, kids)
	}
	if (depth.size !== ids.length) return null
	// A mind map grows out from its root. Links that point in, such as inputs
	// that feed a process, make a map of causes that only happens to be a tree.
	if (edges.some((e) => depth.get(e.to)! < depth.get(e.from)!)) return null
	return { root, depth, branch, children }
}

function layoutTree(nodes: LayoutNode[], edges: LayoutEdge[]): Bends | null {
	const info = treeOf(
		nodes.map((n) => n.id),
		edges
	)
	if (!info) return null
	const byId = new Map(nodes.map((n) => [n.id, n]))
	const { depth, children } = info
	const root = byId.get(info.root)!
	const labelInto = new Map<string, number>()
	for (const e of edges) {
		const child = depth.get(e.to)! > depth.get(e.from)! ? e.to : e.from
		labelInto.set(child, e.labelW)
	}
	// Split the root's branches into two sides of about the same height, keeping their order.
	const leaves = (id: string): number => {
		const kids = children.get(id)!
		return kids.length ? kids.reduce((s, k) => s + leaves(k), 0) : 1
	}
	const branches = children.get(root.id)!
	const total = branches.reduce((s, k) => s + leaves(k), 0)
	const right: string[] = []
	const left: string[] = []
	let used = 0
	for (const k of branches) {
		if (used < total / 2 || left.length + right.length === 0) {
			right.push(k)
			used += leaves(k)
		} else left.push(k)
	}
	let centers = new Map<string, Point>([[root.id, { x: 0, y: 0 }]])
	let ROW_GAP = 22
	const placeSide = (side: string[], dir: 1 | -1) => {
		// Columns by depth: each as wide as its widest box, after room for the labels into it.
		const columns: string[][] = []
		const collect = (id: string) => {
			const d = depth.get(id)!
			;(columns[d] ??= []).push(id)
			for (const k of children.get(id)!) collect(k)
		}
		for (const k of side) collect(k)
		const columnX = new Map<number, number>()
		let edgeX = root.w / 2
		for (let d = 1; d < columns.length; d++) {
			const ids = columns[d] ?? []
			const widest = Math.max(...ids.map((id) => byId.get(id)!.w))
			const label = Math.max(0, ...ids.map((id) => labelInto.get(id) ?? 0))
			const gap = label > 0 ? label + LABEL_ARROW_ROOM + 16 : 72
			columnX.set(d, edgeX + gap + widest / 2)
			edgeX += gap + widest
		}
		// Rows: each subtree takes the height of its leaves; a parent is centered on its children.
		const height = (id: string): number => {
			const kids = children.get(id)!
			const own = byId.get(id)!.h
			if (!kids.length) return own
			return Math.max(own, kids.reduce((s, k) => s + height(k), 0) + ROW_GAP * (kids.length - 1))
		}
		const place = (id: string, top: number) => {
			const h = height(id)
			centers.set(id, { x: dir * columnX.get(depth.get(id)!)!, y: top + h / 2 })
			const kids = children.get(id)!
			const span = kids.reduce((s, k) => s + height(k), 0) + ROW_GAP * (kids.length - 1)
			let y = top + (h - span) / 2
			for (const k of kids) {
				place(k, y)
				y += height(k) + ROW_GAP
			}
		}
		const sideHeight = side.reduce((s, k) => s + height(k), 0) + ROW_GAP * 2 * (side.length - 1)
		let y = -sideHeight / 2
		for (const k of side) {
			place(k, y)
			y += height(k) + ROW_GAP * 2
		}
	}
	// A mind map is wider than tall, as its branches spread sideways; a thin band
	// leaves the screen's height empty. Rows open up, as long as the map stays
	// well inside a screen's shape, so it reads as a balanced whole.
	const extent = () => {
		const xs = nodes.map((n) => [centers.get(n.id)!.x - n.w / 2, centers.get(n.id)!.x + n.w / 2])
		const ys = nodes.map((n) => [centers.get(n.id)!.y - n.h / 2, centers.get(n.id)!.y + n.h / 2])
		return { w: Math.max(...xs.map((x) => x[1])) - Math.min(...xs.map((x) => x[0])), h: Math.max(...ys.map((y) => y[1])) - Math.min(...ys.map((y) => y[0])) }
	}
	for (const gap of [22, 32, 44, 56]) {
		const was = centers
		const gapWas = ROW_GAP
		ROW_GAP = gap
		centers = new Map<string, Point>([[root.id, { x: 0, y: 0 }]])
		placeSide(right, 1)
		placeSide(left, -1)
		const { w, h } = extent()
		if (gap > 22 && (h > w * 0.6 || h > FIT_H * 0.9)) {
			centers = was
			ROW_GAP = gapWas
			break
		}
	}
	const minX = Math.min(...nodes.map((n) => centers.get(n.id)!.x - n.w / 2))
	const minY = Math.min(...nodes.map((n) => centers.get(n.id)!.y - n.h / 2))
	for (const n of nodes) {
		const c = centers.get(n.id)!
		c.x -= minX
		c.y -= minY
		n.x = c.x - n.w / 2
		n.y = c.y - n.h / 2
	}
	return placeBends(nodes, edges, centers, edges.map(() => 0))
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

const STRESS_TRIES = 4

/**
 * The loops a cyclic map could be drawn around, such as the water cycle's: for
 * each length, the loop through the concepts listed earliest, longest first,
 * in arrow order from the concept listed first. Only loops of four or more
 * concepts that hold at least two fifths of the map count.
 */
function mainCycles(nodes: LayoutNode[], edges: LayoutEdge[]): string[][] {
	const index = new Map(nodes.map((n, i) => [n.id, i]))
	const out = nodes.map(() => [] as number[])
	for (const e of edges) out[index.get(e.from)!].push(index.get(e.to)!)
	const best = new Map<number, number[]>()
	const sum = (c: number[]) => c.reduce((t, i) => t + i, 0)
	let budget = 50000
	const path: number[] = []
	const onPath = new Set<number>()
	const visit = (start: number, v: number) => {
		if (--budget < 0) return
		for (const w of out[v]) {
			if (w === start && path.length >= 4) {
				const was = best.get(path.length)
				if (!was || sum(path) < sum(was)) best.set(path.length, [...path])
			} else if (w > start && !onPath.has(w)) {
				path.push(w)
				onPath.add(w)
				visit(start, w)
				path.pop()
				onPath.delete(w)
			}
		}
	}
	for (let s = 0; s < nodes.length; s++) {
		path.length = 0
		onPath.clear()
		path.push(s)
		onPath.add(s)
		visit(s, s)
	}
	return [...best.entries()]
		.filter(([length]) => length * 5 >= nodes.length * 2)
		.sort((a, b) => b[0] - a[0])
		.slice(0, 3)
		.map(([, cycle]) => {
			// Start the loop at the concept listed first.
			const first = cycle.indexOf(Math.min(...cycle))
			return [...cycle.slice(first), ...cycle.slice(0, first)].map((i) => nodes[i].id)
		})
}

/** The room an arrow between two pinned neighbors needs between their boxes. */
function linkRoom(e: LayoutEdge | undefined) {
	return e && e.labelW > 0 ? e.labelW + LABEL_ARROW_ROOM + LABEL_MARGIN : 90
}

/**
 * The main loop pinned clockwise on an ellipse a screen's shape, starting at
 * the top, as a teacher draws a cycle: just large enough that every arrow
 * around it has room for its label between its two boxes.
 */
function ringPins(nodes: LayoutNode[], edges: LayoutEdge[], cycle: string[]): Map<string, Point> {
	const byId = new Map(nodes.map((n) => [n.id, n]))
	const count = cycle.length
	const at = (scale: number) =>
		cycle.map((_, k) => {
			const angle = -Math.PI / 2 + (2 * Math.PI * k) / count
			return { x: Math.cos(angle) * scale * 1.6, y: Math.sin(angle) * scale }
		})
	// Half a box's extent along a direction (the support of a rectangle).
	const reachAlong = (n: LayoutNode, ux: number, uy: number) => (n.w / 2) * Math.abs(ux) + (n.h / 2) * Math.abs(uy)
	const fits = (scale: number) => {
		const p = at(scale)
		return cycle.every((id, k) => {
			const next = cycle[(k + 1) % count]
			const dx = p[(k + 1) % count].x - p[k].x
			const dy = p[(k + 1) % count].y - p[k].y
			const d = Math.hypot(dx, dy) || 1
			const gap = d - reachAlong(byId.get(id)!, dx / d, dy / d) - reachAlong(byId.get(next)!, dx / d, dy / d)
			return gap >= linkRoom(edges.find((e) => e.from === id && e.to === next))
		})
	}
	let scale = 120
	while (!fits(scale) && scale < 2000) scale += 10
	const p = at(scale)
	return new Map(cycle.map((id, k) => [id, p[k]]))
}

/**
 * One stress layout (Gansner, Koren, and North, "Graph Drawing by Stress
 * Majorization", 2004, the method behind Graphviz neato). Every pair of bodies
 * wants to sit as far apart as the shortest path between them, where each step
 * of a path is as long as its two ends need. Each labeled edge is split at a
 * label body, as in runForce. Pairs are weighted by 1 / d², so near neighbors
 * count most, which keeps linked boxes close and short arcs short: the long
 * arcs a force layout leaves on a cyclic map are what this fixes. Seed 0 starts
 * on a circle in the given order, the others from fixed scattered starts.
 * Pinned nodes, such as a main loop on its ring, hold their places while the
 * rest settles around them.
 */
function runStress(nodes: LayoutNode[], edges: LayoutEdge[], seed: number, pins?: Map<string, Point>): Map<string, Point> {
	type Body = { key: string; w: number; h: number; x: number; y: number }
	const rand = random(seed + 101)
	const bodies: Body[] = nodes.map((n) => ({ key: n.id, w: n.w, h: n.h, x: 0, y: 0 }))
	const index = new Map(bodies.map((b, i) => [b.key, i]))
	const reach = (b: Body) => Math.max(b.w, b.h) / 2
	const links: [number, number, number][] = []
	edges.forEach((e, i) => {
		const a = index.get(e.from)!
		const b = index.get(e.to)!
		if (e.labelW <= 0) {
			links.push([a, b, reach(bodies[a]) + reach(bodies[b]) + 90])
			return
		}
		const label: Body = { key: labelKey(i), w: e.labelW + LABEL_MARGIN * 2, h: e.labelH + LABEL_MARGIN, x: 0, y: 0 }
		bodies.push(label)
		const l = bodies.length - 1
		index.set(label.key, l)
		const half = label.w / 2 + LABEL_ARROW_ROOM / 2
		links.push([a, l, reach(bodies[a]) + half], [l, b, half + reach(bodies[b])])
	})
	const n = bodies.length
	// Shortest paths (Floyd-Warshall; a board diagram has at most a few dozen bodies).
	const d = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)))
	for (const [a, b, len] of links) {
		d[a][b] = Math.min(d[a][b], len)
		d[b][a] = Math.min(d[b][a], len)
	}
	for (let k = 0; k < n; k++)
		for (let i = 0; i < n; i++)
			for (let j = 0; j < n; j++) if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j]
	// Parts that are not connected sit a fixed distance apart.
	const finite = d.flat().filter((v) => Number.isFinite(v))
	const far = Math.max(...finite, 200) * 1.2
	for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (!Number.isFinite(d[i][j])) d[i][j] = far
	// Start: nodes on a circle (or scattered), labels between their ends.
	const spread = 160 * Math.sqrt(nodes.length)
	nodes.forEach((_, i) => {
		const angle = (2 * Math.PI * i) / nodes.length
		bodies[i].x = seed === 0 ? Math.cos(angle) * spread : (rand() - 0.5) * 2 * spread
		bodies[i].y = seed === 0 ? Math.sin(angle) * spread : (rand() - 0.5) * 2 * spread
	})
	// Pinned nodes hold their place; each free node starts beside the pinned
	// nodes it links to.
	const fixed = new Set<number>()
	if (pins) {
		const pinnedAt = [...pins.values()]
		const mid = { x: pinnedAt.reduce((t, p) => t + p.x, 0) / pinnedAt.length, y: pinnedAt.reduce((t, p) => t + p.y, 0) / pinnedAt.length }
		nodes.forEach((n, i) => {
			const p = pins.get(n.id)
			if (!p) return
			bodies[i].x = p.x
			bodies[i].y = p.y
			fixed.add(i)
		})
		nodes.forEach((n, i) => {
			if (fixed.has(i)) return
			const near = edges.flatMap((e) => (e.from === n.id ? [e.to] : e.to === n.id ? [e.from] : [])).flatMap((id) => (pins.has(id) ? [pins.get(id)!] : []))
			const c = near.length ? { x: near.reduce((t, p) => t + p.x, 0) / near.length, y: near.reduce((t, p) => t + p.y, 0) / near.length } : mid
			// Outside the ring, beside what it links to.
			const out = { x: c.x - mid.x, y: c.y - mid.y }
			const len = Math.hypot(out.x, out.y)
			const push = len > 1 ? { x: (out.x / len) * 160, y: (out.y / len) * 160 } : { x: 0, y: i % 2 ? 160 : -160 }
			bodies[i].x = c.x + push.x + (rand() - 0.5) * 40
			bodies[i].y = c.y + push.y + (rand() - 0.5) * 40
		})
	}
	edges.forEach((e, i) => {
		const l = index.get(labelKey(i))
		if (l === undefined) return
		const a = bodies[index.get(e.from)!]
		const b = bodies[index.get(e.to)!]
		bodies[l].x = (a.x + b.x) / 2 + (rand() - 0.5) * 10
		bodies[l].y = (a.y + b.y) / 2 + (rand() - 0.5) * 10
	})
	// Majorization, one body at a time (the localized update of the paper).
	const sweep = () => {
		let moved = 0
		for (let i = 0; i < n; i++) {
			if (fixed.has(i)) continue
			let sx = 0
			let sy = 0
			let sw = 0
			for (let j = 0; j < n; j++) {
				if (i === j) continue
				const w = 1 / (d[i][j] * d[i][j])
				const dx = bodies[i].x - bodies[j].x
				const dy = bodies[i].y - bodies[j].y
				const dist = Math.hypot(dx, dy) || 1e-3
				sx += w * (bodies[j].x + (d[i][j] * dx) / dist)
				sy += w * (bodies[j].y + (d[i][j] * dy) / dist)
				sw += w
			}
			const nx = sx / sw
			const ny = sy / sw
			moved += Math.hypot(nx - bodies[i].x, ny - bodies[i].y)
			bodies[i].x = nx
			bodies[i].y = ny
		}
		return moved
	}
	for (let iter = 0; iter < 300; iter++) if (sweep() / n < 0.05) break
	// Stress plus crossings (after Shabbeer et al., arXiv 1210.2041, and SPX,
	// arXiv 1908.01769): a line between the midpoints of two crossing links
	// should separate them, so each end on the wrong side moves a step across
	// it, and a stress sweep restores the distances. Stress alone keeps
	// distances, not planarity.
	for (let iter = 0; iter < 80; iter++) {
		let crossed = 0
		for (let p = 0; p < links.length; p++) {
			for (let q = p + 1; q < links.length; q++) {
				const [a, b] = links[p]
				const [c, e] = links[q]
				if (a === c || a === e || b === c || b === e) continue
				if (!segmentsCross(bodies[a], bodies[b], bodies[c], bodies[e])) continue
				crossed++
				let wx = (bodies[a].x + bodies[b].x - bodies[c].x - bodies[e].x) / 2
				let wy = (bodies[a].y + bodies[b].y - bodies[c].y - bodies[e].y) / 2
				if (Math.hypot(wx, wy) < 1) {
					wx = -(bodies[b].y - bodies[a].y)
					wy = bodies[b].x - bodies[a].x
				}
				const norm = Math.hypot(wx, wy) || 1
				const step = 12
				for (const i of [a, b]) {
					if (fixed.has(i)) continue
					bodies[i].x += (wx / norm) * step
					bodies[i].y += (wy / norm) * step
				}
				for (const i of [c, e]) {
					if (fixed.has(i)) continue
					bodies[i].x -= (wx / norm) * step
					bodies[i].y -= (wy / norm) * step
				}
			}
		}
		if (!crossed) break
		sweep()
	}
	for (let i = 0; i < 80; i++) if (!separate(bodies)) break
	return new Map(bodies.map((b) => [b.key, { x: b.x, y: b.y }]))
}

/**
 * A layout drawn closer together: every center moves toward the middle by this
 * scale, then overlap is removed again. The shape of the drawing stays; only
 * the empty space shrinks (the scaling step of Giovannangeli et al., FORBID, 2022).
 */
function compact(centers: Map<string, Point>, nodes: LayoutNode[], edges: LayoutEdge[], scale: number) {
	const bodies = [
		...nodes.map((n) => ({ key: n.id, w: n.w, h: n.h })),
		...edges.flatMap((e, i) => (e.labelW > 0 ? [{ key: labelKey(i), w: e.labelW + LABEL_MARGIN * 2, h: e.labelH + LABEL_MARGIN }] : [])),
	].map((b) => ({ ...b, x: centers.get(b.key)!.x * scale, y: centers.get(b.key)!.y * scale }))
	for (let i = 0; i < 120; i++) if (!separate(bodies)) break
	return new Map(bodies.map((b) => [b.key, { x: b.x, y: b.y }]))
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
	const own = (id: string) => boxes.find((b) => b.id === id)!
	// Each label sits where tldraw puts it: the middle of its arc. A label too
	// long for the arrow between its boxes is squeezed: narrower, on more lines,
	// so it takes more height and can reach a neighbor.
	const labelBoxes = edges.flatMap((e, i) => {
		if (e.labelW <= 0) return []
		const a = center(e.from)
		const b = center(e.to)
		const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
		const n = bendNormal(a, b)
		const at = { x: (a.x + b.x) / 2 + n.x * bends[i], y: (a.y + b.y) / 2 + n.y * bends[i] }
		// tldraw's rule: on an arrow whose body is wider than tall, the label is
		// at most the body's width less 64. The estimate keeps a margin.
		const body = arcBody(arcPoints(a, b, bends[i], 24), own(e.from), own(e.to))
		const squeezed = body.w > body.h && body.w - LABEL_ARROW_ROOM < e.labelW + 50
		const w = squeezed ? Math.max(LABEL_ARROW_ROOM, Math.min(e.labelW, body.w - LABEL_ARROW_ROOM)) : e.labelW
		const h = squeezed ? e.labelH * Math.min(4, Math.ceil(e.labelW / w)) : e.labelH
		return [{ minX: at.x - w / 2, maxX: at.x + w / 2, minY: at.y - h / 2, maxY: at.y + h / 2, len, edge: e, index: i, squeezed }]
	})
	const hit = (A: { minX: number; minY: number; maxX: number; maxY: number }, B: typeof A) =>
		Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX) > -6 && Math.min(A.maxY, B.maxY) - Math.max(A.minY, B.minY) > -6
	let problems = 0
	for (let i = 0; i < labelBoxes.length; i++) {
		for (const box of boxes) if (hit(labelBoxes[i], box)) problems += 5
		for (let j = i + 1; j < labelBoxes.length; j++) if (hit(labelBoxes[i], labelBoxes[j])) problems += 5
		// A squeezed label reads badly on its extra lines.
		if (labelBoxes[i].squeezed) problems += 1
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
	// A map shrunk to fit the screen loses its text size: every tenth of zoom
	// lost costs nearly half a problem.
	const fit = Math.min(1, FIT_W / (maxX - minX || 1), FIT_H / (maxY - minY || 1))
	return problems * 10 + aspect * 3 + area / 400000 + (1 - fit) * 45
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
		let best = { cost: Infinity, bend: 0, label: null as Rect | null, arc: [] as Point[] }
		for (const bend of candidates) {
			const arc = arcPoints(a, b, bend, e.labelW > 0 ? 24 : 12)
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
				if (squeezes(arc, ownA, ownB, e.labelW)) cost += 25
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


/** The size of the part of an arc between its two boxes. */
function arcBody(arc: Point[], a: { minX: number; minY: number; maxX: number; maxY: number }, b: typeof a) {
	const inside = (p: Point, r: typeof a) => p.x > r.minX && p.x < r.maxX && p.y > r.minY && p.y < r.maxY
	const body = arc.filter((p) => !inside(p, a) && !inside(p, b))
	if (body.length < 2) return { w: 0, h: 0 }
	return { w: Math.max(...body.map((p) => p.x)) - Math.min(...body.map((p) => p.x)), h: Math.max(...body.map((p) => p.y)) - Math.min(...body.map((p) => p.y)) }
}

/**
 * Whether tldraw would squeeze a label onto more lines: it does when the part
 * of the arrow between its boxes is wider than tall and shorter than the label
 * plus its padding.
 */
function squeezes(arc: Point[], a: { minX: number; minY: number; maxX: number; maxY: number }, b: typeof a, labelW: number) {
	const inside = (p: Point, r: typeof a) => p.x > r.minX && p.x < r.maxX && p.y > r.minY && p.y < r.maxY
	const body = arc.filter((p) => !inside(p, a) && !inside(p, b))
	if (body.length < 2) return true
	const w = Math.max(...body.map((p) => p.x)) - Math.min(...body.map((p) => p.x))
	const h = Math.max(...body.map((p) => p.y)) - Math.min(...body.map((p) => p.y))
	return w > h && w - LABEL_ARROW_ROOM < labelW
}

function isSqueezed(nodes: LayoutNode[], e: LayoutEdge, centers: Map<string, Point>, bend: number) {
	if (e.labelW <= 0) return false
	const box = (id: string) => {
		const n = nodes.find((m) => m.id === id)!
		return { minX: n.x, minY: n.y, maxX: n.x + n.w, maxY: n.y + n.h }
	}
	return squeezes(arcPoints(centers.get(e.from)!, centers.get(e.to)!, bend, 24), box(e.from), box(e.to), e.labelW)
}
