import { atom, Editor, VecModel } from 'tldraw'
import { VoiceMode, voiceTurnDetection } from '../../shared/voice/realtime'
import type { TldrawAgent } from '../agent/TldrawAgent'
import { matchCue, PointCue, SentenceTracker } from './cues'
import { BoardTarget, describeBoardForVoice, resolveTarget } from './parts'
import { askPrediction, describeNewWork, placeNote, setParameter, VoiceTurn } from './tools'
import { RealtimeTransport, TransportHandlers, WebRtcTransport, WebSocketTransport } from './transport'

export type VoiceStatus = 'off' | 'connecting' | 'ready' | 'listening' | 'thinking' | 'speaking' | 'working' | 'error'

/** The AI's cursor: where it flies from and to, and when. */
export interface VoiceCursor {
	from: VecModel
	to: VecModel
	control: VecModel
	startedAt: number
	duration: number
}

/** A part the AI is pointing at or highlighting. */
export interface VoiceMark {
	key: string
	target: BoardTarget
	highlight: boolean
	startedAt: number
	/** When it began fading, or null while it shows. */
	fadingAt: number | null
}

/** One line of the conversation, as it is stored with the board. */
export interface VoiceLine {
	speaker: 'user' | 'ai'
	text: string
	ts: number
	/** For the AI: the voice turn whose board changes can be reverted together. */
	passId?: string
}

/** Timing the gate measures. All times are `performance.now()`. */
export interface VoiceMetrics {
	turns: { releasedAt: number | null; speechEndAt: number | null; firstAudioAt: number | null; responseId: string }[]
	interruptions: { reason: string; heardAt: number; stoppedAt: number; wasPlaying: boolean; cancelled: string[] }[]
	cues: { target: string; part: string | null; highlight: boolean; sentence: string; firedAt: number; sentenceStartAt: number }[]
	toolCalls: { name: string; args: unknown; output: string; responseId: string; cancelled?: boolean; placed?: string[] }[]
	/** `startedAt` is when the microphone opened. */
	sessions: { startedAt: number; endedAt: number | null; transport: string }[]
}

/** A user speaking over the AI: this loud, for this long, stops the voice at once. */
const BARGE_IN_LEVEL = 0.02
const BARGE_IN_MS = 100
/** Without audio timing, speech runs at about this many milliseconds per character. */
const MS_PER_CHAR = 68
/** The cursor's flight. */
const FLY_MS = 650
/** Push to talk: audio still in flight when the key comes up. */
const RELEASE_TAIL_MS = 180

const managers = new WeakMap<Editor, VoiceManager>()

export function getVoiceManager(editor: Editor): VoiceManager | undefined {
	return managers.get(editor)
}

interface PendingTool {
	name: string
	callId: string
	args: any
	responseId: string
}

/**
 * The voice conversation: one OpenAI Realtime session, push to talk or hands
 * free, with the canvas tools. Board changes are commands with origin `voice`,
 * the board revision the voice model read, and the usual stale and protection
 * checks. Heavy work goes to the agent through `delegate`. When the user
 * starts talking, the voice stops at once and pending actions are canceled;
 * finished work stays, and revert is a separate action.
 */
export class VoiceManager {
	readonly $status = atom<VoiceStatus>('voice status', 'off')
	readonly $mode = atom<VoiceMode>('voice mode', 'push')
	readonly $level = atom('voice level', 0)
	readonly $cursor = atom<VoiceCursor | null>('voice cursor', null)
	readonly $marks = atom<VoiceMark[]>('voice marks', [])
	readonly $lines = atom<VoiceLine[]>('voice lines', [])
	readonly $error = atom<string | null>('voice error', null)
	readonly metrics: VoiceMetrics = { turns: [], interruptions: [], cues: [], toolCalls: [], sessions: [] }

