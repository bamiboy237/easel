import { Box, Editor, IndexKey, TLDefaultColorStyle, TLGeoShape, TLLineShape, TLRichText, TLShapeId, TLTextShape, toRichText } from 'tldraw'

/**
 * Timeline layout. A printed timeline reads in three columns: the dates, a
 * spine with one dot per event, and what happened, so the spine never runs
 * through a word and the eye moves down the dates or across one event. Each
 * event's group (a country, a side, a period) gets one ink for its date and
 * dot, and a legend above the first event says which ink is which.
 */

export interface TimelineEvent {
	id: string
	label: string
	date?: string
	group?: string
	note?: string
}

/** Inks for the groups, in the order they first appear; neighbors differ in hue. */
const GROUP_COLORS: TLDefaultColorStyle[] = ['blue', 'red', 'green', 'violet', 'orange', 'light-blue']

/** Sides with an ink of their own by long convention, such as the Cold War's red and blue. */
const CONVENTIONAL: [RegExp, TLDefaultColorStyle][] = [
	[/\b(ussr|soviets?|soviet union|russia|communists?)\b/i, 'red'],
	[/\b(us|usa|u\.s\.|united states|americans?|nato|union)\b/i, 'blue'],
]

/**
 * One ink per group, in the order the groups first appear, except that a
 * side with a conventional ink keeps it when no other group has taken it.
 */
export function groupInks(groups: string[], palette: TLDefaultColorStyle[] = GROUP_COLORS) {
	const inks = new Map<string, TLDefaultColorStyle>()
	const used = new Set<TLDefaultColorStyle>()
	for (const g of groups) {
		const conv = CONVENTIONAL.find(([re]) => re.test(g))?.[1]
		if (conv && palette.includes(conv) && !used.has(conv)) {
			inks.set(g, conv)
			used.add(conv)
		}
	}
	for (const g of groups) {
		if (inks.has(g)) continue
		const ink = palette.find((c) => !used.has(c)) ?? palette[inks.size % palette.length]
		inks.set(g, ink)
		used.add(ink)
	}
	return inks
}

/** tldraw's text sizes in px, for the sizes a timeline uses. */
const FONT = { s: 18, m: 24 } as const
const DESC_MAX_W = 560
const ROW_GAP = 26
const DOT = 16
const SPINE_GAP = 26
const LEGEND_GAP = 30
const NOTE_GAP = 4

/** A date: a year, with a month and day before it when given, such as "Apr 1961" or "12 April 1961". */
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
/** A date or a span, such as "Apr 1961", "12 April 1961", "May–Jun 1940", or "Dec 1944–Jan 1945". */
const DATE = `(?:c\\.\\s*)?(?:${MONTH}\\s*[–-]\\s*)?(?:(?:\\d{1,2}\\s+)?${MONTH}\\s+(?:\\d{1,2},?\\s+)?)?\\d{3,4}(?:\\s*[–-]\\s*(?:${MONTH}\\s+)?\\d{2,4})?(?:\\s*(?:bce?|ce|ad))?`
/** A date at the start of a label, such as "1957: Sputnik 1" or "12 April 1961 · Gagarin". */
const LEADING_DATE = new RegExp(`^\\s*(${DATE})\\s*[:·—–|-]\\s*`, 'i')
/** A first line that is only a date, and maybe a side: "1957 · USSR". */
const DATE_LINE = new RegExp(`^\\s*(${DATE})\\s*(?:[:·—–|-]\\s*(.{1,30}?))?\\s*$`, 'i')

