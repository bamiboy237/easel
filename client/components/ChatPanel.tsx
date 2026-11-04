import { FormEventHandler, useCallback, useEffect, useRef, useState } from 'react'
import { useValue } from 'tldraw'
import { answerQuestion, getOpenQuestion } from '../agent/openQuestion'
import { useAgent } from '../agent/TldrawAgentAppProvider'
import { ChatHistory } from './chat-history/ChatHistory'
import { ChatInput } from './ChatInput'
import { TodoList } from './TodoList'

/**
 * The agent pane has three states, so the board stays the main workspace:
 * - quiet: only the composer, floating over the board
 * - responding: the composer with the latest answer above it, after you send
 * - expanded: the docked panel with the whole conversation
 * Sending reveals the answer; it never opens the full panel. The answer stays
 * until you close it, and the draft and conversation carry across states.
 */
type PaneState = 'quiet' | 'responding' | 'expanded'

const PANE_KEY = 'easel.pane'

function loadPane(): PaneState {
	try {
		return localStorage.getItem(PANE_KEY) === 'expanded' ? 'expanded' : 'quiet'
	} catch {
		return 'quiet'
	}
}

function savePane(state: PaneState) {
	try {
		localStorage.setItem(PANE_KEY, state === 'expanded' ? 'expanded' : 'quiet')
	} catch {
		// Storage can be unavailable; the pane still works, it just won't remember.
	}
}

export function ChatPanel() {
	const agent = useAgent()
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const [pane, setPaneState] = useState<PaneState>(loadPane)
	const [draft, setDraft] = useState('')
	const setPane = useCallback((state: PaneState) => {
		setPaneState(state)
		savePane(state)
	}, [])

	// "/" puts the cursor in the composer from anywhere on the board.
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
			const target = event.target as HTMLElement | null
			if (target?.closest('input, textarea, [contenteditable="true"]')) return
			if (agent.editor.getEditingShapeId()) return
			event.preventDefault()
			inputRef.current?.focus()
		}
		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [agent])

	// While the agent waits on a question, the number keys pick its choices,
	// unless the user is typing somewhere.
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
			const index = Number(event.key) - 1
			if (!Number.isInteger(index) || index < 0 || index > 3) return
			const target = event.target as HTMLElement | null
			if (target?.closest('input, textarea, [contenteditable="true"]')) return
			if (agent.editor.getEditingShapeId() || agent.requests.isGenerating()) return
			const open = getOpenQuestion(agent.chat.getHistory())
			const choice = open?.choices[index]
			if (!open || !choice) return
			event.preventDefault()
			event.stopPropagation()
			void answerQuestion(agent, open.question, choice)
		}
		window.addEventListener('keydown', handleKeyDown, { capture: true })
		return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
	}, [agent])

	const handleSubmit = useCallback<FormEventHandler<HTMLFormElement>>(
		async (e) => {
			e.preventDefault()
			if (!inputRef.current) return
			const formData = new FormData(e.currentTarget)
			const value = formData.get('input') as string

			// If the user's message is empty, just cancel the current request (if there is one)
			if (value === '') {
				agent.cancel()
				return
			}

			// Clear the chat input (context is cleared after it's captured in requestAgentActions)
			inputRef.current.value = ''

			// Sending reveals the answer above the composer, unless the full panel is open.
			setPaneState((state) => (state === 'expanded' ? state : 'responding'))

			// Sending a new message to the agent should interrupt the current request
			agent.interrupt({
				input: {
					agentMessages: [value],
					bounds: agent.editor.getViewportPageBounds(),
					source: 'user',
					contextItems: agent.context.getItems(),
				},
			})
		},
		[agent]
	)

	const handleNewChat = useCallback(() => {
		agent.reset()
	}, [agent])

	const isEmpty = useValue('chat is empty', () => agent.chat.getHistory().length === 0, [agent])

	const composer = (
		<div className="chat-input-container">
			<TodoList agent={agent} />
			<ChatInput
				handleSubmit={handleSubmit}
				inputRef={inputRef}
				value={draft}
				onChange={setDraft}
				onEscape={pane === 'responding' ? () => setPane('quiet') : undefined}
			/>
		</div>
	)

	if (pane !== 'expanded') {
		return (
			<div className="chat-panel chat-panel--floating tl-theme__light">
				{pane === 'responding' && !isEmpty && (
					<div className="chat-answer">
						<div className="chat-answer-controls">
							<button className="chat-icon-button" title="Open the conversation" aria-label="Open the conversation" onClick={() => setPane('expanded')}>
								<ExpandGlyph />
							</button>
							<button className="chat-icon-button" title="Close" aria-label="Close" onClick={() => setPane('quiet')}>
								<CloseGlyph />
							</button>
						</div>
						<ChatHistory agent={agent} latestOnly />
					</div>
				)}
				{composer}
				{pane === 'quiet' && !isEmpty && (
					<button className="chat-quiet-open" onClick={() => setPane('expanded')}>
						Conversation
					</button>
				)}
			</div>
		)
	}

	return (
		<div className="chat-panel tl-theme__light">
			<div className="chat-header">
				<span className="chat-wordmark">Easel</span>
				<span className="chat-header-actions">
					<button className="new-chat-button" onClick={handleNewChat}>
						New chat
					</button>
					<button className="chat-icon-button" title="Close the conversation" aria-label="Close the conversation" onClick={() => setPane('quiet')}>
						<CollapseGlyph />
					</button>
				</span>
			</div>
			{isEmpty ? (
				<div className="chat-empty">
					<p className="chat-empty-hint">Ask a question, or mark something on the board and ask about it.</p>
				</div>
			) : (
				<ChatHistory agent={agent} />
			)}
			{composer}
		</div>
	)
}

/** Fine-stroke glyphs that match the toolbar: 1.5 px on a 24 px grid. */
function Glyph({ children }: { children: React.ReactNode }) {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
			{children}
		</svg>
	)
}

function ExpandGlyph() {
	return (
		<Glyph>
			<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
		</Glyph>
	)
}

function CollapseGlyph() {
	return (
		<Glyph>
			<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
		</Glyph>
	)
}

function CloseGlyph() {
	return (
		<Glyph>
			<path d="M18 6 6 18M6 6l12 12" />
		</Glyph>
	)
}
