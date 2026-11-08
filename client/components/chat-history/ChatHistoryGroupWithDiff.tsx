import { useCallback, useMemo, useState } from 'react'
import { squashRecordDiffs, TLShape, TLShapeId, useValue } from 'tldraw'
import { AgentIcon, AgentIconType } from '../../../shared/icons/AgentIcon'
import { ChatHistoryActionItem } from '../../../shared/types/ChatHistoryItem'
import { useAgent } from '../../agent/TldrawAgentAppProvider'
import { ChatHistoryGroup } from './ChatHistoryGroup'
import { getActionInfo } from './getActionInfo'
import { TldrawDiffViewer } from './TldrawDiffViewer'

export function ChatHistoryGroupWithDiff({ group }: { group: ChatHistoryGroup }) {
	const agent = useAgent()
	const { items } = group
	const diff = useMemo(() => squashRecordDiffs(items.map((item) => item.diff)), [items])

	// Undo and Restore go through the command log, so they keep newer human work.
	const markItems = useCallback(
		(change: (item: ChatHistoryActionItem) => ChatHistoryActionItem) => {
			agent.chat.update((currentChatHistoryItems) =>
				currentChatHistoryItems.map((historyItem) =>
					historyItem.type === 'action' && items.includes(historyItem) ? change(historyItem) : historyItem
				)
			)
		},
		[items, agent.chat]
	)

	// Revert every pass in this group.
	const handleReject = useCallback(() => {
		const passIds = [...new Set(items.map((item) => item.passId).filter((id) => id !== undefined))]
		const commandIds = passIds.flatMap((passId) => agent.commands.getAgentCommandIds({ passId }))
		const { commandId, kept } = agent.actions.showChange(() => agent.commands.revert(commandIds))
		if (!commandId) return
		markItems((item) => ({
			...item,
			acceptance: 'rejected',
			revertCommandId: commandId,
			keptRecordIds: kept.map((record) => record.id),
		}))
	}, [items, agent.commands, agent.actions, markItems])

	// Restore what the last revert undid.
	const handleAccept = useCallback(() => {
		const revertCommandId = items.find((item) => item.revertCommandId)?.revertCommandId
		if (!revertCommandId) return
		const { kept } = agent.actions.showChange(() => agent.commands.revert([revertCommandId], 'restore'))
		markItems((item) => ({
			...item,
			acceptance: 'accepted',
			revertCommandId: undefined,
			keptRecordIds: kept.map((record) => record.id),
		}))
	}, [items, agent.commands, agent.actions, markItems])

	const keptIds = useMemo(() => [...new Set(items.flatMap((item) => item.keptRecordIds ?? []))], [items])
	const keptCount = keptIds.length
	// The kept shapes the agent made, still on the board, by name, so the note
	// can say what stayed and offer to remove it too.
	const keptShapes = useValue(
		'kept agent shapes',
		() =>
			keptIds
				.filter((id) => id.startsWith('shape:'))
				.map((id) => agent.editor.getShape(id as TLShapeId))
				.filter((shape): shape is TLShape => !!shape && shape.meta.createdBy !== 'user'),
		[agent, keptIds]
	)
	const removeKept = useCallback(() => {
		const ids = keptShapes.map((shape) => shape.id)
		if (ids.length === 0) return
		agent.editor.markHistoryStoppingPoint('remove kept')
		agent.actions.showChange(() => agent.commands.execute('user', 'remove-kept', () => agent.editor.deleteShapes(ids)))
	}, [agent, keptShapes])

	// Get the acceptance status of the group
	// If all items are accepted, the group is accepted
	// If all items are rejected, the group is rejected
	// Otherwise, the group is pending
	const acceptance = useMemo<ChatHistoryActionItem['acceptance']>(() => {
		if (items.length === 0) return 'pending'
		const acceptance = items[0].acceptance
		for (let i = 1; i < items.length; i++) {
			if (items[i].acceptance !== acceptance) {
				return 'pending'
			}
		}
		return acceptance
	}, [items])

	const steps = useMemo(
		() => items.map((item) => getActionInfo(item.action, agent)),
		[items, agent]
	)

	const [isOpen, setIsOpen] = useState(false)
	const descriptions = useMemo(() => getDistinctDescriptions(steps), [steps])
	const summary = `${descriptions.length} ${descriptions.length === 1 ? 'change' : 'changes'}`

	return (
		<div className={`chat-history-change ${isOpen ? 'chat-history-change--open' : ''}`}>
			<div className="chat-history-change-header">
				<button
					className="chat-history-change-toggle"
					onClick={() => setIsOpen((open) => !open)}
					aria-expanded={isOpen}
				>
					<span className="chat-history-change-chevron" aria-hidden>
						›
					</span>
					<span className="chat-history-change-summary">{summary}</span>
					{!isOpen && descriptions.length > 0 && (
						<span className="chat-history-change-latest">{descriptions.at(-1)}</span>
					)}
				</button>
				<div className="chat-history-change-acceptance">
					{acceptance === 'rejected' ? (
						<button onClick={handleAccept}>Restore</button>
					) : (
						<button onClick={handleReject}>Undo</button>
					)}
				</div>
			</div>
			{keptCount > 0 && (
				<div className="chat-history-change-kept">
					{acceptance === 'rejected' && keptShapes.length > 0 ? (
						<>
							{`Kept ${listNames(keptShapes.map((shape) => nameOf(agent, shape)))}, because you changed ${keptShapes.length === 1 ? 'it' : 'them'} after the agent made ${keptShapes.length === 1 ? 'it' : 'them'}. Your changes are still there. `}
							<button className="chat-history-change-kept-remove" onClick={removeKept}>
								Remove {keptShapes.length === 1 ? 'it' : 'them'} too
							</button>
						</>
					) : acceptance === 'rejected' ? (
						`Kept ${keptCount === 1 ? 'one shape' : `${keptCount} shapes`} you changed after the agent.`
					) : (
						`Left ${keptCount === 1 ? 'one shape' : `${keptCount} shapes`} as you changed them.`
					)}
				</div>
			)}
			{isOpen && (
				<>
					<DiffSteps steps={steps} />
					<TldrawDiffViewer diff={diff} />
				</>
			)}
		</div>
	)
}

