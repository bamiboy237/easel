import { TLDefaultColorStyle, TLShape } from 'tldraw'
import { getBoardSettings, updateBoardSettings } from '../boardSettings'
import { BaseAgentManager } from './BaseAgentManager'
import { getShapeCreator } from './BoardCommandManager'
import type { TldrawAgent } from '../TldrawAgent'

/** The agent's ink: the colors it chose itself, or one color for all its shapes. */
export type AgentInk = 'same' | TLDefaultColorStyle

/** The inks offered in the board menu. Graphite is tldraw's grey. Red is kept for marks. */
export const AGENT_INKS: { ink: AgentInk; label: string }[] = [
	{ ink: 'same', label: 'Same as mine' },
	{ ink: 'grey', label: 'Graphite' },
	{ ink: 'blue', label: 'Blue' },
	{ ink: 'violet', label: 'Violet' },
	{ ink: 'green', label: 'Green' },
	{ ink: 'orange', label: 'Orange' },
]

/**
 * Draws the agent's shapes in the ink the user picked for this board, so the
 * user can tell at a glance who drew what. Each agent shape keeps the color the
 * agent gave it in `meta.agentColor`, so choosing "Same as mine" restores it.
 */
export class AgentInkManager extends BaseAgentManager {
	constructor(agent: TldrawAgent) {
		super(agent)
		const { editor } = agent
		// A shape the agent creates takes the board's agent ink.
		this.disposables.add(
			editor.store.sideEffects.registerBeforeCreateHandler('shape', (shape, source) => {
				if (source !== 'user' || !this.isAgentShape(shape) || !hasColor(shape) || 'agentColor' in shape.meta) return shape
				const ink = this.getInk()
				if (ink === 'same') return shape
				return withInk(shape, shape.props.color, ink)
			})
		)
		// When the agent recolors one of its shapes, the new color is what it chose,
		// and the ink still shows.
		this.disposables.add(
			editor.store.sideEffects.registerBeforeChangeHandler('shape', (prev, next, source) => {
				if (source !== 'user' || !this.agent.getIsActingOnEditor() || !this.isAgentShape(next)) return next
				if (!hasColor(next) || !hasColor(prev) || next.props.color === prev.props.color) return next
				const ink = this.getInk()
				if (ink === 'same') return next
				return withInk(next, next.props.color, ink)
			})
		)
	}

	reset(): void {}

	getInk(): AgentInk {
		return getBoardSettings(this.agent.editor).agentInk
	}

	/**
	 * Change the agent's ink for this board, and redraw its existing shapes in it,
	 * as one user command. A shape the user recolored by hand keeps their color.
	 */
	setInk(ink: AgentInk) {
		const { editor } = this.agent
		const previous = this.getInk()
		// Its own undo step, separate from the user's last edit.
		editor.markHistoryStoppingPoint('agent-ink')
		this.agent.commands.execute('user', 'agent-ink', () => {
			updateBoardSettings(editor, { agentInk: ink })
			const updates = []
			for (const shape of editor.getCurrentPageShapes()) {
				if (!this.isAgentShape(shape) || !hasColor(shape)) continue
				const original = (shape.meta.agentColor as TLDefaultColorStyle | undefined) ?? shape.props.color
				const shown = previous === 'same' ? original : previous
				if (shape.props.color !== shown) continue
				updates.push(withInk(shape, original, ink === 'same' ? original : ink))
			}
			editor.updateShapes(updates)
		})
	}

	private isAgentShape(shape: TLShape) {
		return getShapeCreator(shape) === 'agent' || (!getShapeCreator(shape) && this.agent.getIsActingOnEditor())
	}
}

function hasColor(shape: TLShape): shape is TLShape & { props: { color: TLDefaultColorStyle } } {
	return typeof (shape.props as { color?: unknown }).color === 'string'
}

/** The shape in an ink, remembering the agent's own color. */
function withInk<T extends TLShape>(shape: T, agentColor: TLDefaultColorStyle, ink: TLDefaultColorStyle): T {
	return { ...shape, meta: { ...shape.meta, agentColor }, props: { ...shape.props, color: ink } }
}
