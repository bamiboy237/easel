import { Editor, TLShape } from 'tldraw'
import { displayName, ShapeParameter } from '../shapes/math/parameters'

/** A slider the user can drag: on a graph, a simulation, a scene, or a widget. */
export interface LiveParameter {
	shapeId: string
	name: string
	parameter: ShapeParameter & { unit?: string }
}

/** Every live parameter on the current page. */
export function getLiveParameters(editor: Editor): LiveParameter[] {
	const out: LiveParameter[] = []
	for (const shape of editor.getCurrentPageShapes()) {
		const props = shape.props as { parameters?: unknown; params?: unknown }
		const list: ShapeParameter[] = Array.isArray(props.parameters)
			? (props.parameters as ShapeParameter[])
			: props.params && typeof props.params === 'object' && (shape.type === 'scene' || shape.type === 'widget')
				? Object.entries(props.params as Record<string, ShapeParameter>).map(([name, p]) => ({ ...p, name }))
				: []
		for (const parameter of list) {
			if (typeof parameter?.value !== 'number') continue
			out.push({ shapeId: shape.id.replace(/^shape:/, ''), name: parameter.name, parameter })
		}
	}
	return out
}

/** The words a shape shows, for reading facts from it. */
export function getShapeWords(editor: Editor, shape: TLShape): string {
	if (shape.type === 'thread') {
		const entries = (shape.props as { entries?: { author: string; text: string }[] }).entries ?? []
		return entries.filter((e) => e.author === 'agent').map((e) => e.text).join('\n')
	}
	if (shape.type === 'frame') return (shape.props as { name?: string }).name ?? ''
	try {
		return editor.getShapeUtil(shape).getText(shape) ?? ''
	} catch {
		return ''
	}
}

const QUANTITY = /(?:^|[^\w.])(-?\d+(?:[.,]\d+)?)\s?(N|kg|g|m\/s²|m\/s\^2|m\/s|km\/h|mph|m|cm|km|s|ms|min|°|deg|degrees|J|W|Hz|V|A|%|pts|points|lives)(?![\w])/g

/**
 * Numbers with units written on the board, each with a few words around it,
 * such as "pushed with 10 N against 4 N of friction".
 */
function writtenQuantities(text: string): string[] {
	const found: string[] = []
	for (const match of text.matchAll(QUANTITY)) {
		const at = match.index ?? 0
		const start = Math.max(0, text.lastIndexOf(' ', Math.max(0, at - 24)))
		const end = Math.min(text.length, at + match[0].length + 24)
		found.push(text.slice(start, end).replace(/\s+/g, ' ').trim())
	}
	return found
}

/**
 * What is already settled on the board, for the agent to reuse: the live
 * parameters with their ranges and units, quantities written in text, and
 * the names of things (frame titles, headings, and titled shapes).
 */
export function getBoardFacts(editor: Editor): { parameters: string[]; quantities: string[]; names: string[] } {
	const parameters = getLiveParameters(editor).map(({ shapeId, name, parameter: p }) => {
		const unit = p.unit ? ` ${p.unit}` : ''
		const label = displayName(name) !== name ? ` (${displayName(name)})` : ''
		return `${shapeId}.${name}${label}: ${round(p.value)}${unit} now, slider ${round(p.min)} to ${round(p.max)}${unit}`
	})
	const quantities = new Set<string>()
	const names = new Set<string>()
	for (const shape of editor.getCurrentPageShapes()) {
		const words = getShapeWords(editor, shape)
		for (const q of writtenQuantities(words)) quantities.add(q)
		const title = (shape.props as { title?: unknown }).title
		if (typeof title === 'string' && title.trim()) names.add(title.trim())
		if (shape.type === 'frame' && words.trim()) names.add(words.trim())
		const size = (shape.props as { size?: unknown }).size
		if (shape.type === 'text' && (size === 'l' || size === 'xl') && words.trim() && words.length <= 80) names.add(words.trim())
	}
	return { parameters, quantities: [...quantities].slice(0, 16), names: [...names].slice(0, 16) }
}

function round(value: number) {
	return Number(value.toPrecision(4))
}

/** A parameter's spellings in prose: its name and, for "theta" or "th", θ. */
function spellings(name: string): string[] {
	const out = new Set([name, displayName(name)])
	if (/^th(\d?)$/.test(name)) out.add('θ' + name.slice(2))
	return [...out]
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Where a text quotes a live parameter's value, as in "Here a = 2 m/s²": the
 * value goes stale as soon as the user drags the slider. Returns the quoted
 * phrases with the parameter they quote.
 */
export function findQuotedLiveValues(text: string, live: LiveParameter[]): { phrase: string; parameter: LiveParameter }[] {
	const hits: { phrase: string; parameter: LiveParameter }[] = []
	for (const parameter of live) {
		for (const spelling of spellings(parameter.name)) {
			const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_])(${escape(spelling)}\\s*(?:=|≈)\\s*−?-?\\d[\\d.,]*\\s*\\S{0,6})`, 'u')
			const match = pattern.exec(text)
			if (match) {
				hits.push({ phrase: match[1].trim(), parameter })
				break
			}
		}
	}
	return hits
}
