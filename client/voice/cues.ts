/**
 * Phrase-level pointing. The voice model calls `point` before it speaks, with
 * one cue per thing it will talk about, in order, and the first words it means
 * to say about each. Speech-to-speech models say those words a little
 * differently, so each cue is matched to a spoken sentence by the words they
 * share (with the target's own label), in order, and fires when that sentence
 * starts playing.
 */

export interface PointCue {
	target: string
	highlight: boolean
	words: string
	/** Words about the target itself, such as "the curve y = 2t on the graph". */
	label: string
}

const STOP_WORDS = new Set(
	'a an the and or but so of to in on at by for with is are was were be been it its this that these those there here you your we our i me my let lets look now see see just then than as from into over about when what which how why do does did not no yes if they them their his her he she one two also very can will would should could has have had at'.split(
		' '
	)
)

export function contentWords(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[‘’]/g, "'")
			.split(/[^a-z0-9]+/)
			.map((w) => w.replace(/s$/, ''))
			.filter((w) => w.length > 1 && !STOP_WORDS.has(w))
	)
}

function overlap(a: Set<string>, b: Set<string>): number {
	let n = 0
	for (const w of a) if (b.has(w)) n++
	return n
}

/**
 * Splits a growing transcript into sentences. Each sentence is reported once,
 * when its first characters arrive, with where in the response's audio it
 * starts, and again when it is complete.
 */
export class SentenceTracker {
	private text = ''
	private sentences: { start: number; startMs: number; text: string; done: boolean }[] = []

	/** Add a transcript delta, heard at `audioMs` into the response's audio. Returns the sentences started or finished. */
	push(delta: string, audioMs: number): { started: number[]; finished: number[] } {
		const started: number[] = []
		const finished: number[] = []
		const before = this.text.length
		this.text += delta
		if (this.sentences.length === 0 && this.text.trim()) {
			this.sentences.push({ start: this.text.search(/\S/), startMs: audioMs, text: '', done: false })
			started.push(0)
		}
		// A sentence ends at ., ! or ? followed by a space or a line break.
		const end = /[.!?]+(?=\s)|\n+/g
		end.lastIndex = Math.max(0, before - 3)
		let match: RegExpExecArray | null
		while ((match = end.exec(this.text))) {
			const last = this.sentences[this.sentences.length - 1]
			const stop = match.index + match[0].length
			if (stop <= last.start) continue
			const next = this.text.slice(stop).search(/\S/)
			if (next < 0) break
			last.text = this.text.slice(last.start, stop).trim()
			if (!last.done) {
				last.done = true
				finished.push(this.sentences.length - 1)
			}
			this.sentences.push({ start: stop + next, startMs: audioMs, text: '', done: false })
			started.push(this.sentences.length - 1)
		}
		const last = this.sentences[this.sentences.length - 1]
		if (last && !last.done) last.text = this.text.slice(last.start).trim()
		return { started, finished }
	}

	/** Finish the last sentence when the transcript ends. */
	end(): number[] {
		const last = this.sentences[this.sentences.length - 1]
		if (!last || last.done) return []
		last.done = true
		return [this.sentences.length - 1]
	}

	get(index: number) {
		return this.sentences[index]
	}

	get count() {
		return this.sentences.length
	}

	/** Characters before a sentence, for estimating when it plays when audio timing is unknown. */
	charsBefore(index: number): number {
		return this.sentences[index]?.start ?? this.text.length
	}
}

/**
 * Which cue a sentence carries. Cues go in order: the sentence takes the next
 * cue, or the one after it, whichever shares more words with it. The first
 * sentence takes the first cue even with no shared words, since the model is
 * told to point at what it says first. Returns the cue's index, or -1.
 */
export function matchCue(sentence: string, sentenceIndex: number, cues: PointCue[], nextCue: number): number {
	if (nextCue >= cues.length) return -1
	const words = contentWords(sentence)
	let best = -1
	let bestScore = 0
	for (let i = nextCue; i < Math.min(cues.length, nextCue + 2); i++) {
		const cue = cues[i]
		const said = overlap(words, contentWords(cue.words)) * 2
		const about = overlap(words, contentWords(cue.label + ' ' + cue.target.replace(/[._]/g, ' ')))
		// Skipping a cue needs a clearer match than taking the next one.
		const score = said + about - (i > nextCue ? 1 : 0)
		if (score > bestScore) {
			best = i
			bestScore = score
		}
	}
	if (best >= 0) return best
	return sentenceIndex === 0 ? nextCue : -1
}
