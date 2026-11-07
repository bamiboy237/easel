import { VOICE_MODEL, VOICE_SAMPLE_RATE } from '../../shared/voice/realtime'

/**
 * The connection to one OpenAI Realtime session. WebRTC is the default: the
 * browser sends the microphone and plays the model's voice itself, and events
 * travel on a data channel. When WebRTC cannot reach OpenAI, as behind a proxy
 * that passes only HTTPS, the same session runs over a WebSocket, and the page
 * streams the microphone as PCM and plays the audio itself.
 */
export interface RealtimeTransport {
	readonly kind: 'webrtc' | 'websocket'
	connect(key: string): Promise<void>
	send(event: object): void
	/** Push to talk: whether the microphone reaches the model. */
	setMicOpen(open: boolean): void
	/** Stop the model's voice at once. Returns how much of the current item was heard. */
	stopPlayback(): { itemId: string | null; playedMs: number }
	/** Drop any audio still to come for a response, after it was interrupted. */
	discardResponse(responseId: string): void
	/** When an item's audio started playing, in `performance.now()` time, or null. */
	itemStartedAt(itemId: string): number | null
	/** Whether the model's voice is playing now. */
	isPlaying(): boolean
	close(): void
}

export interface TransportHandlers {
	/** A server event. */
	onEvent: (event: any) => void
	/** The model's voice for an item started playing, at `at` in `performance.now()` time. */
	onPlaybackStart: (itemId: string, at: number) => void
	/** The model's voice stopped, because it finished or was stopped. */
	onPlaybackEnd: () => void
	/** The microphone level of each 50 ms of audio, from 0 to 1. */
	onMicLevel: (level: number) => void
	onClose: () => void
}

const MIC_CONSTRAINTS: MediaTrackConstraints = {
	channelCount: 1,
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true,
}

/** The worklet copies microphone frames to the main thread. */
const WORKLET = `
class Capture extends AudioWorkletProcessor {
	process(inputs) {
		const channel = inputs[0] && inputs[0][0]
		if (channel) this.port.postMessage(channel.slice(0))
		return true
	}
}
registerProcessor('easel-voice-capture', Capture)
`

/** 50 ms of audio at 24 kHz: the unit for levels and for sending audio. */
const CHUNK = VOICE_SAMPLE_RATE / 20

function rms(samples: Float32Array): number {
	let sum = 0
	for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
	return Math.sqrt(sum / Math.max(1, samples.length))
}

/** Captures the microphone at 24 kHz and reports each 50 ms chunk. */
class MicCapture {
	stream: MediaStream | null = null
	context: AudioContext | null = null
	private pending = new Float32Array(0)

	constructor(private onChunk: (chunk: Float32Array) => void) {}

	async start(stream?: MediaStream) {
		this.stream = stream ?? (await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS }))
		this.context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE })
		const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
		await this.context.audioWorklet.addModule(url)
		URL.revokeObjectURL(url)
		const source = this.context.createMediaStreamSource(this.stream)
		const node = new AudioWorkletNode(this.context, 'easel-voice-capture')
		node.port.onmessage = (event) => this.push(event.data as Float32Array)
		source.connect(node)
	}

	private push(frame: Float32Array) {
		const merged = new Float32Array(this.pending.length + frame.length)
		merged.set(this.pending)
		merged.set(frame, this.pending.length)
		this.pending = merged
		while (this.pending.length >= CHUNK) {
			const chunk = this.pending.slice(0, CHUNK)
			this.pending = this.pending.slice(CHUNK)
			this.onChunk(chunk)
		}
	}

	stop(stopTracks = true) {
		if (stopTracks) this.stream?.getTracks().forEach((track) => track.stop())
		this.stream = null
		void this.context?.close().catch(() => {})
		this.context = null
	}
}

function toBase64Pcm(samples: Float32Array): string {
	const bytes = new Uint8Array(samples.length * 2)
	const view = new DataView(bytes.buffer)
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]))
		view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
	}
	let binary = ''
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	return btoa(binary)
}

function fromBase64Pcm(data: string): Float32Array {
	const binary = atob(data)
	const samples = new Float32Array(binary.length >> 1)
	for (let i = 0; i < samples.length; i++) {
		const lo = binary.charCodeAt(i * 2)
		const hi = binary.charCodeAt(i * 2 + 1)
		let v = (hi << 8) | lo
		if (v & 0x8000) v -= 0x10000
		samples[i] = v / 0x8000
	}
	return samples
}

