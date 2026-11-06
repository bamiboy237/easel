import { Box, TLArrowShape, TLDefaultColorStyle, TLGeoShape, TLShapeId, TLTextShape, toRichText } from 'tldraw'
import { DiagramAction } from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { AgentHelpers } from '../AgentHelpers'
import { AgentActionUtil, registerActionUtil } from './AgentActionUtil'
import { layoutFlow, LayoutNode, layoutMap, TreeInfo, treeOf } from '../shapes/diagram/layout'
import { drawTimeline, groupInks, isDatedChain } from '../shapes/diagram/timeline'

/** Box sizes for a node: wide enough for a short label on one or two lines. */
const NODE_MIN_W = 120
const NODE_MAX_W = 220
const NODE_H = 64
const NODE_PAD = 36
/** Room under a diagram for its legend. */
const LEGEND_ROOM = 60
/** The longest one-line question a decision diamond holds. */
const DIAMOND_MAX_LINE = 210
/** A question wider than this on one line breaks onto two inside its diamond. */
const DIAMOND_SPLIT_LINE = 150
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

/** tldraw's geo label sizes, in px, for the sizes a diagram uses. */
const LABEL_FONT_SIZE = { s: 18, m: 22, l: 26 } as const

/**
 * One ink per branch of a mind map, in an order where neighbors differ in hue.
 * The paper theme mutes every ink, so these sit quietly on the board.
 */
const BRANCH_COLORS = ['blue', 'orange', 'green', 'violet', 'red', 'yellow', 'light-blue', 'light-green'] as const

interface NodeStyle {
	size: 's' | 'm' | 'l'
	color: TLDefaultColorStyle
	fill: 'none' | 'solid'
}

/**
 * How a box looks. In a mind map the root is the largest and tinted, a
 * branch's first box is a size down and tinted in the branch's ink, and the
 * boxes past it are smaller still and outlined in that ink: hierarchy shows in
 * size, then in weight, then in color, so the eye starts at the center and
 * reads out one tier at a time.
 */
function nodeStyle(tree: TreeInfo | null, id: string, hub: string | null = null): NodeStyle {
	if (id === hub) return { size: 'l', color: 'black', fill: 'solid' }
	if (!tree) return { size: 's', color: 'black', fill: 'none' }
	if (id === tree.root) return { size: 'l', color: 'black', fill: 'solid' }
	const color = BRANCH_COLORS[(tree.branch.get(id) ?? 0) % BRANCH_COLORS.length]
	const first = tree.depth.get(id) === 1
	return { size: first ? 'm' : 's', color, fill: first ? 'solid' : 'none' }
}

/** The look of a diagram box from before the layout recorded its own, for older boards. */
const DEFAULT_NODE_STYLE = { geo: 'rectangle', color: 'black', fill: 'none', size: 's' } as const

type NodeGeo = 'rectangle' | 'oval' | 'diamond'

/**
 * The flowchart symbol for each step of a process flow (ISO 5807): the steps
 * where the flow starts and ends are pills, and a step worded as a question is
 * a decision diamond, so the reader finds the way in, the way out, and the
 * choices at a glance. A flow that is a tree, such as a binary tree or a
 * system's parts, holds things rather than steps, and keeps plain boxes, as
 * does every map.
 */
function flowSymbols(layout: string, ids: string[], labels: Map<string, string>, edges: DiagramEdge[]) {
	const geo = new Map<string, NodeGeo>(ids.map((id) => [id, 'rectangle']))
	if (layout !== 'flow' || ids.length < 4) return geo
	const into = new Map<string, number>(ids.map((id) => [id, 0]))
	const out = new Map<string, number>(ids.map((id) => [id, 0]))
	for (const e of edges) {
		into.set(e.to, into.get(e.to)! + 1)
		out.set(e.from, out.get(e.from)! + 1)
	}
	const isTree = edges.length === ids.length - 1 && ids.every((id) => into.get(id)! <= 1)
	const isChain = isTree && ids.every((id) => out.get(id)! <= 1)
	if (isTree && !isChain && !isProcessTree(ids, labels, edges, out)) return geo
	// A step whose ways out are a yes and a no, or a pass and a fail, is a choice
	// even when it is not worded as a question.
	const choice = new Set(
		ids.filter((id) => {
			const inks = new Set(edges.filter((e) => e.from === id).map((e) => branchInk('flow', e.label)))
			return inks.has('green') && inks.has('red')
		})
	)
	for (const id of ids) {
		if (into.get(id) === 0 || out.get(id) === 0) geo.set(id, 'oval')
		else if (out.get(id)! >= 2 && (/\?\s*$/.test(labels.get(id) ?? '') || choice.has(id))) geo.set(id, 'diamond')
	}
	return geo
}

