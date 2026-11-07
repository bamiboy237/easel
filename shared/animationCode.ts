/** Ends a writer's stream when the model failed after the reply started. */
export const ANIMATION_STREAM_ERROR = '\n\u0000ANIMATION_ERROR\u0000'

/** The Python file in a writer's reply: its first fenced python block, or the whole reply if it is plain code. */
export function parseAnimationSource(text: string): string {
	const match = /```(?:python|py)?[^\S\n]*\n([\s\S]*?)\n?```/i.exec(text)
	const source = (match ? match[1] : text).trim()
	if (!/class\s+\w+\s*\([^)]*Scene[^)]*\)\s*:/.test(source)) throw new Error('The reply had no Manim scene class.')
	return source + '\n'
}

export interface AnimationEdit {
	search: string
	replace: string
}

export type AnimationReview = { ok: true } | { ok: false; problems: string[]; edits: AnimationEdit[]; source: string | null }

const EDIT_BLOCK = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g

/** A choice between two versions: which one, and the review of it that follows on the next lines. */
export function parseAnimationChoice(text: string): { choice: 'A' | 'B'; review: AnimationReview } {
	const trimmed = text.trim()
	const first = /^\W*([AB])\b/i.exec(trimmed)
	const choice = (first?.[1]?.toUpperCase() ?? 'A') as 'A' | 'B'
	const rest = first ? trimmed.slice(first[0].length) : trimmed
	return { choice, review: parseAnimationReview(rest) }
}

/** A writer's check of its render: OK, or FIX with the problems and edits (or a whole corrected file). */
export function parseAnimationReview(text: string): AnimationReview {
	const trimmed = text.trim()
	const hasCode = trimmed.includes('```') || trimmed.includes('<<<<<<< SEARCH')
	if (/^OK\b/i.test(trimmed) && !hasCode) return { ok: true }
	const edits = [...trimmed.matchAll(EDIT_BLOCK)].map((m) => ({ search: m[1], replace: m[2] }))
	const beforeCode = trimmed.split(/```|<<<<<<< SEARCH/)[0]
	const problems = beforeCode
		.split('\n')
		.map((line) => line.replace(/^\s*(FIX\b:?|[-*\d.)]+)\s*/i, '').trim())
		.filter(Boolean)
		.slice(0, 5)
	let source: string | null = null
	if (!edits.length) {
		try {
			source = parseAnimationSource(trimmed)
		} catch {}
	}
	if (!source && !edits.length && problems.length === 0) return { ok: true }
	return { ok: false, problems, edits, source }
}

/** Apply a review's edits in order. Null if one does not match the source exactly once. */
export function applyAnimationEdits(source: string, edits: AnimationEdit[]): string | null {
	let out = source
	for (const edit of edits) {
		if (!edit.search.trim()) return null
		let at = out.indexOf(edit.search)
		let search = edit.search
		if (at < 0) {
			// Models often change trailing spaces; match line by line, ignoring them.
			const strip = (s: string) => s.split('\n').map((l) => l.trimEnd()).join('\n')
			const stripped = strip(out)
			search = strip(edit.search)
			at = stripped.indexOf(search)
			if (at < 0) return null
			out = stripped
		}
		if (out.indexOf(search, at + 1) >= 0) return null
		out = out.slice(0, at) + edit.replace + out.slice(at + search.length)
	}
	return out
}

/**
 * The part of a scene written so far that can already run: the file up to the
 * last complete statement of construct. It renders as a sketch while the rest
 * is still being written. Null until construct has a step to show.
 */
export function partialAnimationSource(text: string): string | null {
	const start = /```(?:python|py)?[^\S\n]*\n/i.exec(text)
	if (!start) return null
	let code = text.slice(start.index + start[0].length)
	const end = code.indexOf('```')
	if (end >= 0) code = code.slice(0, end)
	const lines = code.split('\n')
	const construct = lines.findIndex((l) => /^\s+def construct\(self\)\s*:/.test(l))
	if (construct < 0) return null
	const body = lines.slice(construct + 1).find((l) => l.trim())
	const indent = body ? /^(\s*)/.exec(body)![1] : ''
	if (!indent) return null
	// The last line of the body that starts a statement outside any bracket:
	// everything before it is complete.
	let depth = 0
	let cut = -1
	for (let i = construct + 1; i < lines.length; i++) {
		const line = lines[i]
		const startsStatement = depth === 0 && line.startsWith(indent) && line.length > indent.length && !/\s/.test(line[indent.length])
		if (startsStatement) cut = i
		// A line back at the class's indentation ends construct.
		if (depth === 0 && line.trim() && !line.startsWith(indent)) {
			cut = i
			break
		}
		depth = Math.max(0, depth + bracketBalance(line))
	}
	if (cut <= construct + 1) return null
	const kept = lines.slice(0, cut).join('\n').trimEnd()
	if (!/self\.(play|title|caption|wait|add)\(/.test(kept.slice(kept.indexOf('def construct')))) return null
	return `${kept}\n${indent}self.wait(0.1)\n`
}

/** How many brackets a line opens minus how many it closes, outside strings and comments. */
function bracketBalance(line: string): number {
	let balance = 0
	let quote: string | null = null
	for (let i = 0; i < line.length; i++) {
		const c = line[i]
		if (quote) {
			if (c === '\\') i++
			else if (c === quote) quote = null
		} else if (c === '"' || c === "'") quote = c
		else if (c === '#') break
		else if ('([{'.includes(c)) balance++
		else if (')]}'.includes(c)) balance--
	}
	return balance
}
