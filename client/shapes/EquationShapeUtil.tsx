import katex from 'katex'
import 'katex/dist/katex.min.css'
import { useMemo } from 'react'
import {
	Geometry2d,
	HTMLContainer,
	Rectangle2d,
	RecordProps,
	ShapeUtil,
	T,
	TLShape,
	useEditor,
	useValue,
} from 'tldraw'

export const EQUATION_TYPE = 'equation'

export interface EquationShapeProps {
	w: number
	h: number
	/** The equation's LaTeX source. */
	latex: string
	/** The type size in pixels at 100% zoom. */
	size: number
}

declare module 'tldraw' {
	export interface TLGlobalShapePropsMap {
		[EQUATION_TYPE]: EquationShapeProps
	}
}

export type EquationShape = TLShape<typeof EQUATION_TYPE>

/** Space around the typeset equation, so its selection box does not touch the glyphs. */
const PAD = 8
export const DEFAULT_EQUATION_SIZE = 24

/** The equation typeset with KaTeX, or null with the reason when the LaTeX does not parse. */
export function renderEquation(latex: string): { html: string; error: null } | { html: null; error: string } {
	try {
		return { html: katex.renderToString(latex, { displayMode: true, throwOnError: true, output: 'html' }), error: null }
	} catch (error) {
		return { html: null, error: error instanceof Error ? error.message : String(error) }
	}
}

/**
 * How big an equation is once typeset, measured in the page by rendering it
 * off screen. Size changes are made in the same command as the LaTeX, so the
 * shape is never resized behind the command model's back.
 */
export function measureEquation(latex: string, size: number): { w: number; h: number } {
	if (typeof document === 'undefined') return { w: 200, h: size * 2 }
	const probe = document.createElement('div')
	probe.className = 'equation-body'
	probe.style.cssText = `position:absolute;visibility:hidden;left:-10000px;top:0;font-size:${size}px;white-space:nowrap;`
	const rendered = renderEquation(latex)
	if (rendered.html) probe.innerHTML = rendered.html
	else probe.textContent = latex || ' '
	document.body.appendChild(probe)
	const rect = probe.getBoundingClientRect()
	probe.remove()
	return { w: Math.ceil(rect.width) + PAD * 2, h: Math.ceil(rect.height) + PAD * 2 }
}

/**
 * An equation on the board, typeset with KaTeX in the board's ink. Double
 * click to edit its LaTeX in place; the source shows while editing. LaTeX
 * that does not parse shows as source in red pencil, never as a blank shape.
 */
export class EquationShapeUtil extends ShapeUtil<EquationShape> {
	static override type = EQUATION_TYPE
	static override props: RecordProps<EquationShape> = {
		w: T.number,
		h: T.number,
		latex: T.string,
		size: T.number,
	}

	override getDefaultProps(): EquationShapeProps {
		return { w: 160, h: 56, latex: 'E = mc^2', size: DEFAULT_EQUATION_SIZE }
	}

	override canEdit() {
		return true
	}

	override canResize() {
		return false
	}

	/** The line the agent reads about this shape, wherever it sees the shape. */
	override getText(shape: EquationShape) {
		return `Equation: ${shape.props.latex}`
	}

	override getGeometry(shape: EquationShape): Geometry2d {
		return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
	}

	override component(shape: EquationShape) {
		return <Equation shape={shape} />
	}

	override getIndicatorPath(shape: EquationShape) {
		const path = new Path2D()
		path.roundRect(0, 0, shape.props.w, shape.props.h, 4)
		return path
	}
}

function Equation({ shape }: { shape: EquationShape }) {
	const editor = useEditor()
	const editing = useValue('equation editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
	const { latex, size } = shape.props
	const rendered = useMemo(() => renderEquation(latex), [latex])

	return (
		<HTMLContainer className="equation-container">
			<div className="equation-body" style={{ fontSize: size, padding: PAD }}>
				{rendered.html ? (
					<div dangerouslySetInnerHTML={{ __html: rendered.html }} />
				) : (
					<code className="equation-error" title={rendered.error ?? undefined}>
						{latex || 'Empty equation'}
					</code>
				)}
			</div>
			{editing && (
				<textarea
					className="equation-source"
					autoFocus
					spellCheck={false}
					defaultValue={latex}
					aria-label="Equation, in LaTeX"
					onPointerDown={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						e.stopPropagation()
						if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
							e.preventDefault()
							editor.setEditingShape(null)
						}
					}}
					onChange={(e) => {
						const next = e.currentTarget.value
						editor.updateShape<EquationShape>({
							id: shape.id,
							type: EQUATION_TYPE,
							props: { latex: next, ...measureEquation(next, size) },
						})
					}}
				/>
			)}
		</HTMLContainer>
	)
}
