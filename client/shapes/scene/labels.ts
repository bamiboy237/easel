/**
 * Label placement for scenes. The agent says what a label says and what it
 * belongs to, never exactly where its text goes, so the board places every
 * label after it knows where everything else is drawn: each label tries a few
 * spots around its anchor and takes the one that covers the least, in this
 * order of concern: other labels, handles and arrowheads, the title and the
 * readouts, then lines and curves.
 *
 * Positions are in scene units with y up; sizes come in pixels and are scaled
 * by unitsPerPixel.
 */

export type Vec = [number, number]

export interface Box {
	x0: number
	y0: number
	x1: number
	y1: number
}

export type LabelKind = 'label' | 'handle' | 'vector' | 'point' | 'segment'

export interface LabelRequest {
	id: string
	kind: LabelKind
	text: string
	/** Font size in pixels. */
	size: number
	/** The point the label belongs to: a point, a vector's tip, a segment's middle, or a label's own position. */
	anchor: Vec
	/** For a vector or a segment: the other end, so the label can sit beyond the tip or beside the line. */
	from?: Vec
	/** For a point: the radius of its dot or handle, in pixels. */
	radius?: number
}

export interface Obstacles {
	/** Round things a label must not cover: handles, dots, arrowheads. Radius in pixels. */
	discs: { center: Vec; radius: number }[]
	/** Areas a label must not cover, such as the title and the readouts. */
	boxes: Box[]
	/** Sample points along lines and curves, which a label should not sit on. */
	strokes: Vec[]
	/** Filled shapes, such as a cart or a ball, which a label should rather not cover. */
	fills: Box[]
}

export interface PlacedLabel {
	id: string
	center: Vec
	box: Box
}

/** A rough width for text in pixels: wide enough that labels do not touch. */
export function textWidthPx(text: string, size: number): number {
	return Math.max(1, [...text].length) * size * 0.52 + 6
}

// Labels tied to geometry go first, since they have few good spots. A free
// label goes last: it can move further from where the agent put it.
const ORDER: Record<LabelKind, number> = { handle: 0, vector: 1, point: 2, segment: 3, label: 4 }

/** Place every label. The result keeps the order of the requests. */
export function placeLabels(
	requests: LabelRequest[],
	obstacles: Obstacles,
	view: { x: Vec; y: Vec },
	unitsPerPixel: number
): PlacedLabel[] {
	const u = unitsPerPixel
	const inset = 6 * u
	const placed: PlacedLabel[] = []
	const byId = new Map<string, PlacedLabel>()
	const sorted = [...requests].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
	for (const request of sorted) {
		const w = textWidthPx(request.text, request.size) * u
		const h = request.size * 1.25 * u
		let best: { center: Vec; cost: number } | null = null
		candidates(request, w, h, u).forEach((raw, rank) => {
			// Keep the whole box inside the plot.
			const center: Vec = [
				clamp(raw[0], view.x[0] + inset + w / 2, view.x[1] - inset - w / 2),
				clamp(raw[1], view.y[0] + inset + h / 2, view.y[1] - inset - h / 2),
			]
			const box = boxAt(center, w, h)
			let cost = rank * 0.5
			// A spot the clamp moved far from its candidate is worth less.
			cost += Math.hypot(center[0] - raw[0], center[1] - raw[1]) / u / 10
			for (const other of placed) cost += 400 * overlapArea(box, other.box) / (w * h)
			for (const disc of obstacles.discs) {
				if (boxHitsDisc(box, disc.center, (disc.radius + 2) * u)) cost += 200
			}
			for (const area of obstacles.boxes) cost += 300 * overlapArea(box, area) / (w * h)
			for (const area of obstacles.fills) cost += 40 * overlapArea(box, area) / (w * h)
			let crossings = 0
			for (const p of obstacles.strokes) if (inside(box, p)) crossings++
			cost += 12 * crossings
			if (!best || cost < best.cost) best = { center, cost }
		})
		const center = best!.center
		const label = { id: request.id, center, box: boxAt(center, w, h) }
		placed.push(label)
		byId.set(request.id, label)
	}
	return requests.map((r) => byId.get(r.id)!)
}