	private transport: RealtimeTransport | null = null
	private requestId = ''
	private baseRev = 0
	private boardSentRev = -1
	private pushing = false
	private releaseTimer: ReturnType<typeof setTimeout> | null = null
	/** The response being generated, if any. */
	private activeResponse: string | null = null
	private cancelledResponses = new Set<string>()
	/** Tool calls of each response, run when the response is done. */
	private toolCalls = new Map<string, PendingTool[]>()
	/** Cues from the last point call, waiting for the speech they belong to. */
	private pendingCues: PointCue[] = []
	/** Per spoken item: its sentences and its cues. */
	private speech = new Map<string, { responseId: string; tracker: SentenceTracker; cues: PointCue[]; nextCue: number; chars: number }>()
	private timers = new Set<ReturnType<typeof setTimeout>>()
	private cueTimers = new Set<ReturnType<typeof setTimeout>>()
	private delegateRun: { callId: string; responseId: string; cancel: () => void } | null = null
	private queuedResponse = false
	private loudSince: number | null = null
	private heardSpeechAt: number | null = null
	private userText = ''
	private lastSpeechStoppedAt: number | null = null
	private releasedAt: number | null = null

	constructor(
		private agent: TldrawAgent,
		private options: { boardId?: string; persist?: boolean } = {}
	) {
		managers.set(agent.editor, this)
	}

	get editor() {
		return this.agent.editor
	}

	// ==================== Session ====================

	/** Start a conversation. Push to talk holds the mic closed until the user presses. */
	async start(mode: VoiceMode = this.$mode.get()) {
		if (this.transport) return
		this.$mode.set(mode)
		this.$status.set('connecting')
		this.$error.set(null)
		this.requestId = `voice-${crypto.randomUUID()}`
		this.boardSentRev = -1
		const handlers: TransportHandlers = {
			onEvent: (event) => this.handleEvent(event),
			onPlaybackStart: (itemId, at) => this.handlePlaybackStart(itemId, at),
			onPlaybackEnd: () => this.handlePlaybackEnd(),
			onMicLevel: (level) => this.handleMicLevel(level),
			onClose: () => {
				if (this.transport) this.stop()
			},
		}
		const preferred = readTransportPreference()
		const kinds: ('webrtc' | 'websocket')[] = preferred === 'websocket' ? ['websocket'] : ['webrtc', 'websocket']
		for (const kind of kinds) {
			let transport: RealtimeTransport | null = null
			try {
				const key = await this.mintKey(mode)
				transport = kind === 'webrtc' ? new WebRtcTransport(handlers) : new WebSocketTransport(handlers)
				this.transport = transport
				await transport.connect(key)
				this.metrics.sessions.push({ startedAt: performance.now(), endedAt: null, transport: kind })
				break
			} catch (error) {
				console.warn(`Voice over ${kind} is unavailable:`, error)
				// On a network without WebRTC, later conversations in this tab go straight to the WebSocket.
				if (kind === 'webrtc') rememberWebRtcFailed()
				this.transport = null
				transport?.close()
			}
		}
		if (!this.transport) {
			this.$status.set('error')
			this.$error.set('Voice could not connect.')
			return
		}
		this.transport.setMicOpen(mode === 'handsfree')
		this.syncBoard()
		this.$status.set(mode === 'handsfree' ? 'listening' : 'ready')
	}

	/** End the conversation. Work already on the board stays. */
	stop() {
		const transport = this.transport
		this.transport = null
		this.cancelPending('stopped')
		transport?.close()
		const session = this.metrics.sessions[this.metrics.sessions.length - 1]
		if (session && session.endedAt === null) session.endedAt = performance.now()
		this.activeResponse = null
		this.pushing = false
		this.$level.set(0)
		this.$status.set('off')
		this.fadeMarks()
		setTimeout(() => this.$cursor.set(null), 1500)
	}

	isOn() {
		return !!this.transport
	}

	getTransportKind() {
		return this.transport?.kind ?? null
	}

