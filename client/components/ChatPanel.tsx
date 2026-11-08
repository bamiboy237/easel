import { FormEventHandler, useCallback, useEffect, useRef, useState } from 'react'
import { getCameraFollow } from '../voice/follow'
import { Box, TLShape, TLShapeId, useValue } from 'tldraw'
import type { AgentWork } from '../agent/managers/AgentActionManager'
import type { TldrawAgent } from '../agent/TldrawAgent'
import { runningVideoJobs } from '../shapes/video/jobs'
import { runningWidgetJobs } from '../shapes/widget/jobs'
import { getUsableViewBounds } from '../agent/findClearSpace'
import { AgentFace } from '../../shared/icons/AgentFace'
import { answerQuestion, getOpenQuestion } from '../agent/openQuestion'
import { useAgent } from '../agent/TldrawAgentAppProvider'
import { ChatHistory } from './chat-history/ChatHistory'
import { ChatInput } from './ChatInput'
import { RequestProgress } from './RequestProgress'
import { TodoList } from './TodoList'

/**
 * The agent pane has four states, so the board stays the main workspace:
 * - ball: a small pencil-nib ball in the corner while you work on the board
 * - quiet: only the composer, floating over the board
 * - responding: the composer with the latest answer above it, after you send
 * - expanded: the docked panel with the whole conversation
 * Sending reveals the answer; it never opens the full panel. The answer stays
 * until you close it, and the draft and conversation carry across states.
 */
type PaneState = 'ball' | 'quiet' | 'responding' | 'expanded'

const PANE_KEY = 'easel.pane'

/**
 * The expanded panel is remembered. Otherwise the pane starts as a ball, except
 * the very first time, when it starts as the composer so it is easy to find.
 */
function loadPane(): PaneState {
	try {
		const saved = localStorage.getItem(PANE_KEY)
		if (saved === 'expanded') return 'expanded'
		return saved === null ? 'quiet' : 'ball'
	} catch {
		return 'quiet'
	}
}

function savePane(state: PaneState) {
	try {
		localStorage.setItem(PANE_KEY, state === 'expanded' ? 'expanded' : 'ball')
	} catch {
		// Storage can be unavailable; the pane still works, it just won't remember.
	}
}