/**
 * Whether a flow that is a tree is a process rather than a set of things (a
 * binary tree, a system's parts): it runs through three or more steps in a
 * line before it first branches, it asks a question, or its branches are
 * labeled as the ways out of a choice (yes and no, passes and fails).
 */
function isProcessTree(ids: string[], labels: Map<string, string>, edges: DiagramEdge[], out: Map<string, number>) {
	if (ids.some((id) => /\?\s*$/.test(labels.get(id) ?? '') && out.get(id)! >= 2)) return true
	if (edges.some((e) => branchInk('flow', e.label))) return true
	const pointedTo = new Set(edges.map((e) => e.to))
	let at = ids.find((id) => !pointedTo.has(id))
	let run = 0
	while (at && out.get(at) === 1) {
		run++
		at = edges.find((e) => e.from === at)?.to
	}
	return run >= 3
}

/**
 * The ink of a flow's end: an outcome that stops the process (fails, dies,
 * rejected) is red, and one that reaches the goal (becomes law, approved,
 * done) is green, as is an end reached by a green branch; other ends stay in
 * plain ink. A reader sees at a glance which ways out succeed.
 */
function outcomeInk(label: string, incoming: TLDefaultColorStyle | null): TLDefaultColorStyle | null {
	if (/\b(not|fails?|failed|dies|died|rejected|denied|vetoed|killed|stops?|blocked|invalid|lost|error)\b/i.test(label)) return 'red'
	if (/\b(becomes?|became|approved|accepted|passes|passed|succeeds?|success|done|complete[ds]?|enacted|wins?|valid|found)\b/i.test(label)) return 'green'
	if (/\bveto(ed)?\b/i.test(label)) return 'red'
	return incoming === 'green' || incoming === 'red' ? incoming : null
}

/**
 * The main concept of a concept map that is not a tree: the one outcome that
 * three or more concepts lead to, or else the one concept that only points
 * out, to three or more others. A concept map reads from its most general
 * concept (Novak), and a map of causes toward its outcome, so that one gets the
 * root's look. Null when no single concept is that.
 */
function hubOf(layout: string, tree: TreeInfo | null, ids: string[], edges: DiagramEdge[]) {
	if (layout !== 'map' || tree) return null
	const into = new Map<string, number>()
	for (const e of edges) into.set(e.to, (into.get(e.to) ?? 0) + 1)
	const out = new Map<string, number>()
	for (const e of edges) out.set(e.from, (out.get(e.from) ?? 0) + 1)
	// A map of causes reads toward its outcome: the one concept that three or
	// more others lead to and that leads nowhere, such as "Revolution of 1789".
	const outcomes = ids.filter((id) => !out.has(id) && (into.get(id) ?? 0) >= 3)
	if (outcomes.length === 1) return outcomes[0]
	const sources = ids.filter((id) => !into.has(id) && (out.get(id) ?? 0) >= 3)
	return sources.length === 1 ? sources[0] : null
}

/**
 * The ink of a flow's arrow from its label: a branch that goes ahead (yes,
 * passes, signs) is green, and one that stops or turns back (no, fails,
 * vetoes) is red, so the two ways out of a choice differ at a glance. Every
 * other arrow stays in plain ink.
 */