/** Whether a flow is really a timeline: a single chain of four or more dated steps with unlabeled arrows. */
export function isDatedChain(labels: string[], edges: { from: string; to: string; label: string }[], ids: string[]) {
	if (ids.length < 4 || (edges.length !== ids.length - 1 && edges.length !== 0)) return false
	if (edges.some((e) => e.label.trim())) return false
	const into = new Set<string>()
	const out = new Set<string>()
	for (const e of edges) {
		if (into.has(e.to) || out.has(e.from)) return false
		into.add(e.to)
		out.add(e.from)
	}
	const dated = labels.filter((l) => LEADING_DATE.test(l) || DATE_LINE.test(l.split('\n')[0]))
	return dated.length >= Math.ceil(labels.length * 0.8)
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** A sort key for a date: its year, then month and day when given. Null when there is no year. */
function dateKey(date: string) {
	const year = date.match(/\d{3,4}/)
	if (!year) return null
	let y = Number(year[0])
	if (/\bbce?\b/i.test(date)) y = -y
	// The first month named, by its place in the text: "Dec 1944–Jan 1945" starts in December.
	const at = MONTHS.map((m) => date.search(new RegExp(`\\b${m}`, 'i')))
	const first = Math.min(...at.filter((i) => i >= 0))
	const month = Number.isFinite(first) ? at.indexOf(first) : -1
	const day = date.replace(year[0], '').match(/\b(\d{1,2})\b/)
	return y * 10000 + (month >= 0 ? (month + 1) * 100 : 0) + (day ? Number(day[1]) : 0)
}

/** Each event's date and text: an explicit date, or one split off the front of its label. */
export function splitEvents(events: TimelineEvent[]) {
	const parsed = events.map((e) => {
		if (e.date && e.date.trim()) return { ...e, date: e.date.trim(), text: e.label.replace(LEADING_DATE, '').trim() || e.label }
		// "1957 · USSR" on a line of its own, then what happened.
		const lines = e.label.split('\n')
		const first = lines.length > 1 ? lines[0].match(DATE_LINE) : null
		if (first) return { ...e, date: first[1].trim(), group: e.group ?? first[2]?.trim(), text: lines.slice(1).join(' ').trim() }
		const m = e.label.match(LEADING_DATE)
		if (!m) return { ...e, date: '', text: e.label }
		// "1957 · USSR · Sputnik 1": a short side between the date and the event.
		const rest = e.label.slice(m[0].length)
		const side = rest.match(/^([^·|\n]{1,30}?)\s*[·|]\s+(.+)$/s)
		if (side && !e.group && side[1].trim().split(/\s+/).length <= 3) return { ...e, date: m[1].trim(), group: side[1].trim(), text: side[2].trim() }
		return { ...e, date: m[1].trim(), text: rest.trim() }
	})
	// Time runs one way: events are sorted by date when every date has a year,
	// so an event added later lands in its place, and ties keep their order.
	const keys = parsed.map((e) => dateKey(e.date))
	if (keys.every((k) => k !== null)) {
		return parsed
			.map((e, i) => ({ e, k: keys[i]!, i }))
			.sort((a, b) => a.k - b.k || a.i - b.i)
			.map((x) => x.e)
	}
	return parsed
}

type Measure = (text: string, fontSize: number, maxWidth: number) => { w: number; h: number }

/** Space between the last event and the note on spacing under it. */
const CAPTION_GAP = 22

/** Rich text in bold. */
function boldText(text: string): TLRichText {
	return { type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text, marks: [{ type: 'bold' }] }] : [] }] }
}

interface Part {
	id: TLShapeId
	kind: 'text' | 'dot' | 'spine'
	x: number
	y: number
	w: number
	h: number
	text?: string
	size?: 's' | 'm'
	color: TLDefaultColorStyle
	align?: 'start' | 'end'
	wrap?: boolean
	bold?: boolean
}

/**
 * Draws a timeline at origin (page space) with ids from idOf, updating the
 * parts already on the board and removing the ones no longer in it. A part
 * the user moved stays where they put it.
 */