export function ChatPanel() {
	const agent = useAgent()
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const [pane, setPaneState] = useState<PaneState>(loadPane)
	const [draft, setDraft] = useState('')
	const [unread, setUnread] = useState(false)
	const paneRef = useRef(pane)
	paneRef.current = pane
	const setPane = useCallback((state: PaneState) => {
		setPaneState(state)
		savePane(state)
		if (state !== 'ball') setUnread(false)
	}, [])
	const isGenerating = useValue('pane generating', () => agent.requests.isGenerating(), [agent])

	// Open the composer and put the cursor in it.
	const openComposer = useCallback(() => {
		setPane('quiet')
		requestAnimationFrame(() => inputRef.current?.focus())
	}, [setPane])

	// The composer folds back into the ball when the user goes back to the board,
	// but never with a draft in it and never while an answer is open.
	useEffect(() => {
		if (pane !== 'quiet' || draft !== '') return
		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target as HTMLElement | null
			if (target?.closest('.chat-panel')) return
			setPane('ball')
		}
		window.addEventListener('pointerdown', handlePointerDown, { capture: true })
		return () => window.removeEventListener('pointerdown', handlePointerDown, { capture: true })
	}, [pane, draft, setPane])

	// A question from the agent must be seen to be answered, whatever started the
	// request, so an open question brings up the answer view.
	const hasOpenQuestion = useValue('pane open question', () => getOpenQuestion(agent.chat.getHistory()) !== null, [agent])
	useEffect(() => {
		if (hasOpenQuestion && (pane === 'ball' || pane === 'quiet')) setPaneState('responding')
	}, [hasOpenQuestion, pane])

	// When a chat answer finishes while the pane is a ball, the ball shows a dot.
	// Answers to marks land on the board beside the mark, so they need no dot.
	const wasGenerating = useRef(false)
	useEffect(() => {
		if (wasGenerating.current && !isGenerating && pane === 'ball' && !agent.marks.getActive()) setUnread(true)
		wasGenerating.current = isGenerating
	}, [isGenerating, pane, agent])

	// "/" puts the cursor in the composer from anywhere on the board.
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
			const target = event.target as HTMLElement | null
			if (target?.closest('input, textarea, [contenteditable="true"]')) return
			if (agent.editor.getEditingShapeId()) return
			event.preventDefault()
			// From the ball, open the composer. Otherwise keep the pane as it is.
			if (paneRef.current === 'ball') openComposer()
			else inputRef.current?.focus()
		}
		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [agent, openComposer])

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
			// Only a question the user can see is answered by a number key.
			if (paneRef.current === 'ball' || paneRef.current === 'quiet') return
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
				agent.stop()
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

	// Escape steps the pane back one state: the answer closes, then an empty
	// composer folds into the ball. With a draft, the draft stays and the board
	// gets the keyboard back.
	const escapeComposer = () => {
		if (pane === 'responding') setPane('quiet')
		else if (pane === 'quiet' && draft === '') {
			setPane('ball')
			agent.editor.focus()
		}
		else {
			inputRef.current?.blur()
			agent.editor.focus()
		}
	}
	// While the agent changes the board, the answer card folds to one line, so it
	// never hides the work.
	const work = useValue('pane agent work', () => agent.actions.getWork(), [agent])
	// After a request that drew on the board, the card stays one line, so the
	// drawing is what the user sees. "See more" opens the whole conversation. An
	// open question is the exception: it must be seen to be answered.
	const lastWork = useValue('pane last work', () => agent.actions.getLastWork(), [agent])
	// The line says what is true now: a failure or a stop first, then
	// background work (a widget or an animation) as it lands, then the agent's
	// own first sentence, and otherwise what it put on the board.
	const outcome = useValue('pane outcome', () => agent.getOutcome(), [agent])
	const notices = useValue('pane notices', () => agent.actions.getNotices(), [agent])
	// After a correction, such as an edit the board refused, the agent's later
	// message is the true one, so the card shows the latest message instead.
	const corrected = notices.length > 0
	const lastSaid = useValue('pane last said', () => firstSentence(lastMessage(agent.chat.getHistory(), corrected)), [agent, corrected])
	const unfinishedParts = useValue(
		'pane unfinished parts',
		() => agent.editor.getCurrentPageShapes().filter((shape) => shape.type === 'frame' && agent.frames.getPartStatus(shape) === 'unfinished').length,
		[agent]
	)
	const jobs = useValue('pane jobs', () => describeJobs(agent, lastWork), [agent, lastWork])
	const answeredInThread = useValue('pane answered in thread', () => repliedInThread(agent.chat.getHistory()), [agent])
	const status: CardStatus | null = isGenerating || hasOpenQuestion
		? null
		: outcome?.status === 'failed'
			? { text: outcome.message, detail: outcome.request, action: { label: 'Retry', run: () => agent.retry() } }
			: outcome?.status === 'stopped'
				? {
						text:
							'Stopped. ' +
							(unfinishedParts > 0
								? `${unfinishedParts === 1 ? 'One part is' : `${unfinishedParts} parts are`} unfinished; fill or redo each one from its frame.`
								: outcome.landed
									? 'What I drew before you stopped stays on the board.'
									: 'Nothing changed on the board.'),
					}
				: jobs
					? jobs
					: lastWork
						? { text: lastSaid ?? (answeredInThread ? 'I answered beside your mark.' : describeWork(agent, lastWork)) ?? '' }
						: notices.length > 0
							? { text: lastSaid ?? 'Nothing changed on the board.' }
							: null
	const summary = status?.text || null
	// Work that landed out of the user's view gets a Show link, for when the
	// camera could not follow because the user was working.
	const hiddenWork = useValue(
		'pane hidden work',
		() => {
			if (!summary || !lastWork) return null
			const editor = agent.editor
			const boxes = lastWork.createdIds
				.map((id) => editor.getShape(id as TLShapeId))
				// Page bounds cover work drawn inside frames too, such as a map filled in later.
				.filter((shape) => !!shape)
				.map((shape) => editor.getShapePageBounds(shape!))
				.filter((b): b is Box => !!b)
			if (boxes.length === 0) return null
			const all = Box.Common(boxes)
			return getUsableViewBounds(editor).contains(all) ? null : all
		},
		[agent, summary, lastWork]
	)
	// When a request's work lands out of view, the camera glides there once the
	// request finishes, unless the user is working; then Show stays on the card.
	const revealedWork = useRef<unknown>(null)
	useEffect(() => {
		if (!hiddenWork || !lastWork || revealedWork.current === lastWork) return
		revealedWork.current = lastWork
		// The composer keeps focus after a request; while it is empty, it is not work in progress.
		const idle = inputRef.current && !inputRef.current.value.trim() ? inputRef.current : null
		getCameraFollow(agent.editor).reveal(hiddenWork, { idleElement: idle })
	}, [agent, hiddenWork, lastWork])
	// When work lands under the answer card, the card folds into the ball, with
	// a dot, so it never covers what was just made. A failure, a note about
	// the user's text, and a question stay open: they must be read.
	const sheetRef = useRef<HTMLDivElement>(null)
	const foldedFor = useRef<unknown>(null)
	useEffect(() => {
		if (isGenerating || pane !== 'responding' || hasOpenQuestion || !lastWork || foldedFor.current === lastWork) return
		if (outcome?.status === 'failed' || notices.length > 0) return
		const work = lastWork
		const timer = setTimeout(() => {
			const sheet = sheetRef.current?.getBoundingClientRect()
			if (!sheet || foldedFor.current === work) return
			const editor = agent.editor
			const frame = editor.getContainer().getBoundingClientRect()
			const covered = work.createdIds.some((id) => {
				const b = editor.getShapePageBounds(id as TLShapeId)
				if (!b) return false
				const a = editor.pageToViewport({ x: b.minX, y: b.minY })
				const z = editor.pageToViewport({ x: b.maxX, y: b.maxY })
				const left = frame.left + a.x, top = frame.top + a.y, right = frame.left + z.x, bottom = frame.top + z.y
				return left < sheet.right && right > sheet.left && top < sheet.bottom && bottom > sheet.top
			})
			foldedFor.current = work
			if (!covered) return
			setPane('ball')
			setUnread(true)
		}, 900)
		return () => clearTimeout(timer)
	}, [agent, isGenerating, pane, hasOpenQuestion, lastWork, outcome, notices, setPane])
	const showWork = () => {
		if (!hiddenWork) return
		// The user asked to see it, so the camera moves now, into the free part of the view.
		getCameraFollow(agent.editor).reveal(hiddenWork, { justAsked: true, overview: true })
	}

	const composer = (
		<div className="chat-input-container">
			<TodoList agent={agent} />
			<ChatInput
				handleSubmit={handleSubmit}
				inputRef={inputRef}
				value={draft}
				onChange={setDraft}
				onEscape={escapeComposer}
			/>
		</div>
	)

	if (pane === 'ball') {
		return (
			<div className="chat-panel chat-panel--floating chat-panel--ball tl-theme__light">
				<button
					className={'chat-ball' + (isGenerating ? ' chat-ball--working' : '')}
					aria-label={unread ? 'Ask Easel (an answer is waiting)' : 'Ask Easel'}
					title="Ask Easel (/)"
					onClick={() => (unread ? setPane('responding') : openComposer())}
				>
					<AgentFace size={32} />
					{unread && <span className="chat-ball-dot" aria-hidden />}
				</button>
			</div>
		)
	}

	if (pane !== 'expanded') {
		const answering = pane === 'responding' && !isEmpty
		return (
			<div className="chat-panel chat-panel--floating tl-theme__light">
				{/* The answer and the composer are one sheet, with a hairline between them. */}
				<div ref={sheetRef} className={'chat-sheet' + (answering ? ' chat-sheet--answering' : '')}>
					{answering && (
						<div className="chat-answer">
							<div className="chat-answer-header">
								<span className="chat-answer-title" aria-label="Easel">
									<AgentFace size={22} />
								</span>
								<span className="chat-answer-controls">
									<button className="chat-answer-more" onClick={() => setPane('expanded')}>
										See more
									</button>
									<button className="chat-icon-button" title="Close" aria-label="Close" onClick={() => setPane('quiet')}>
										<CloseGlyph />
									</button>
								</span>
							</div>
							{summary ? (
								<>
									<p className="chat-answer-status" role="status">
										{status?.working && (
											<span className="chat-working-dots" aria-hidden>
												<span />
												<span />
												<span />
											</span>
										)}
										<span className="chat-answer-status-text" title={summary}>{summary}</span>
										{status?.action && (
											<button className="chat-answer-show" onClick={status.action.run}>
												{status.action.label}
											</button>
										)}
										{hiddenWork && (
											<button className="chat-answer-show" onClick={showWork}>
												Show
											</button>
										)}
									</p>
									{status?.detail && <p className="chat-answer-notice">{status.detail}</p>}
									{notices.map((notice) => (
										<p key={notice} className="chat-answer-notice">
											{notice}
										</p>
									))}
								</>
							) : work ? (
								<p className="chat-answer-status" role="status">
									<span className="chat-working-dots" aria-hidden>
										<span />
										<span />
										<span />
									</span>
									<span className="chat-answer-status-text">
										{work.frameName ? `Drawing in ${work.frameName}` : 'Drawing on the board'}
									</span>
								</p>
							) : (
								<ChatHistory agent={agent} latestOnly />
							)}
							{/* While the agent works, one bar along the bottom of the card shows how far it has got. */}
							<RequestProgress agent={agent} className="chat-answer-progress" />
						</div>
					)}
					{composer}
				</div>
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
				<span className="chat-wordmark">
					<AgentFace size={22} />
					Easel
				</span>
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
					<p className="chat-empty-hint">Nothing yet. Press M to circle something and ask about it.</p>
				</div>
			) : (
				<ChatHistory agent={agent} />
			)}
			{composer}
		</div>
	)
}