/** Candidate centers, best first, for a label of width w and height h (scene units). */
function candidates(request: LabelRequest, w: number, h: number, u: number): Vec[] {
	const [ax, ay] = request.anchor
	const out: Vec[] = []
	switch (request.kind) {
		case 'label': {
			// Where the agent put it, then nudged a line at a time.
			out.push([ax, ay])
			for (const k of [0.75, 1.5, 2.5]) {
				const dx = (w / 2 + 6 * u) * k
				const dy = h * k
				out.push([ax, ay + dy], [ax, ay - dy], [ax + dx, ay], [ax - dx, ay])
				out.push([ax + dx, ay + dy], [ax - dx, ay + dy], [ax + dx, ay - dy], [ax - dx, ay - dy])
			}
			break
		}
		case 'handle':
		case 'point': {
			const gap = ((request.radius ?? 5) + 5) * u
			for (const ring of [1, 2.2]) {
				const g = gap * ring
				// Upper right first, as a reader expects, then around the point.
				out.push(
					[ax + g * 0.7 + w / 2, ay + g * 0.7 + h / 2],
					[ax + g + w / 2, ay],
					[ax + g * 0.7 + w / 2, ay - g * 0.7 - h / 2],
					[ax, ay + g + h / 2],
					[ax - g * 0.7 - w / 2, ay + g * 0.7 + h / 2],
					[ax - g - w / 2, ay],
					[ax, ay - g - h / 2],
					[ax - g * 0.7 - w / 2, ay - g * 0.7 - h / 2]
				)
			}
			break
		}
		case 'vector': {
			const from = request.from ?? [ax - 1, ay]
			const [dx, dy] = unit([ax - from[0], ay - from[1]])
			const [nx, ny] = [-dy, dx]
			const alongU = Math.abs(dx) * (w / 2) + Math.abs(dy) * (h / 2)
			const alongN = Math.abs(nx) * (w / 2) + Math.abs(ny) * (h / 2)
			const length = Math.hypot(ax - from[0], ay - from[1])
			const past = 12 * u + alongU
			const side = 10 * u + alongN
			// Beside the tip, but never back past the middle of a short vector.
			const back = Math.min(14 * u, length * 0.3)
			const mid: Vec = [(ax + from[0]) / 2, (ay + from[1]) / 2]
			out.push(
				// Past the arrowhead, along the vector.
				[ax + dx * past, ay + dy * past],
				// Beside the tip, on either side.
				[ax - dx * back + nx * side, ay - dy * back + ny * side],
				[ax - dx * back - nx * side, ay - dy * back - ny * side],
				// Beside the middle of the shaft.
				[mid[0] + nx * side, mid[1] + ny * side],
				[mid[0] - nx * side, mid[1] - ny * side],
				// Past the tip, shifted to either side.
				[ax + dx * past + nx * (h * 0.9), ay + dy * past + ny * (h * 0.9)],
				[ax + dx * past - nx * (h * 0.9), ay + dy * past - ny * (h * 0.9)],
				// Farther past the tip.
				[ax + dx * (past + h * 1.5), ay + dy * (past + h * 1.5)]
			)
			break
		}
		case 'segment': {
			const from = request.from ?? [ax - 1, ay]
			const [dx, dy] = unit([ax - from[0], ay - from[1]])
			const [nx, ny] = [-dy, dx]
			const alongN = Math.abs(nx) * (w / 2) + Math.abs(ny) * (h / 2)
			const side = 6 * u + alongN
			for (const t of [0.5, 0.3, 0.7]) {
				const p: Vec = [from[0] + (ax - from[0]) * t, from[1] + (ay - from[1]) * t]
				out.push([p[0] + nx * side, p[1] + ny * side], [p[0] - nx * side, p[1] - ny * side])
			}
			break
		}
	}
	return out
}

function unit([x, y]: Vec): Vec {
	const length = Math.hypot(x, y)
	return length > 0 ? [x / length, y / length] : [1, 0]
}

function clamp(v: number, lo: number, hi: number) {
	return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v))
}

function boxAt([x, y]: Vec, w: number, h: number): Box {
	return { x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2 }
}

function overlapArea(a: Box, b: Box): number {
	const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
	const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
	return w > 0 && h > 0 ? w * h : 0
}

// These run in the innermost loop on every frame a scene plays, so they read
// coordinates by index rather than destructuring.
function inside(b: Box, p: Vec) {
	return p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1
}

function boxHitsDisc(b: Box, c: Vec, r: number) {
	const dx = clamp(c[0], b.x0, b.x1) - c[0]
	const dy = clamp(c[1], b.y0, b.y1) - c[1]
	return dx * dx + dy * dy < r * r
}

/** Points every few pixels along a polyline, for the stroke obstacles. */
export function sampleStroke(points: Vec[], unitsPerPixel: number, spacingPx = 6): Vec[] {
	const out: Vec[] = []
	const step = spacingPx * unitsPerPixel
	for (let i = 1; i < points.length; i++) {
		const [a, b] = [points[i - 1], points[i]]
		if (![...a, ...b].every(Number.isFinite)) continue
		const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
		for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
	}
	if (points.length) out.push(points[points.length - 1])
	return out
}
