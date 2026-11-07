import { useEffect, useRef } from 'react'
import { useEditor, useValue } from 'tldraw'
import { getVoiceManager, VoiceStatus } from '../voice/VoiceManager'

const STATUS_TEXT: Record<VoiceStatus, string> = {
	off: 'Voice',
	connecting: 'Connecting',
	ready: 'Hold to talk',
	listening: 'Listening',
	thinking: 'Thinking',
	speaking: 'Speaking',
	working: 'Drawing',
	error: 'Voice is unavailable',
}

/** The key held for push to talk. */
const TALK_KEY = '`'

function isTyping(target: EventTarget | null) {
	const el = target as HTMLElement | null
	return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

/**
 * A small, quiet mic control at the bottom of the board. Click it to start a
 * voice conversation; then hold it, or hold the backquote key, to talk. In
 * hands-free mode it listens until stopped. While the AI speaks, talking (or
 * pressing) stops it.
 */
export function VoiceControl() {
	const editor = useEditor()
	const voice = getVoiceManager(editor)
	const status = useValue('voice status', () => voice?.$status.get() ?? 'off', [voice])
	const mode = useValue('voice mode', () => voice?.$mode.get() ?? 'push', [voice])
	const level = useValue('voice level', () => voice?.$level.get() ?? 0, [voice])
	const lastAi = useValue('voice last line', () => [...(voice?.$lines.get() ?? [])].reverse().find((l) => l.speaker === 'ai'), [voice])
	const canUndo = useValue('voice can undo', () => !!lastAi?.passId && !!voice?.turnChanged(lastAi.passId), [voice, lastAi])
	const holding = useRef(false)

	useEffect(() => {
		if (!voice) return
		const down = (e: KeyboardEvent) => {
			if (e.key !== TALK_KEY || e.repeat || isTyping(e.target) || !voice.isOn()) return
			e.preventDefault()
			holding.current = true
			voice.pressStart()
		}
		const up = (e: KeyboardEvent) => {
			if (e.key !== TALK_KEY || !holding.current) return
			holding.current = false
			voice.pressEnd()
		}
		window.addEventListener('keydown', down)
		window.addEventListener('keyup', up)
		return () => {
			window.removeEventListener('keydown', down)
			window.removeEventListener('keyup', up)
		}
	}, [voice])

	if (!voice) return null
	const on = status !== 'off' && status !== 'error' && status !== 'connecting'
	const connecting = status === 'connecting'
	// The ring around the mic follows the user's voice while the mic is open.
	const ring = status === 'listening' ? Math.min(1, level * 14) : 0

	return (
		<div className={`voice-control voice-control--${status}${on || connecting ? ' voice-control--on' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
			<button
				className="voice-mic"
				aria-label={on ? (mode === 'push' ? 'Hold to talk' : 'Listening') : 'Start voice'}
				title={on ? (mode === 'push' ? 'Hold to talk (or hold `)' : 'Listening. Talk any time.') : 'Talk with Easel'}
				style={{ ['--voice-ring' as string]: ring.toFixed(3) }}
				onClick={() => {
					if (!on && !connecting) void voice.start()
				}}
				onPointerDown={(e) => {
					if (!on || mode !== 'push') return
					e.currentTarget.setPointerCapture(e.pointerId)
					holding.current = true
					voice.pressStart()
				}}
				onPointerUp={() => {
					if (!holding.current) return
					holding.current = false
					voice.pressEnd()
				}}
			>
				<MicGlyph />
			</button>
			{on && (
				<>
					<span className="voice-status" role="status">
						{mode === 'handsfree' && status === 'ready' ? 'Listening' : STATUS_TEXT[status]}
					</span>
					<button
						className={`voice-mode${mode === 'handsfree' ? ' voice-mode--on' : ''}`}
						title="Hands-free: talk any time, without holding the mic"
						aria-pressed={mode === 'handsfree'}
						onClick={() => voice.setMode(mode === 'push' ? 'handsfree' : 'push')}
					>
						Hands-free
					</button>
					{canUndo && lastAi?.passId && (
						<button className="voice-undo" title="Undo what the voice just changed on the board" onClick={() => voice.revertTurn(lastAi.passId!)}>
							Undo
						</button>
					)}
					<button className="voice-close" aria-label="End voice" title="End voice" onClick={() => voice.stop()}>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
							<path d="M18 6 6 18M6 6l12 12" />
						</svg>
					</button>
				</>
			)}
			{(status === 'error' || connecting) && <span className="voice-status">{STATUS_TEXT[status]}</span>}
		</div>
	)
}

function MicGlyph() {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
			<rect x="9" y="3" width="6" height="11" rx="3" />
			<path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
		</svg>
	)
}