/** What a request did on the board, in a few words: "Drew 16 shapes", or "Changed 3 shapes". */
/**
 * The agent's first message in the newest exchange, if it sent one: its answer
 * to the user. Later messages are usually notes from follow-up passes.
 */
function lastMessage(history: readonly { type: string; promptSource?: string; action?: { _type?: string; text?: unknown } }[], latest = false): string | null {
	let first: string | null = null
	for (let i = history.length - 1; i >= 0; i--) {
		const item = history[i]
		// The agent's own follow-up passes belong to the same exchange.
		if (item.type === 'prompt' && item.promptSource !== 'self') break
		if (item.type === 'action' && item.action?._type === 'message' && typeof item.action.text === 'string' && item.action.text.trim()) {
			first = item.action.text
			if (latest) break
		}
	}
	return first
}

/** The first sentence of a message, as plain text, for a one-line status. */
function firstSentence(text: string | null): string | null {
	if (!text) return null
	const plain = text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
	const match = /^.*?[.!?](?=\s|$)/.exec(plain)
	return (match ? match[0] : plain) || null
}

/** What the answer card says, and the one action it offers, if any. */
interface CardStatus {
	text: string
	/** Background work still running: the line shows the working dots. */
	working?: boolean
	/** A second line, such as the request a failure was about. */
	detail?: string
	action?: { label: string; run: () => void }
}