function branchInk(layout: string, label: string): TLDefaultColorStyle | null {
	if (layout !== 'flow') return null
	if (/^(yes|true|pass(es|ed)?|succeeds?|success|approved?|signs?|valid|found)\b/i.test(label)) return 'green'
	if (/^(no|false|fails?|failed|rejected?|vetoe?s?|invalid|not)\b/i.test(label)) return 'red'
	return null
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
			const named: { id: string; label: string }[] = []
			for (const raw of rawNodes) {
				const id = String(raw.id ?? '').trim()
				if (!id || seen.has(id)) continue
				seen.add(id)
				named.push({ id, label: String(raw.label ?? id).trim() })
			}
			if (named.length === 0) return
			// A timeline is laid out in columns of dates, a spine with dots, and events,
			// once the action is whole: its rows sort by date, so a preview would jump.
			// A flow of dated steps joined by plain arrows is a timeline drawn the long way.
			const asTimeline =
				action.layout === 'timeline' ||
				(action.layout === 'flow' &&
					isDatedChain(
						named.map((n) => n.label),
						rawEdges.map((e) => ({ from: String(e.from), to: String(e.to), label: String(e.label ?? '') })),
						named.map((n) => n.id)
					))
			if (asTimeline) {
				if (preview) return
				const raw = new Map(rawNodes.map((r) => [String(r.id ?? '').trim(), r]))
				const events = named.map(({ id, label }) => {
					const r = raw.get(id)
					const opt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
					return { id, label, date: opt(r?.date), group: opt(r?.group), note: opt(r?.note) }
				})
				const prefix = diagramPrefix(diagramId)
				const idOf = (key: string) => `${prefix}tl-${slug(key)}-${hash(key)}` as TLShapeId
				drawTimeline(editor, diagramId, prefix, idOf, helpers.removeOffsetFromVec({ x: action.x ?? 0, y: action.y ?? 0 }), events, measure)
				return
			}
			const edges: DiagramEdge[] = rawEdges
				.map((e) => ({ from: String(e.from), to: String(e.to), label: String(e.label ?? '').trim() }))
				.filter((e) => seen.has(e.from) && seen.has(e.to) && e.from !== e.to)
			// A map that is a tree is a mind map: its root reads first, larger and
			// tinted, and each of the root's branches keeps one ink, as mind maps use
			// color to group a branch (Buzan). Other diagrams stay in plain ink.
			const tree =
				action.layout === 'map'
					? treeOf(
							named.map((n) => n.id),
							edges
						)
					: null
			const hub = hubOf(
				action.layout ?? 'flow',
				tree,
				named.map((n) => n.id),
				edges
			)
			const geoOf = flowSymbols(
				action.layout ?? 'flow',
				named.map((n) => n.id),
				new Map(named.map((n) => [n.id, n.label])),
				edges
			)
			// Groups: when the parts belong to kinds the reader should tell apart, such
			// as oxygen-poor and oxygen-rich blood, each kind gets one wash, and a
			// legend under the diagram names them. A mind map already colors its
			// branches, and a flow's green and red stay for its ways out.
			const rawById = new Map(rawNodes.map((r) => [String(r.id ?? '').trim(), r]))
			const groupOfNode = new Map<string, string>()
			for (const n of named) {
				const g = rawById.get(n.id)?.group
				if (typeof g === 'string' && g.trim()) groupOfNode.set(n.id, g.trim())
			}
			const groupNames = [...new Set(named.map((n) => groupOfNode.get(n.id)).filter((g): g is string => !!g))]
			const useGroups = !tree && groupNames.length >= 2 && groupNames.length <= 5
			const withChoices = edges.some((e) => branchInk(action.layout ?? 'flow', e.label))
			const groupInk = useGroups
				? groupInks(groupNames, withChoices ? ['blue', 'violet', 'orange', 'light-blue', 'yellow'] : ['blue', 'red', 'green', 'violet', 'orange'])
				: new Map<string, TLDefaultColorStyle>()
			// A decision's question as it is drawn, on one line or two.
			const lines = new Map<string, string>()
			const nodes: (LayoutNode & { label: string })[] = named.map(({ id, label }) => {
				const fontSize = LABEL_FONT_SIZE[nodeStyle(tree, id, hub).size]
				const maxW = NODE_MAX_W + (fontSize - 18) * 8
				const measured = measure(label, fontSize, maxW - NODE_PAD)
				let w = Math.min(maxW, Math.max(NODE_MIN_W, measured.w + NODE_PAD))
				let h = Math.max(NODE_H, measured.h + 28)
				// A pill's round ends and a diamond's corners take room from the label.
				if (geoOf.get(id) === 'oval') w += 28
				if (geoOf.get(id) === 'diamond') {
					// tldraw wraps a diamond's label to nearly the shape's full width, but
					// the diamond is only that wide at its middle. A short question on one
					// line sits inside when the diamond is about twice as wide; a long one
					// stays a box, which holds it, and keeps its colored ways out.
					const line = measure(label, fontSize, 1000)
					// A longer question breaks onto two balanced lines, which keeps the
					// diamond about half as wide as one line would need.
					const words = label.split(/\s+/)
					const split =
						line.w > DIAMOND_SPLIT_LINE && words.length > 1
							? words
									.map((_, i) => [words.slice(0, i + 1).join(' '), words.slice(i + 1).join(' ')])
									.slice(0, -1)
									.map(([a, b]) => ({ a, b, w: Math.max(measure(a, fontSize, 1000).w, measure(b, fontSize, 1000).w) }))
									.reduce((p, q) => (q.w < p.w ? q : p))
							: null
					if (split && split.w <= DIAMOND_MAX_LINE) {
						lines.set(id, `${split.a}\n${split.b}`)
						w = Math.round(Math.max(170, split.w * 1.9 + 40))
						h = Math.round(Math.max(120, line.h * 2 * 2.3, w * 0.45))
					} else if (line.w <= DIAMOND_MAX_LINE) {
						w = Math.round(Math.max(170, line.w * 1.9 + 40))
						h = Math.round(Math.max(110, line.h * 3, w * 0.42))
					} else {
						geoOf.set(id, 'rectangle')
					}
				}
				return { id, label, w, h, x: 0, y: 0 }
			})
			// Each label gets its own room in the layout, so it is never squeezed or covered.
			const layoutEdges = edges.map((e) => {
				if (!e.label) return { from: e.from, to: e.to, labelW: 0, labelH: 0 }
				const size = measure(e.label, EDGE_LABEL_FONT_SIZE, EDGE_LABEL_MAX_W)
				return { from: e.from, to: e.to, label: e.label, labelW: size.w + EDGE_LABEL_PAD, labelH: size.h + EDGE_LABEL_PAD }
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
					h: Math.max(...nodes.map((n) => n.y + n.h)) + (useGroups ? LEGEND_ROOM : 0),
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
				const geo = geoOf.get(node.id) ?? 'rectangle'
				// Ends of a flow are tinted lightly: the smallest difference that still reads (Tufte).
				const ink = groupInk.get(groupOfNode.get(node.id) ?? '')
				const base = ink ? { ...nodeStyle(tree, node.id, hub), color: ink, fill: 'solid' as const } : nodeStyle(tree, node.id, hub)
				const incoming = edges.find((e) => e.to === node.id)
				const endInk =
					geo === 'oval' && incoming && !edges.some((e) => e.from === node.id)
						? outcomeInk(node.label, branchInk(action.layout ?? 'flow', incoming.label))
						: null
				const style = geo === 'oval' ? { ...base, fill: 'solid' as const, ...(endInk ? { color: endInk } : {}) } : base
				const props = { w: node.w, h: node.h, geo, richText: toRichText(lines.get(node.id) ?? node.label), ...style }
				// The look the layout chose, kept so a redraw can tell it from the user's own.
				const laidOutStyle = { geo, color: style.color, fill: style.fill, size: style.size }
				if (!existing) {
					editor.createShape<TLGeoShape>({
						id,
						type: 'geo',
						x: at.x,
						y: at.y,
						meta: { ...meta, laidOutStyle },
						isLocked: preview,
						props: { ...props, font: 'serif' },
					})
					continue
				}
				const last = existing.meta.laidOutAt as { x: number; y: number } | undefined
				const movedByUser = !!last && (Math.abs(existing.x - last.x) > 1 || Math.abs(existing.y - last.y) > 1)
				if (movedByUser) movedNodes.add(node.id)
				// A style the user changed stays theirs: the layout restyles only what
				// still has the look it gave last time.
				const prior = existing.meta.laidOutStyle as Partial<typeof laidOutStyle> | undefined
				const keptStyle: Partial<typeof laidOutStyle> = {}
				// What the layout last applied for each kept key, so a later redraw
				// still sees the user's value as theirs.
				const appliedBefore: Partial<typeof laidOutStyle> = {}
				for (const key of ['geo', 'color', 'fill', 'size'] as const) {
					const was = prior?.[key] ?? DEFAULT_NODE_STYLE[key]
					if (existing.props[key] !== was) {
						;(keptStyle as Record<string, unknown>)[key] = existing.props[key]
						;(appliedBefore as Record<string, unknown>)[key] = was
					}
				}
				editor.updateShape<TLGeoShape>({
					id,
					type: 'geo',
					...(movedByUser ? {} : { x: at.x, y: at.y }),
					meta: { ...existing.meta, ...meta, laidOutAt: movedByUser ? last : at, laidOutStyle: { ...laidOutStyle, ...appliedBefore } },
					props: { ...props, ...keptStyle },
				})
			}

			// The legend: one swatch and name per group, in a strip under the diagram.
			if (useGroups && !preview) {
				const bottom = Math.max(...nodes.map((n) => origin.y + n.y + n.h)) + 36
				let x = Math.min(...nodes.map((n) => origin.x + n.x))
				for (const g of groupNames) {
					const swatchId = `${prefix}legend-${slug(g)}-${hash(g)}` as TLShapeId
					const textId = `${prefix}legendt-${slug(g)}-${hash(g)}` as TLShapeId
					keep.add(swatchId)
					keep.add(textId)
					const swatch = { geo: 'rectangle' as const, w: 28, h: 20, color: groupInk.get(g)!, fill: 'solid' as const, size: 's' as const }
					if (editor.getShape(swatchId)) editor.updateShape<TLGeoShape>({ id: swatchId, type: 'geo', x, y: bottom, props: swatch })
					else editor.createShape<TLGeoShape>({ id: swatchId, type: 'geo', x, y: bottom, meta: { diagram: diagramId }, props: swatch })
					const size = measure(g, 18, 1000)
					const text = { richText: toRichText(g), size: 's' as const, color: 'black' as const, font: 'serif' as const, autoSize: true }
					const ty = bottom + 10 - size.h / 2
					if (editor.getShape(textId)) editor.updateShape<TLTextShape>({ id: textId, type: 'text', x: x + 38, y: ty, props: text })
					else editor.createShape<TLTextShape>({ id: textId, type: 'text', x: x + 38, y: ty, meta: { diagram: diagramId }, props: text })
					x += 38 + size.w + 36
				}
			}

			// Arrows, bound to the boxes at both ends, so they follow when a box moves.
			for (const edge of edges) {
				const id = edgeShapeId(diagramId, edge.from, edge.to)
				keep.add(id)
				const fromId = nodeShapeId(diagramId, edge.from)
				const toId = nodeShapeId(diagramId, edge.to)
				const existing = editor.getShape<TLArrowShape>(id)
				const bend = bendOf(edge)
				// A mind map's branches take the ink of the box they lead to, and are plain
				// lines: the tree already says which way it reads. A flow's yes and no
				// branches take green and red.
				const ink = branchInk(action.layout ?? 'flow', edge.label)
				const branchStyle = tree
					? {
							color: nodeStyle(tree, (tree.depth.get(edge.to) ?? 0) > (tree.depth.get(edge.from) ?? 0) ? edge.to : edge.from).color,
							arrowheadEnd: 'none' as const,
						}
					: ink
						? { color: ink }
						: {}
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
						props: { richText: toRichText(edge.label), ...branchStyle, ...(ownBend ? { bend } : {}) },
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
					props: { ...label, ...branchStyle, size: 's', font: 'serif', start: { x: 0, y: 0 }, end: { x: to.midX - from.midX, y: to.midY - from.midY } },
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
