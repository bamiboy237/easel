import { useEffect, useState } from 'react'
import {
	DefaultColorStyle,
	DefaultStylePanel,
	getColorStyleItems,
	StylePanelArrowheadPicker,
	StylePanelArrowKindPicker,
	StylePanelButtonPicker,
	StylePanelDashPicker,
	StylePanelFillPicker,
	StylePanelFontPicker,
	StylePanelGeoShapePicker,
	StylePanelLabelAlignPicker,
	StylePanelSection,
	StylePanelSizePicker,
	StylePanelSplinePicker,
	StylePanelTextAlignPicker,
	TLUiStylePanelProps,
	useEditor,
	useStylePanelContext,
	useValue,
} from 'tldraw'

const TOOLS_WITHOUT_STYLES = new Set(['select', 'hand', 'laser', 'zoom', 'mark'])

/**
 * The board's inks, in the order the panel shows them: the ink, a quiet grey,
 * and the three colors that carry meaning in the agent's work. The other tldraw
 * colors (violets, light blues, orange, yellow) are not part of the paper look.
 */
const PAPER_COLORS = ['black', 'grey', 'blue', 'red', 'green']

/**
 * Styles only when the user asks for them. With a selection or a drawing tool,
 * a small "Style" button sits in the corner; it opens a panel in the paper
 * inks, without the opacity slider. The panel closes again when the selection
 * and the drawing tool go.
 */
export function ContextualStylePanel(props: TLUiStylePanelProps) {
	const editor = useEditor()
	const [open, setOpen] = useState(false)
	const hasSubject = useValue(
		'style panel subject',
		// A selection of shapes with nothing to style, such as a graph, offers no Style button.
		() =>
			(editor.getSelectedShapeIds().length > 0 && editor.getSharedStyles().size > 0) ||
			!TOOLS_WITHOUT_STYLES.has(editor.getCurrentToolId()),
		[editor]
	)
	useEffect(() => {
		if (!hasSubject) setOpen(false)
	}, [hasSubject])
	if (!hasSubject) return null
	if (!open) {
		return (
			<button
				type="button"
				className="paper-style-toggle"
				title="Change the color, line, and text style"
				onPointerDown={(e) => e.stopPropagation()}
				onClick={() => setOpen(true)}
			>
				Style
			</button>
		)
	}
	return (
		<div className="paper-style-panel">
			<DefaultStylePanel {...props}>
				<StylePanelSection>
					<PaperColorPicker />
				</StylePanelSection>
				<StylePanelSection>
					<StylePanelFillPicker />
					<StylePanelDashPicker />
					<StylePanelSizePicker />
				</StylePanelSection>
				<StylePanelSection>
					<StylePanelFontPicker />
					<StylePanelTextAlignPicker />
					<StylePanelLabelAlignPicker />
				</StylePanelSection>
				<StylePanelSection>
					<StylePanelGeoShapePicker />
					<StylePanelArrowKindPicker />
					<StylePanelArrowheadPicker />
					<StylePanelSplinePicker />
				</StylePanelSection>
			</DefaultStylePanel>
			<button type="button" className="paper-style-close" onClick={() => setOpen(false)}>
				Done
			</button>
		</div>
	)
}

/** The color row, in the paper inks only. */
function PaperColorPicker() {
	const editor = useEditor()
	const { styles } = useStylePanelContext()
	const color = styles.get(DefaultColorStyle)
	const items = useValue(
		'paper color items',
		() => {
			const all = getColorStyleItems(editor.getCurrentTheme().colors[editor.getColorMode()])
			return PAPER_COLORS.map((name) => all.find((item) => item.value === name)).filter((item) => !!item)
		},
		[editor]
	)
	if (color === undefined) return null
	return <StylePanelButtonPicker title="Color" uiType="color" style={DefaultColorStyle} items={items} value={color} />
}