/** Names for what the agent put on the board, singular and plural. */
const KIND_NAMES: Record<string, [string, string]> = {
	text: ['a note', 'notes'],
	note: ['a sticky note', 'sticky notes'],
	geo: ['a shape', 'shapes'],
	arrow: ['an arrow', 'arrows'],
	line: ['a line', 'lines'],
	draw: ['a sketch', 'sketch strokes'],
	highlight: ['a highlight', 'highlights'],
	frame: ['a frame', 'frames'],
	graph: ['a graph', 'graphs'],
	equation: ['an equation', 'equations'],
	scene: ['a live scene', 'live scenes'],
	simulation: ['a simulation', 'simulations'],
	diagram: ['a diagram', 'diagrams'],
	widget: ['a widget', 'widgets'],
	animation: ['an animation', 'animations'],
	thread: ['an answer beside your mark', 'answers beside your marks'],
}

/**
 * What a request put on the board, as a sentence, for when the agent said
 * nothing itself: "Added an equation, 3 notes, and an arrow." Shapes inside
 * new frames are counted with their frame.
 */
function describeWork(agent: TldrawAgent, work: AgentWork): string | null {
	const { editor } = agent
	const created = new Set(work.createdIds)
	const shapes = work.createdIds.map((id) => editor.getShape(id as TLShapeId)).filter((s): s is TLShape => !!s)
	const top = shapes.filter((shape) => !created.has(shape.parentId))
	const counts = new Map<string, number>()
	for (const shape of top) counts.set(shape.type, (counts.get(shape.type) ?? 0) + 1)
	const parts = [...counts].map(([type, n]) => {
		const [one, many] = KIND_NAMES[type] ?? ['a shape', 'shapes']
		return n === 1 ? one : `${n} ${many}`
	})
	const changed = work.shapeIds.filter((id) => !created.has(id)).length
	if (parts.length === 0) return changed > 0 ? `Changed ${changed === 1 ? 'one shape' : `${changed} shapes`} on the board.` : null
	const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')}${parts.length > 2 ? ',' : ''} and ${parts[parts.length - 1]}`
	return `Added ${list}${changed > 0 ? `, and changed ${changed === 1 ? 'one shape' : `${changed} shapes`}` : ''}.`
}