function getDistinctDescriptions(steps: DiffStep[]) {
	const descriptions: string[] = []
	for (const step of steps) {
		if (step.description && step.description !== descriptions.at(-1)) {
			descriptions.push(step.description)
		}
	}
	return descriptions
}

interface DiffStep {
	icon: AgentIconType | null
	description: string | null
}

function DiffSteps({ steps }: { steps: DiffStep[] }) {
	let previousDescription = ''
	return (
		<div className="agent-changes">
			{steps.map((step, i) => {
				if (!step.description) return null

				if (step.description === previousDescription) return null
				previousDescription = step.description
				return (
					<div className="agent-change" key={'intent-' + i}>
						{step.icon && (
							<span className="agent-change-icon">
								<AgentIcon type={step.icon} />
							</span>
						)}
						{step.description}
					</div>
				)
			})}
		</div>
	)
}

/** A short name for a shape in a sentence: its title, the start of its text, or its kind. */
function nameOf(agent: ReturnType<typeof useAgent>, shape: TLShape): string {
	const title = (shape.props as { title?: unknown }).title
	if (typeof title === 'string' && title.trim()) return `"${title.trim()}"`
	const text = agent.commands.getShapeText(shape).replace(/\s+/g, ' ').trim()
	if (text) return `"${text.length > 30 ? text.slice(0, 28) + '...' : text}"`
	const kinds: Record<string, string> = { scene: 'the scene', graph: 'the graph', widget: 'the widget', animation: 'the animation', equation: 'the equation', simulation: 'the simulation' }
	return kinds[shape.type] ?? 'a shape'
}

function listNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? ''
	if (names.length > 3) return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