export function drawTimeline(
	editor: Editor,
	diagramId: string,
	prefix: string,
	idOf: (key: string) => TLShapeId,
	origin: { x: number; y: number },
	events: TimelineEvent[],
	measure: Measure
) {
	const rows = splitEvents(events)
	const groups: string[] = []
	for (const r of rows) if (r.group && !groups.includes(r.group.trim())) groups.push(r.group.trim())
	const inks = groupInks(groups)
	const inkOf = (group?: string) => (group && groups.length ? (inks.get(group.trim()) ?? 'black') : 'black')

	const dateW = Math.max(0, ...rows.map((r) => (r.date ? measure(r.date, FONT.m, 1000).w : 0)))
	const spineX = dateW + SPINE_GAP
	const descX = spineX + SPINE_GAP
	const parts: Part[] = []

	// The legend: one dot and name per group, on one line above the events.
	let y = 0
	if (groups.length >= 2) {
		let x = descX
		for (const g of groups) {
			const size = measure(g, FONT.s, 1000)
			parts.push({ id: idOf(`legend-dot-${g}`), kind: 'dot', x, y: (size.h - 12) / 2, w: 12, h: 12, color: inkOf(g) })
			parts.push({ id: idOf(`legend-${g}`), kind: 'text', x: x + 20, y: 0, w: size.w, h: size.h, text: g, size: 's', color: inkOf(g) })
			x += 20 + size.w + 28
		}
		y = measure('A', FONT.s, 1000).h + LEGEND_GAP
	}

	const dots: { y: number }[] = []
	for (const r of rows) {
		const desc = measure(r.text, FONT.m, DESC_MAX_W)
		const line = measure('A', FONT.m, 1000).h
		const ink = inkOf(r.group)
		if (r.date) {
			const d = measure(r.date, FONT.m, 1000)
			parts.push({ id: idOf(`date-${r.id}`), kind: 'text', x: dateW - d.w, y, w: d.w, h: d.h, text: r.date, size: 'm', color: ink, align: 'end' })
		}
		// The key events, the ones given a note, stand out: a larger dot and a
		// heavier one-line label, so the turning points read before the rest.
		const key = !!r.note?.trim() && desc.h < line * 1.5
		const dot = key ? DOT + 6 : DOT
		const dotY = y + line / 2 - dot / 2
		parts.push({ id: idOf(`dot-${r.id}`), kind: 'dot', x: spineX - dot / 2, y: dotY, w: dot, h: dot, color: ink })
		dots.push({ y: dotY + dot / 2 })
		parts.push({ id: idOf(`text-${r.id}`), kind: 'text', x: descX, y, w: Math.min(DESC_MAX_W, desc.w * (key ? 1.12 : 1) + 4), h: desc.h, text: r.text, size: 'm', color: 'black', wrap: true, bold: key })
		let h = desc.h
		if (r.note && r.note.trim()) {
			const n = measure(r.note.trim(), FONT.s, DESC_MAX_W)
			parts.push({ id: idOf(`note-${r.id}`), kind: 'text', x: descX, y: y + desc.h + NOTE_GAP, w: Math.min(DESC_MAX_W, n.w + 4), h: n.h, text: r.note.trim(), size: 's', color: 'grey', wrap: true })
			h += NOTE_GAP + n.h
		}
		y += h + ROW_GAP
	}
	// Rows are evenly spaced whatever the gaps between dates, so the timeline says so.
	if (rows.length >= 4) {
		const caption = 'Events in order; spacing is not to scale.'
		const size = measure(caption, FONT.s, 1000)
		parts.push({ id: idOf('caption'), kind: 'text', x: descX, y: y - ROW_GAP + CAPTION_GAP, w: size.w, h: size.h, text: caption, size: 's', color: 'grey' })
	}
	if (dots.length >= 2) {
		const top = dots[0].y - 14
		const bottom = dots[dots.length - 1].y + 14
		parts.unshift({ id: idOf('spine'), kind: 'spine', x: spineX, y: top, w: 0, h: bottom - top, color: 'grey' })
	}

	// A new timeline slides down below anything it would land on.
	const isNew = !parts.some((p) => editor.getShape(p.id))
	if (isNew) {
		const w = Math.max(...parts.map((p) => p.x + p.w))
		const h = Math.max(...parts.map((p) => p.y + p.h))
		const obstacles = editor
			.getCurrentPageShapes()
			.filter((s) => s.type !== 'frame' && s.type !== 'group' && !s.id.startsWith(prefix))
			.map((s) => editor.getShapePageBounds(s))
			.filter((b): b is Box => !!b)
		for (let i = 0; i < 8; i++) {
			const area = new Box(origin.x, origin.y, w, h).expandBy(32)
			const hits = obstacles.filter((b) => b.collides(area) && !b.contains(area))
			if (hits.length === 0) break
			origin = { x: origin.x, y: Math.max(...hits.map((b) => b.maxY)) + 33 }
		}
	}

	const keep = new Set<TLShapeId>()
	for (const p of parts) {
		keep.add(p.id)
		const at = { x: origin.x + p.x, y: origin.y + p.y }
		const existing = editor.getShape(p.id)
		const last = existing?.meta.laidOutAt as { x: number; y: number } | undefined
		const moved = !!existing && !!last && (Math.abs(existing.x - last.x) > 1 || Math.abs(existing.y - last.y) > 1)
		const place = moved ? {} : at
		const meta = { diagram: diagramId, timeline: true, laidOutAt: moved ? last : at }
		if (p.kind === 'text') {
			const props = {
				richText: p.bold ? boldText(p.text ?? '') : toRichText(p.text ?? ''),
				size: p.size ?? 'm',
				color: p.color,
				font: 'serif' as const,
				textAlign: p.align ?? ('start' as const),
				autoSize: !p.wrap,
				...(p.wrap ? { w: p.w + 12 } : {}),
			}
			if (existing) editor.updateShape<TLTextShape>({ id: p.id, type: 'text', ...place, meta: { ...existing.meta, ...meta }, props })
			else editor.createShape<TLTextShape>({ id: p.id, type: 'text', ...at, meta, props })
		} else if (p.kind === 'dot') {
			const props = { geo: 'ellipse' as const, w: p.w, h: p.h, color: p.color, fill: 'fill' as const, size: 's' as const }
			if (existing) editor.updateShape<TLGeoShape>({ id: p.id, type: 'geo', ...place, meta: { ...existing.meta, ...meta }, props })
			else editor.createShape<TLGeoShape>({ id: p.id, type: 'geo', ...at, meta, props })
		} else {
			const props = {
				color: p.color,
				size: 's' as const,
				points: {
					a1: { id: 'a1', index: 'a1' as IndexKey, x: 0, y: 0 },
					a2: { id: 'a2', index: 'a2' as IndexKey, x: 0, y: p.h },
				},
			}
			if (existing) editor.updateShape<TLLineShape>({ id: p.id, type: 'line', ...place, meta: { ...existing.meta, ...meta }, props })
			else editor.createShape<TLLineShape>({ id: p.id, type: 'line', ...at, meta, props })
		}
	}

	const stale = editor
		.getCurrentPageShapes()
		.filter((s) => s.meta.diagram === diagramId && s.id.startsWith(prefix) && !keep.has(s.id))
		.map((s) => s.id)
	if (stale.length) editor.deleteShapes(stale)
}