	/** Switch between push to talk and hands-free during a conversation. */
	setMode(mode: VoiceMode) {
		this.$mode.set(mode)
		if (!this.transport) return
		this.transport.send({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: voiceTurnDetection(mode) } } } })
		this.transport.setMicOpen(mode === 'handsfree')
		if (this.$status.get() === 'ready' || this.$status.get() === 'listening') this.$status.set(mode === 'handsfree' ? 'listening' : 'ready')
	}

	private async mintKey(mode: VoiceMode): Promise<string> {
		const response = await fetch('/voice/conversation', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mode }),
		})
		if (!response.ok) throw new Error(`voice conversation ${response.status}`)
		return ((await response.json()) as { key: string }).key
	}

	// ==================== Push to talk ====================

	/** The user presses to talk. Anything the AI was saying or about to do stops. */
	pressStart() {
		if (!this.transport || this.pushing) return
		if (this.releaseTimer) {
			clearTimeout(this.releaseTimer)
			this.releaseTimer = null
		}
		this.pushing = true
		this.heardSpeechAt = performance.now()
		this.interrupt('push')
		this.syncBoard()
		this.transport.send({ type: 'input_audio_buffer.clear' })
		this.transport.setMicOpen(true)
		this.$status.set('listening')
	}

	/** The user lets go: their turn is sent, and the AI answers. */
	pressEnd() {
		if (!this.transport || !this.pushing) return
		this.pushing = false
		this.releasedAt = performance.now()
		this.releaseTimer = setTimeout(() => {
			this.releaseTimer = null
			const transport = this.transport
			if (!transport) return
			if (this.$mode.get() === 'push') transport.setMicOpen(false)
			transport.send({ type: 'input_audio_buffer.commit' })
			this.createResponse()
			this.$status.set('thinking')
		}, RELEASE_TAIL_MS)
	}

	// ==================== Board context ====================

	/** Tell the voice model what is on the board, when it changed since it last heard. */
	private syncBoard(force = false) {
		const rev = this.agent.commands.getRev()
		if (!this.transport || (!force && rev === this.boardSentRev)) return
		this.boardSentRev = rev
		this.baseRev = rev
		this.transport.send({
			type: 'conversation.item.create',
			item: {
				type: 'message',
				role: 'system',
				content: [{ type: 'input_text', text: `The board now (revision ${rev}):\n${describeBoardForVoice(this.editor)}` }],
			},
		})
	}

	private createResponse() {
		if (!this.transport) return
		if (this.activeResponse) {
			this.queuedResponse = true
			return
		}
		this.transport.send({ type: 'response.create' })
	}

	// ==================== Events ====================

	private handleEvent(event: any) {
		switch (event.type) {
			case 'input_audio_buffer.speech_started':
				// The server heard the user start a turn: stop and listen.
				this.heardSpeechAt ??= performance.now()
				this.interrupt('vad')
				this.syncBoard()
				this.$status.set('listening')
				break
			case 'input_audio_buffer.speech_stopped':
				this.lastSpeechStoppedAt = performance.now()
				this.heardSpeechAt = null
				this.$status.set('thinking')
				break
			case 'conversation.item.input_audio_transcription.completed': {
				const text = String(event.transcript ?? '').trim()
				if (text) {
					this.userText = text
					this.addLine({ speaker: 'user', text, ts: Date.now() })
				}
				break
			}
			case 'response.created':
				this.activeResponse = event.response.id
				this.metrics.turns.push({
					responseId: event.response.id,
					releasedAt: this.releasedAt,
					speechEndAt: this.lastSpeechStoppedAt ?? this.releasedAt,
					firstAudioAt: null,
				})
				this.releasedAt = null
				this.lastSpeechStoppedAt = null
				if (this.$status.get() !== 'listening') this.$status.set('thinking')
				break
			case 'response.output_audio_transcript.delta':
				this.handleTranscript(event)
				break
			case 'response.output_audio_transcript.done':
				this.finishTranscript(event)
				break
			case 'response.function_call_arguments.done': {
				if (this.cancelledResponses.has(event.response_id)) break
				let args: unknown = {}
				try {
					args = JSON.parse(event.arguments || '{}')
				} catch {
					args = {}
				}
				const list = this.toolCalls.get(event.response_id) ?? []
				list.push({ name: event.name, callId: event.call_id, args, responseId: event.response_id })
				this.toolCalls.set(event.response_id, list)
				// Pointing is planned before the speech it goes with, so it is ready at once.
				if (event.name === 'point') this.planCues(args as { cues?: unknown })
				break
			}
			case 'response.done':
				this.handleResponseDone(event.response)
				break
			case 'error':
				// Cancelling a response that already ended is harmless.
				if (event.error?.code !== 'response_cancel_not_active') console.warn('Voice error:', event.error)
				break
		}
	}

	private handleResponseDone(response: any) {
		const id = response.id as string
		if (this.activeResponse === id) this.activeResponse = null
		const calls = this.toolCalls.get(id) ?? []
		this.toolCalls.delete(id)
		const cancelled = this.cancelledResponses.has(id) || response.status === 'cancelled'
		if (!cancelled && calls.length > 0) {
			let waits = false
			for (const call of calls) {
				if (call.name === 'delegate') {
					waits = true
					void this.runDelegate(call)
				} else this.sendToolOutput(call, this.runTool(call))
			}
			if (!waits) this.createResponse()
		} else if (cancelled) {
			for (const call of calls) this.metrics.toolCalls.push({ name: call.name, args: call.args, output: '', responseId: id, cancelled: true })
		}
		if (this.queuedResponse && !this.activeResponse) {
			this.queuedResponse = false
			this.createResponse()
		}
		if (!this.activeResponse && !this.transport?.isPlaying() && !this.delegateRun && !this.pushing) {
			this.$status.set(this.$mode.get() === 'handsfree' ? 'listening' : 'ready')
		}
	}

	private sendToolOutput(call: PendingTool, output: string) {
		this.metrics.toolCalls.push({ name: call.name, args: call.args, output, responseId: call.responseId })
		this.transport?.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.callId, output } })
	}

	private turnFor(responseId: string): VoiceTurn {
		return {
			baseRev: this.baseRev,
			passId: `voice-${responseId}`,
			requestId: this.requestId,
			userText: () => this.userText,
		}
	}

	/** Run a quick tool and return what the voice model hears back. */
	private runTool(call: PendingTool): string {
		const turn = this.turnFor(call.responseId)
		const args = call.args as any
		try {
			switch (call.name) {
				case 'point': {
					const unknown = (Array.isArray(args.cues) ? args.cues : []).map((c: any) => String(c?.target ?? '')).filter((t: string) => !resolveTarget(this.editor, t))
					return unknown.length > 0 ? `Pointing, but these are not on the board: ${unknown.join(', ')}.` : 'Pointing. Now speak.'
				}
				case 'read_board': {
					this.baseRev = this.agent.commands.getRev()
					this.boardSentRev = this.baseRev
					return describeBoardForVoice(this.editor)
				}
				case 'set_parameter':
					return this.noteChange(setParameter(this.agent, turn, args), call)
				case 'place_note':
					return this.noteChange(placeNote(this.agent, turn, args), call)
				case 'ask_prediction':
					return this.noteChange(askPrediction(this.agent, turn, args), call)
				default:
					return `There is no tool called ${call.name}.`
			}
		} catch (error) {
			console.warn('Voice tool failed:', call.name, error)
			return `That did not work: ${error instanceof Error ? error.message : String(error)}`
		}
	}

	private noteChange(result: { ok: boolean; output: string }, call: PendingTool) {
		if (result.ok) {
			// The voice model made this change itself, so it does not need to hear the board again.
			this.boardSentRev = this.agent.commands.getRev()
			this.baseRev = this.boardSentRev
			this.markTurnChanged(`voice-${call.responseId}`)
		}
		return result.output
	}

	// ==================== Delegate ====================

	/**
	 * Hand heavy work to the agent, as a request from the user, and answer the
	 * voice model when the agent is done, with what is now on the board. An
	 * interruption cancels the agent's pass; what it already placed stays.
	 */
	private async runDelegate(call: PendingTool) {
		const { agent } = this
		const request = String((call.args as { request?: unknown }).request ?? '').trim()
		if (!request) {
			this.sendToolOutput(call, 'Say what to make.')
			this.createResponse()
			return
		}
		this.delegateRun?.cancel()
		const from = agent.commands.getHistory().length
		let cancelled = false
		this.delegateRun = {
			callId: call.callId,
			responseId: call.responseId,
			cancel: () => {
				cancelled = true
				agent.cancel()
			},
		}
		this.$status.set('working')
		agent.interrupt({
			input: {
				agentMessages: [request],
				userMessages: [request],
				bounds: this.editor.getViewportPageBounds(),
				source: 'user',
				contextItems: agent.context.getItems(),
			},
		})
		// Wait for the request to start, then to finish.
		const started = Date.now()
		while (!cancelled && !agent.requests.isGenerating() && Date.now() - started < 3000) await sleep(50)
		while (!cancelled && agent.requests.isGenerating()) await sleep(200)
		const run = this.delegateRun
		if (run?.callId === call.callId) this.delegateRun = null
		const work = describeNewWork(agent, from)
		this.syncBoardAfterDelegate()
		if (cancelled) {
			this.metrics.toolCalls.push({ name: 'delegate', args: call.args, output: `cancelled: ${work.summary}`, responseId: call.responseId, cancelled: true, placed: work.created })
			this.transport?.send({
				type: 'conversation.item.create',
				item: { type: 'function_call_output', call_id: call.callId, output: `Stopped, because the user started talking. What was already placed stays. ${work.summary}` },
			})
			return
		}
		this.sendToolOutput(call, `Done. ${work.summary}`)
		if (!this.transport) return
		this.createResponse()
	}

	private syncBoardAfterDelegate() {
		this.baseRev = this.agent.commands.getRev()
		this.boardSentRev = this.baseRev
	}

	// ==================== Speech and pointing ====================

	private planCues(args: { cues?: unknown }) {
		const raw = Array.isArray(args.cues) ? args.cues : []
		this.pendingCues = raw
			.map((c: any) => ({ target: String(c?.target ?? ''), highlight: !!c?.highlight, words: String(c?.words ?? '') }))
			.filter((c) => c.target)
			.map((c) => ({ ...c, label: resolveTarget(this.editor, c.target)?.label ?? '' }))
	}

	private handleTranscript(event: any) {
		if (this.cancelledResponses.has(event.response_id)) return
		let speech = this.speech.get(event.item_id)
		if (!speech) {
			// This item's speech carries the cues planned just before it.
			speech = { responseId: event.response_id, tracker: new SentenceTracker(), cues: this.pendingCues, nextCue: 0, chars: 0 }
			this.pendingCues = []
			this.speech.set(event.item_id, speech)
		}
		speech.chars += String(event.delta ?? '').length
		const { started, finished } = speech.tracker.push(String(event.delta ?? ''), 0)
		// The first sentence takes the first cue as soon as it starts; later ones once their words are known.
		if (started.includes(0) && speech.cues.length > 0) this.assignCue(event.item_id, 0, '')
		for (const index of finished) if (index > 0) this.assignCue(event.item_id, index, speech.tracker.get(index).text)
		this.$status.set('speaking')
	}

	private finishTranscript(event: any) {
		const speech = this.speech.get(event.item_id)
		if (!speech || this.cancelledResponses.has(event.response_id)) return
		for (const index of speech.tracker.end()) if (index > 0) this.assignCue(event.item_id, index, speech.tracker.get(index).text)
		const text = String(event.transcript ?? '').trim()
		if (text) this.addLine({ speaker: 'ai', text, ts: Date.now(), passId: `voice-${event.response_id}` })
	}

	/** Match a sentence to its cue, and fire the cue when the sentence starts playing. */
	private assignCue(itemId: string, index: number, text: string) {
		const speech = this.speech.get(itemId)
		if (!speech) return
		const cueIndex = index === 0 ? (speech.nextCue < speech.cues.length ? 0 : -1) : matchCue(text, index, speech.cues, speech.nextCue)
		if (cueIndex < 0) return
		speech.nextCue = cueIndex + 1
		const cue = speech.cues[cueIndex]
		const startedAt = this.transport?.itemStartedAt(itemId)
		// Where the sentence starts in the audio, from its place in the transcript.
		const offset = speech.tracker.charsBefore(index) * MS_PER_CHAR
		const fire = () => {
			if (this.cancelledResponses.has(speech.responseId)) return
			this.fireCue(cue, text || speech.tracker.get(index)?.text || '', startedAt === null || startedAt === undefined ? performance.now() : startedAt + offset)
		}
		if (startedAt === null || startedAt === undefined) {
			// Audio has not started yet: wait for it, then for the sentence.
			this.waitFor(() => this.transport?.itemStartedAt(itemId) ?? null, (at) => this.later(fire, at + offset - performance.now()))
			return
		}
		this.later(fire, startedAt + offset - performance.now())
	}

	private waitFor(get: () => number | null, then: (at: number) => void, tries = 0) {
		const at = get()
		if (at !== null) return then(at)
		if (tries > 100) return
		this.later(() => this.waitFor(get, then, tries + 1), 50)
	}

	/** Run a step of pointing later. Pending steps are canceled when the user interrupts. */
	private later(fn: () => void, ms: number, isCue = true) {
		const timer = setTimeout(() => {
			this.timers.delete(timer)
			this.cueTimers.delete(timer)
			fn()
		}, Math.max(0, ms))
		this.timers.add(timer)
		if (isCue) this.cueTimers.add(timer)
	}

	/** Fly the cursor to a target along a curve, and highlight it. */
	fireCue(cue: Pick<PointCue, 'target' | 'highlight'>, sentence = '', sentenceStartAt = performance.now()) {
		const target = resolveTarget(this.editor, cue.target)
		if (!target) return
		const now = performance.now()
		const current = this.cursorPosition(now)
		const from = current ?? { x: target.anchor.x - 180, y: target.anchor.y - 120 }
		const dx = target.anchor.x - from.x
		const dy = target.anchor.y - from.y
		const length = Math.hypot(dx, dy) || 1
		// Bow the path to one side, as a hand moves, not a straight line.
		const bow = Math.min(160, length * 0.3)
		const control = { x: (from.x + target.anchor.x) / 2 - (dy / length) * bow, y: (from.y + target.anchor.y) / 2 + (dx / length) * bow }
		this.$cursor.set({ from, to: target.anchor, control, startedAt: now, duration: FLY_MS })
		this.fadeMarks()
		const mark: VoiceMark = { key: `${cue.target}:${now}`, target, highlight: cue.highlight, startedAt: now + FLY_MS * 0.6, fadingAt: null }
		this.$marks.update((marks) => [...marks, mark])
		this.metrics.cues.push({ target: cue.target, part: target.part, highlight: cue.highlight, sentence, firedAt: now, sentenceStartAt })
	}

	/** Where the cursor is now, or null when it is not on the board. */
	cursorPosition(now = performance.now()): VecModel | null {
		const cursor = this.$cursor.get()
		if (!cursor) return null
		const t = Math.min(1, Math.max(0, (now - cursor.startedAt) / cursor.duration))
		const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
		const u = 1 - e
		return {
			x: u * u * cursor.from.x + 2 * u * e * cursor.control.x + e * e * cursor.to.x,
			y: u * u * cursor.from.y + 2 * u * e * cursor.control.y + e * e * cursor.to.y,
		}
	}

	private fadeMarks() {
		const now = performance.now()
		this.$marks.update((marks) => marks.filter((m) => m.fadingAt === null || now - m.fadingAt < 600).map((m) => (m.fadingAt === null ? { ...m, fadingAt: now } : m)))
		setTimeout(() => {
			const later = performance.now()
			this.$marks.update((marks) => marks.filter((m) => m.fadingAt === null || later - m.fadingAt < 600))
		}, 700)
	}

	private handlePlaybackStart(itemId: string, at: number) {
		const speech = this.speech.get(itemId)
		const turn = this.metrics.turns.find((t) => t.responseId === speech?.responseId) ?? this.metrics.turns[this.metrics.turns.length - 1]
		if (turn && turn.firstAudioAt === null) turn.firstAudioAt = at
		this.$status.set('speaking')
	}

	private handlePlaybackEnd() {
		if (this.activeResponse || this.delegateRun || this.pushing) return
		this.$status.set(this.transport ? (this.$mode.get() === 'handsfree' ? 'listening' : 'ready') : 'off')
		// Highlights stay a moment after the voice stops, then fade.
		this.later(() => {
			if (!this.transport?.isPlaying()) this.fadeMarks()
		}, 2500, false)
	}

	// ==================== Interruption ====================

	/**
	 * The user started talking: stop the voice now and cancel what is now
	 * obsolete. That is the response being generated, its tool calls, cues not
	 * yet shown, and a running delegate pass. Finished work stays on the board;
	 * reverting it is a separate action.
	 */
	interrupt(reason: string) {
		const transport = this.transport
		if (!transport) return
		const heardAt = this.heardSpeechAt ?? performance.now()
		const wasPlaying = transport.isPlaying()
		const cancelled: string[] = []
		if (wasPlaying) {
			const { itemId, playedMs } = transport.stopPlayback()
			cancelled.push('speech')
			// Over a WebSocket the page knows what was heard, so it trims the rest from the conversation.
			if (transport.kind === 'websocket' && itemId) {
				transport.send({ type: 'conversation.item.truncate', item_id: itemId, content_index: 0, audio_end_ms: playedMs })
			}
		}
		const stoppedAt = performance.now()
		const response = this.activeResponse
		if (response) {
			this.cancelledResponses.add(response)
			transport.discardResponse(response)
			transport.send({ type: 'response.cancel' })
			this.activeResponse = null
			cancelled.push('response')
		}
		// Speech already generated but not yet played belongs to finished responses too.
		for (const [, speech] of this.speech) {
			if (wasPlaying) {
				this.cancelledResponses.add(speech.responseId)
				transport.discardResponse(speech.responseId)
			}
		}
		const pending = this.cancelPending(reason)
		cancelled.push(...pending)
		if (wasPlaying || cancelled.length > 0) this.metrics.interruptions.push({ reason, heardAt, stoppedAt, wasPlaying, cancelled })
		this.fadeMarks()
	}

	/** Cancel what has not happened yet: cues, queued responses, and a running delegate pass. */
	private cancelPending(_reason: string): string[] {
		const cancelled: string[] = []
		if (this.cueTimers.size > 0) cancelled.push(`${this.cueTimers.size} pending cues`)
		for (const timer of this.timers) clearTimeout(timer)
		this.timers.clear()
		this.cueTimers.clear()
		this.pendingCues = []
		this.queuedResponse = false
		if (this.delegateRun) {
			this.delegateRun.cancel()
			this.delegateRun = null
			cancelled.push('delegate')
		}
		return cancelled
	}

	private handleMicLevel(level: number) {
		this.$level.set(level)
		if (this.$mode.get() !== 'handsfree' || !this.transport) return
		const now = performance.now()
		if (level < BARGE_IN_LEVEL) {
			this.loudSince = null
			return
		}
		this.loudSince ??= now
		// The user talks over the AI: stop the voice before the server's turn detection hears it.
		if (now - this.loudSince >= BARGE_IN_MS && this.transport.isPlaying()) {
			this.heardSpeechAt = this.loudSince
			this.interrupt('barge-in')
			this.$status.set('listening')
		}
	}

	// ==================== Transcript and revert ====================

	private changedTurns = new Set<string>()

	private markTurnChanged(passId: string) {
		this.changedTurns.add(passId)
		this.$lines.update((lines) => [...lines])
	}

	/** Whether a voice turn changed the board, so it can be reverted. */
	turnChanged(passId: string) {
		return this.changedTurns.has(passId) && this.agent.commands.getAgentCommandIds({ passId }).length > 0
	}

	/** Revert one voice turn's board changes, keeping newer user work. Separate from stopping. */
	revertTurn(passId: string) {
		const result = this.agent.revert({ passId })
		this.changedTurns.delete(passId)
		this.$lines.update((lines) => [...lines])
		return result
	}

	private addLine(line: VoiceLine) {
		this.$lines.update((lines) => [...lines.slice(-40), line])
		if (!this.options.persist) return
		void fetch(`/board/${this.options.boardId ?? 'default'}/transcripts`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ speaker: line.speaker, text: line.text, ts: line.ts }),
		}).catch(() => {})
	}

	dispose() {
		this.stop()
		managers.delete(this.agent.editor)
	}
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `?voice=ws` or `easel.voiceTransport = websocket` forces the WebSocket path, as on networks without WebRTC. */
function readTransportPreference(): 'webrtc' | 'websocket' | null {
	try {
		const query = new URLSearchParams(location.search).get('voice')
		if (query === 'ws' || query === 'websocket') return 'websocket'
		if (sessionStorage.getItem('easel.voiceWebRtcFailed') === '1') return 'websocket'
		const stored = localStorage.getItem('easel.voiceTransport')
		if (stored === 'websocket' || stored === 'webrtc') return stored
	} catch {
		// No storage: use the default.
	}
	return null
}

function rememberWebRtcFailed() {
	try {
		sessionStorage.setItem('easel.voiceWebRtcFailed', '1')
	} catch {
		// No storage: try WebRTC again next time.
	}
}
