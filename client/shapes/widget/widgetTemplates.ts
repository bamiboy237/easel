import vectorProjectionCss from './templates/vector-projection.css?raw'
import vectorProjectionHtml from './templates/vector-projection.html?raw'
import vectorProjectionJs from './templates/vector-projection.js?raw'

/**
 * Hand-written widgets for topics that recur, like the scene templates. The
 * agent places one with `widget_template` instead of having a widget written:
 * it lands at once, it is built from the paper kit, and every number in it was
 * checked by hand. Each one lists the session it was verified on.
 */
export interface WidgetTemplate {
	id: string
	title: string
	/** When to reach for it, in one line the agent reads. */
	useFor: string
	/** What it shows, as the widget's brief, so the agent can describe it. */
	brief: string
	/** Where it was checked by hand, so a wrong template does not spread. */
	verified: string
	/** The widget area, in pixels. */
	width: number
	height: number
	/** Its declared state, with starting values. */
	state: Record<string, string | number | boolean>
	html: string
	css: string
	js: string
}

export const BUILT_IN_WIDGET_TEMPLATES: WidgetTemplate[] = [
	{
		id: 'vector-projection',
		title: 'Vector norms and projections',
		useFor:
			'vector norms (lengths), the dot product, the angle between vectors, and the scalar and vector projection of one vector onto another, in 2D',
		brief:
			'Two draggable vectors a and b from the origin on a fixed grid. It shows ‖a‖, ‖b‖, a·b, the angle θ between them, the scalar projection comp_b a and the vector projection proj_b a with exact working, and draws the angle, the line of b, the line where a·b = 0, the projection of a onto b, and the right angle at its foot. Presets: Reset, Parallel, Perpendicular, Obtuse, Opposite.',
		verified: 'vector norms and projections ask, 2026-11-08',
		width: 1000,
		height: 720,
		state: { ax: 2, ay: 3, bx: 4, by: 1 },
		html: vectorProjectionHtml,
		css: vectorProjectionCss,
		js: vectorProjectionJs,
	},
]

export function getWidgetTemplate(id: string): WidgetTemplate | undefined {
	return BUILT_IN_WIDGET_TEMPLATES.find((t) => t.id === id)
}