/** The session over WebRTC: the browser streams and plays audio, and events go over a data channel. */
export class WebRtcTransport implements RealtimeTransport {
	readonly kind = 'webrtc' as const
	private pc: RTCPeerConnection | null = null
	private dc: RTCDataChannel | null = null
	private audio: HTMLAudioElement | null = null
	private mic: MicCapture | null = null
	private track: MediaStreamTrack | null = null
	private playing: { itemId: string | null; responseId: string | null; at: number } | null = null
	private starts = new Map<string, number>()
	private discarded = new Set<string>()
	private closed = false

	constructor(private handlers: TransportHandlers, private connectTimeoutMs = 6000) {}

	async connect(key: string) {
		const pc = (this.pc = new RTCPeerConnection())
		this.audio = document.createElement('audio')
		this.audio.autoplay = true
		pc.ontrack = (event) => {
			if (this.audio) this.audio.srcObject = event.streams[0]
		}
		const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS })
		this.track = stream.getAudioTracks()[0]
		pc.addTrack(this.track, stream)
		// The same microphone, measured here for the level the app uses to hear the user start talking.
		this.mic = new MicCapture((chunk) => this.handlers.onMicLevel(rms(chunk)))
		await this.mic.start(stream)
		const dc = (this.dc = pc.createDataChannel('oai-events'))
		dc.onmessage = (event) => this.handleEvent(JSON.parse(event.data as string))
		dc.onclose = () => this.close()
		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)
		const response = await fetch('https://api.openai.com/v1/realtime/calls', {
			method: 'POST',
			body: offer.sdp,
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/sdp' },
		})
		if (!response.ok) throw new Error(`WebRTC session ${response.status}`)
		await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() })
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('WebRTC did not connect')), this.connectTimeoutMs)
			const check = () => {
				if (dc.readyState === 'open') {
					clearTimeout(timer)
					resolve()
				}
			}
			dc.onopen = check
			pc.onconnectionstatechange = () => {
				if (pc.connectionState === 'failed') {
					clearTimeout(timer)
					reject(new Error('WebRTC failed'))
				}
			}
			check()
		})
	}

	private handleEvent(event: any) {
		if (event.type === 'output_audio_buffer.started') {
			if (this.discarded.has(event.response_id)) return
			if (this.audio) this.audio.muted = false
			const at = performance.now()
			this.playing = { itemId: null, responseId: event.response_id, at }
		}
		if (event.type === 'response.output_item.added' && event.item?.type === 'message' && this.playing && !this.playing.itemId) {
			this.playing.itemId = event.item.id
		}
		if (event.type === 'response.output_audio_transcript.delta' && event.item_id && !this.starts.has(event.item_id)) {
			// Over WebRTC the server says when audio starts for a response; the item
			// whose transcript comes with it is the one playing.
			const at = this.playing && this.playing.responseId === event.response_id ? this.playing.at : performance.now()
			this.starts.set(event.item_id, at)
			if (this.playing) this.playing.itemId = event.item_id
			this.handlers.onPlaybackStart(event.item_id, at)
		}
		if (event.type === 'output_audio_buffer.stopped' || event.type === 'output_audio_buffer.cleared') {
			this.playing = null
			this.handlers.onPlaybackEnd()
		}
		this.handlers.onEvent(event)
	}

	send(event: object) {
		if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(event))
	}

	setMicOpen(open: boolean) {
		if (this.track) this.track.enabled = open
	}

	stopPlayback() {
		const playing = this.playing
		// Muting stops the voice now; clearing the buffer stops the server
		// sending more, and truncates the item to what was heard.
		if (this.audio) this.audio.muted = true
		this.send({ type: 'output_audio_buffer.clear' })
		this.playing = null
		return { itemId: playing?.itemId ?? null, playedMs: playing ? performance.now() - playing.at : 0 }
	}

	discardResponse(responseId: string) {
		this.discarded.add(responseId)
	}

	itemStartedAt(itemId: string) {
		return this.starts.get(itemId) ?? null
	}

	isPlaying() {
		return !!this.playing
	}

	close() {
		if (this.closed) return
		this.closed = true
		this.mic?.stop()
		this.track?.stop()
		this.dc?.close()
		this.pc?.close()
		if (this.audio) this.audio.srcObject = null
		this.handlers.onClose()
	}
}

/**
 * The session over a WebSocket, for networks where WebRTC cannot reach OpenAI.
 * The page sends the microphone as 24 kHz PCM and schedules the model's audio
 * itself, so it knows exactly what was heard when the user interrupts.
 */