/** Whether the newest exchange answered in a thread beside a mark. */
function repliedInThread(history: readonly { type: string; promptSource?: string; action?: { _type?: string } }[]): boolean {
	for (let i = history.length - 1; i >= 0; i--) {
		const item = history[i]
		if (item.type === 'prompt' && item.promptSource !== 'self') break
		if (item.type === 'action' && item.action?._type === 'reply_in_thread') return true
	}
	return false
}

/**
 * Where the request's background work stands: a widget being written or an
 * animation being made, then ready, failed, or stopped. Null when the request
 * started none.
 */
function describeJobs(agent: TldrawAgent, work: AgentWork | null): CardStatus | null {
	if (!work) return null
	const { editor } = agent
	const ids = [...new Set([...work.createdIds, ...work.shapeIds])] as TLShapeId[]
	const shapes = ids.map((id) => editor.getShape(id)).filter((s): s is TLShape => !!s && (s.type === 'widget' || s.type === 'animation'))
	if (shapes.length === 0) return null
	const widgets = runningWidgetJobs.get()
	const videos = runningVideoJobs.get()
	const running = shapes.filter((s) => widgets.has(s.id) || videos.has(s.id))
	if (running.length > 0) {
		const animation = running.some((s) => s.type === 'animation')
		const widget = running.some((s) => s.type === 'widget')
		return { text: animation && widget ? 'Making the widget and the animation.' : animation ? 'Making the animation.' : 'Writing the widget.', working: true }
	}
	const lines: string[] = []
	for (const shape of shapes) {
		const props = shape.props as { status?: string; title?: string }
		const name = shape.type === 'widget' ? 'widget' : 'animation'
		const title = props.title?.trim()
		if (props.status === 'ready') lines.push(title ? `"${title}" is ready.` : `The ${name} is ready.`)
		else if (props.status === 'failed') {
			// The animation carries its own Retry, beside its message, so the card points there.
			lines.push(shape.type === 'animation' ? 'The animation could not finish. Retry is on the animation.' : `The ${name} could not finish.`)
		} else if (shape.type === 'animation' && props.status === 'rendering') {
			lines.push('The animation was stopped before it finished. Retry is on the animation.')
		}
	}
	if (lines.length === 0) return null
	return { text: lines.join(' ') }
}

/** Fine-stroke glyphs that match the toolbar: 1.5 px on a 24 px grid. */
function Glyph({ children }: { children: React.ReactNode }) {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
			{children}
		</svg>
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

