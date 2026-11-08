import { TLShapeId, useEditor, useValue } from 'tldraw'
import { useAgent } from '../agent/TldrawAgentAppProvider'

/** How far below a frame's bottom edge its part controls sit, in screen pixels. */
const BELOW = 8

interface PartView {
	id: TLShapeId
	status: 'filling' | 'queued' | 'unfinished' | 'done'
	x: number
	y: number
	hasAgentWork: boolean
}

/**
 * Controls for one part of a map, under its frame's bottom-right corner,
 * outside the frame and clear of its title, so they never cover its content.
 * A part being filled or waiting
 * offers Stop. An unfinished part says so and offers Fill and Redo. A finished
 * part offers Redo while its frame is selected.
 */
export function PartControls() {
	const editor = useEditor()
	const agent = useAgent()
	const parts = useValue(
		'map parts',
		() => {
			const selected = new Set(editor.getSelectedShapeIds())
			const views: PartView[] = []
			for (const shape of editor.getCurrentPageShapes()) {
				if (shape.type !== 'frame') continue
				const status = agent.frames.getPartStatus(shape)
				if (!status) continue
				if (status === 'done' && !selected.has(shape.id)) continue
				const bounds = editor.getShapePageBounds(shape)
				if (!bounds) continue
				const corner = editor.pageToViewport({ x: bounds.maxX, y: bounds.maxY })
				const hasAgentWork = agent.frames.getPartWork(shape.id).length > 0
				views.push({ id: shape.id, status, x: Math.round(corner.x), y: Math.round(corner.y + BELOW), hasAgentWork })
			}
			return views
		},
		[editor, agent]
	)
	const busy = useValue('agent busy', () => agent.requests.isGenerating(), [agent])
	if (parts.length === 0) return null
	const press = (e: React.PointerEvent) => e.stopPropagation()
	return (
		<>
			{parts.map((part) => (
				<div key={part.id} className="part-controls" style={{ left: part.x, top: part.y }} onPointerDown={press}>
					{part.status === 'filling' && <span className="part-controls-state">Filling</span>}
					{part.status === 'queued' && <span className="part-controls-state">Waiting</span>}
					{part.status === 'unfinished' && <span className="part-controls-state part-controls-state--open">Unfinished</span>}
					{(part.status === 'filling' || part.status === 'queued') && (
						<button type="button" onClick={() => agent.frames.stopPart(part.id)}>
							Stop this part
						</button>
					)}
					{part.status === 'unfinished' && (
						<button type="button" disabled={busy} onClick={() => void agent.frames.fillPart(part.id)}>
							Fill this part
						</button>
					)}
					{(part.status === 'done' || (part.status === 'unfinished' && part.hasAgentWork)) && (
						<button type="button" disabled={busy} onClick={() => void agent.frames.fillPart(part.id, { redo: true })}>
							Redo this part
						</button>
					)}
				</div>
			))}
		</>
	)
}