export class WebSocketTransport implements RealtimeTransport {
	readonly kind = 'websocket' as const
	private ws: WebSocket | null = null
	private mic: MicCapture | null = null
	private micOpen = true
	private out: AudioContext | null = null
	private nextTime = 0
	private sources = new Set<AudioBufferSourceNode>()
	private items = new Map<string, { startCtx: number; startPerf: number }>()
	private current: string | null = null
	private discarded = new Set<string>()
	private endTimer: ReturnType<typeof setTimeout> | null = null
	private closed = false

	constructor(private handlers: TransportHandlers) {}

	async connect(key: string) {
		this.out = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE })
		void this.out.resume().catch(() => {})
		this.mic = new MicCapture((chunk) => {
			this.handlers.onMicLevel(rms(chunk))
			if (this.micOpen && this.ws?.readyState === WebSocket.OPEN) {
				this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: toBase64Pcm(chunk) }))
			}
		})
		const ws = (this.ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${VOICE_MODEL}`, [
			'realtime',
			`openai-insecure-api-key.${key}`,
		]))
		ws.onmessage = (event) => this.handleEvent(JSON.parse(event.data as string))
		ws.onclose = () => this.close()
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('voice connection timed out')), 8000)
			ws.onopen = () => {
				clearTimeout(timer)
				resolve()
			}
			ws.onerror = () => {
				clearTimeout(timer)
				reject(new Error('voice connection failed'))
			}
		})
		await this.mic.start()
	}

	private handleEvent(event: any) {
		if (event.type === 'response.output_audio.delta') {
			if (!this.discarded.has(event.response_id)) this.play(event.item_id, fromBase64Pcm(event.delta))
		}
		this.handlers.onEvent(event)
	}

	private play(itemId: string, samples: Float32Array) {
		const out = this.out
		if (!out || samples.length === 0) return
		const buffer = out.createBuffer(1, samples.length, VOICE_SAMPLE_RATE)
		buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
		const source = out.createBufferSource()
		source.buffer = buffer
		source.connect(out.destination)
		const startCtx = Math.max(out.currentTime + 0.03, this.nextTime)
		source.start(startCtx)
		this.nextTime = startCtx + buffer.duration
		this.sources.add(source)
		source.onended = () => this.sources.delete(source)
		if (!this.items.has(itemId)) {
			const startPerf = performance.now() + (startCtx - out.currentTime) * 1000
			this.items.set(itemId, { startCtx, startPerf })
			this.current = itemId
			this.handlers.onPlaybackStart(itemId, startPerf)
		}
		this.scheduleEnd()
	}

	private scheduleEnd() {
		if (this.endTimer) clearTimeout(this.endTimer)
		const out = this.out
		if (!out) return
		const ms = Math.max(0, (this.nextTime - out.currentTime) * 1000) + 50
		this.endTimer = setTimeout(() => {
			if (this.out && this.out.currentTime >= this.nextTime - 0.01) {
				this.current = null
				this.handlers.onPlaybackEnd()
			} else this.scheduleEnd()
		}, ms)
	}

	send(event: object) {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event))
	}

	setMicOpen(open: boolean) {
		this.micOpen = open
	}

	stopPlayback() {
		const out = this.out
		const itemId = this.current
		let playedMs = 0
		if (out && itemId) {
			const item = this.items.get(itemId)
			if (item) playedMs = Math.max(0, Math.min(this.nextTime, out.currentTime) - item.startCtx) * 1000
		}
		for (const source of this.sources) {
			try {
				source.stop()
			} catch {
				// Already stopped.
			}
		}
		this.sources.clear()
		this.nextTime = out?.currentTime ?? 0
		this.current = null
		if (this.endTimer) clearTimeout(this.endTimer)
		if (itemId) this.handlers.onPlaybackEnd()
		return { itemId, playedMs: Math.round(playedMs) }
	}

	discardResponse(responseId: string) {
		this.discarded.add(responseId)
	}

	itemStartedAt(itemId: string) {
		return this.items.get(itemId)?.startPerf ?? null
	}

	isPlaying() {
		return !!this.out && this.out.currentTime < this.nextTime
	}

	close() {
		if (this.closed) return
		this.closed = true
		this.mic?.stop()
		for (const source of this.sources) {
			try {
				source.stop()
			} catch {
				// Already stopped.
			}
		}
		if (this.endTimer) clearTimeout(this.endTimer)
		void this.out?.close().catch(() => {})
		if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close()
		this.handlers.onClose()
	}
}
