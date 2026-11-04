import z from 'zod'
import { FocusedColor } from '../format/FocusedColor'
import { FocusedFillSchema } from '../format/FocusedFill'
import { FocusedShapeSchema, FocusedTextAnchorSchema } from '../format/FocusedShape'
import { SimpleShapeIdSchema, TodoIdSchema } from '../types/ids-schema'

/**
 * `_systemPromptCategory` is used for system prompt generation
 * but is stripped from the JSON schema sent to the model.
 *
 * See `SystemPromptCategory.ts` for available values.
 */

// Add Detail Action
export const AddDetailAction = z
	.object({
		_type: z.literal('add-detail'),
		intent: z.string(),
	})
	.meta({
		title: 'Add Detail',
		description: 'The AI plans further work so that it can add detail to its work.',
	})

export type AddDetailAction = z.infer<typeof AddDetailAction>

// Align Action
export const AlignAction = z
	.object({
		_type: z.literal('align'),
		alignment: z.enum(['top', 'bottom', 'left', 'right', 'center-horizontal', 'center-vertical']),
		gap: z.number(),
		intent: z.string(),
		shapeIds: z.array(SimpleShapeIdSchema),
	})
	.meta({
		title: 'Align',
		description: 'The AI aligns shapes to each other on an axis.',
		_systemPromptCategory: 'edit',
	})

export type AlignAction = z.infer<typeof AlignAction>

// Bring to Front Action
export const BringToFrontAction = z
	.object({
		_type: z.literal('bringToFront'),
		intent: z.string(),
		shapeIds: z.array(SimpleShapeIdSchema),
	})
	.meta({
		title: 'Bring to Front',
		description:
			'The AI brings one or more shapes to the front so that they appear in front of everything else.',
		_systemPromptCategory: 'edit',
	})

export type BringToFrontAction = z.infer<typeof BringToFrontAction>

// Clear Action
export const ClearAction = z
	.object({
		_type: z.literal('clear'),
	})
	.meta({
		title: 'Clear',
		description: 'The agent deletes all shapes on the canvas.',
	})

export type ClearAction = z.infer<typeof ClearAction>

// Count Shapes Action
export const CountShapesAction = z
	.object({
		_type: z.literal('count'),
		expression: z.string(),
	})
	.meta({
		title: 'Count',
		description:
			'The AI requests to count the number of shapes in the canvas. The answer will be provided to the AI in a follow-up request.',
	})

export type CountShapesAction = z.infer<typeof CountShapesAction>

// Country Info Action
export const CountryInfoAction = z
	.object({
		_type: z.literal('countryInfo'),
		code: z.string(),
	})
	.meta({
		title: 'Country info',
		description:
			'The AI gets information about a country by providing its country code, eg: "de" for Germany.',
	})

export type CountryInfoAction = z.infer<typeof CountryInfoAction>

// Create Action
export const CreateAction = z
	.object({
		_type: z.literal('create'),
		intent: z.string(),
		shape: FocusedShapeSchema,
	})
	.meta({ title: 'Create', description: 'The AI creates a new shape.' })

export type CreateAction = z.infer<typeof CreateAction>

// Delete Action
export const DeleteAction = z
	.object({
		_type: z.literal('delete'),
		intent: z.string(),
		shapeId: SimpleShapeIdSchema,
	})
	.meta({ title: 'Delete', description: 'The AI deletes a shape.', _systemPromptCategory: 'edit' })

export type DeleteAction = z.infer<typeof DeleteAction>

// Distribute Action
export const DistributeAction = z
	.object({
		_type: z.literal('distribute'),
		direction: z.enum(['horizontal', 'vertical']),
		intent: z.string(),
		shapeIds: z.array(SimpleShapeIdSchema),
	})
	.meta({
		title: 'Distribute',
		description: 'The AI distributes shapes horizontally or vertically.',
		_systemPromptCategory: 'edit',
	})

export type DistributeAction = z.infer<typeof DistributeAction>

// Label Action
export const LabelAction = z
	.object({
		_type: z.literal('label'),
		intent: z.string(),
		shapeId: SimpleShapeIdSchema,
		text: z.string(),
	})
	.meta({
		title: 'Label',
		description: "The AI changes a shape's text.",
		_systemPromptCategory: 'edit',
	})

export type LabelAction = z.infer<typeof LabelAction>

// Map Action
export const MapAction = z
	.object({
		_type: z.literal('map'),
		intent: z.string(),
		frameWidth: z.number(),
		frameHeight: z.number(),
		frames: z.array(
			z.object({
				frameId: SimpleShapeIdSchema,
				title: z.string(),
				description: z.string(),
			})
		),
	})
	.meta({
		title: 'Map',
		description:
			'The AI lays out a row of empty, titled frames for work with several connected parts, each with a one-line description of what it will hold. The app places the row and then asks the AI to fill each frame in order, one follow-up request per frame. Use 2 to 6 frames. Set frameWidth and frameHeight to the size the largest part needs.',
	})

export type MapAction = z.infer<typeof MapAction>

// Message Action
export const MessageAction = z
	.object({
		_type: z.literal('message'),
		text: z.string(),
	})
	.meta({ title: 'Message', description: 'The AI sends a message to the user.' })

export type MessageAction = z.infer<typeof MessageAction>

// Aside Action
export const AsideAction = z
	.object({
		_type: z.literal('aside'),
		topic: z.string(),
	})
	.meta({
		title: 'Aside',
		description:
			'The AI starts a short aside on a side topic, such as a refresher the user asks for while working through the main material. The app keeps any unfinished plan, gives the aside its own space beside the main work, and draws it in a pencil style. Make it the only action of the response: the next request gives you the aside space.',
	})

export type AsideAction = z.infer<typeof AsideAction>

// Reply in thread Action
export const ReplyInThreadAction = z
	.object({
		_type: z.literal('reply_in_thread'),
		thread: z.string(),
		text: z.string(),
	})
	.meta({
		title: 'Reply in thread',
		description:
			'The AI answers a question the user asked by marking the board. The answer goes in the thread beside the mark, a sticky note the user reads in place. Thread: the thread ID from the mark. Text: the answer in one to four plain sentences; a short formula is fine. Draw on the board only when the answer needs a picture, then still reply in the thread and say what you drew. Do not repeat the answer in a chat message.',
	})

export type ReplyInThreadAction = z.infer<typeof ReplyInThreadAction>

// Resume Action
export const ResumeAction = z
	.object({
		_type: z.literal('resume'),
		summary: z.string(),
	})
	.meta({
		title: 'Resume',
		description:
			'The AI ends the current aside and returns to the main work. Use it when the aside is done or the user wants to go back. Summary: one sentence on what the aside settled, to carry back into the main work.',
	})

export type ResumeAction = z.infer<typeof ResumeAction>

// Ask Action
export const AskAction = z
	.object({
		_type: z.literal('ask'),
		question: z.string(),
		choices: z.array(z.string()),
	})
	.meta({
		title: 'Ask',
		description:
			'The AI asks the user one short question with two to four short choices, then stops and waits for the answer. Use it only when the request could reasonably go more than one way and the answer changes the work, for example one full diagram or a step-by-step series. Put it before any board changes and make it the last action of the response.',
	})

export type AskAction = z.infer<typeof AskAction>

// Move Action
export const MoveAction = z
	.object({
		_type: z.literal('move'),
		intent: z.string(),
		anchor: FocusedTextAnchorSchema,
		shapeId: SimpleShapeIdSchema,
		x: z.number(),
		y: z.number(),
	})
	.meta({
		title: 'Move',
		description: 'The agent moves a shape to a new position.',
		_systemPromptCategory: 'edit',
	})

export type MoveAction = z.infer<typeof MoveAction>

// Pen Action
export const PenAction = z
	.object({
		_type: z.literal('pen'),
		shapeId: SimpleShapeIdSchema,
		color: FocusedColor,
		closed: z.boolean(),
		fill: FocusedFillSchema,
		intent: z.string(),
		points: z.array(
			z.object({
				x: z.number(),
				y: z.number(),
			})
		),
		style: z.enum(['smooth', 'straight']),
	})
	.meta({
		title: 'Pen',
		description:
			'The AI draws a freeform line with a pen. This is useful for drawing custom paths that are not available with the other available shapes. The "smooth" style will automatically smooth the line between points. The "straight" style will render a straight line between points. The "closed" property will determine if the drawn line gets automatically closed to form a complete shape or not. Remember that the pen will be *down* until the action is over. If you want to lift up the pen, start a new pen action.',
	})

export type PenAction = z.infer<typeof PenAction>

// Place Action
export const PlaceAction = z
	.object({
		_type: z.literal('place'),
		align: z.enum(['start', 'center', 'end']),
		alignOffset: z.number(),
		intent: z.string(),
		referenceShapeId: SimpleShapeIdSchema,
		side: z.enum(['top', 'bottom', 'left', 'right']),
		sideOffset: z.number(),
		shapeId: SimpleShapeIdSchema,
	})
	.meta({
		title: 'Place',
		description: 'The AI places a shape relative to another shape.',
		_systemPromptCategory: 'edit',
	})

export type PlaceAction = z.infer<typeof PlaceAction>

// Resize Action
export const ResizeAction = z
	.object({
		_type: z.literal('resize'),
		intent: z.string(),
		originX: z.number(),
		originY: z.number(),
		scaleX: z.number(),
		scaleY: z.number(),
		shapeIds: z.array(SimpleShapeIdSchema),
	})
	.meta({
		title: 'Resize',
		description:
			'The AI resizes one or more shapes, with the resize operation being performed relative to an origin point.',
		_systemPromptCategory: 'edit',
	})

export type ResizeAction = z.infer<typeof ResizeAction>

// Review Action
export const ReviewAction = z
	.object({
		_type: z.literal('review'),
		intent: z.string(),
		x: z.number(),
		y: z.number(),
		w: z.number(),
		h: z.number(),
	})
	.meta({
		title: 'Review',
		description:
			'The AI schedules further work or a review so that it can look at the results of its work so far and take further action, such as reviewing what it has done or taking further steps that would benefit from seeing the results of its work so far.',
	})

export type ReviewAction = z.infer<typeof ReviewAction>

// Rotate Action
export const RotateAction = z
	.object({
		_type: z.literal('rotate'),
		centerY: z.number(),
		degrees: z.number(),
		intent: z.string(),
		originX: z.number(),
		originY: z.number(),
		shapeIds: z.array(SimpleShapeIdSchema),
	})
	.meta({
		title: 'Rotate',
		description: 'The AI rotates one or more shapes around an origin point.',
		_systemPromptCategory: 'edit',
	})

export type RotateAction = z.infer<typeof RotateAction>

// Send to Back Action
export const SendToBackAction = z
	.object({
		_type: z.literal('sendToBack'),
		intent: z.string(),
		shapeIds: z.array(SimpleShapeIdSchema),
	})
	.meta({
		title: 'Send to Back',
		description:
			'The AI sends one or more shapes to the back so that they appear behind everything else.',
		_systemPromptCategory: 'edit',
	})

export type SendToBackAction = z.infer<typeof SendToBackAction>

// Set My View Action
export const SetMyViewAction = z
	.object({
		_type: z.literal('setMyView'),
		intent: z.string(),
		x: z.number(),
		y: z.number(),
		w: z.number(),
		h: z.number(),
	})
	.meta({
		title: 'Set My View',
		description:
			'The AI changes the bounds of its own viewport to navigate to other areas of the canvas if needed. `x` and `y` are the top-left corner of the area you want to see, and `w` and `h` are its width and height. To center your view on a point, set `x` and `y` to that point minus half the width and height.',
	})

export type SetMyViewAction = z.infer<typeof SetMyViewAction>

// Stack Action
export const StackAction = z
	.object({
		_type: z.literal('stack'),
		direction: z.enum(['vertical', 'horizontal']),
		gap: z.number(),
		intent: z.string(),
		shapeIds: z.array(SimpleShapeIdSchema),
	})
	.meta({
		title: 'Stack',
		description:
			"The AI stacks shapes horizontally or vertically. Note that this doesn't align shapes, it only stacks them along one axis.",
		_systemPromptCategory: 'edit',
	})

export type StackAction = z.infer<typeof StackAction>

// Think Action
export const ThinkAction = z
	.object({
		_type: z.literal('think'),
		text: z.string(),
	})
	.meta({ title: 'Think', description: 'The AI describes its intent or reasoning.' })

export type ThinkAction = z.infer<typeof ThinkAction>

// Todo List Action
export const UpsertPersonalTodoItemAction = z
	.object({
		_type: z.literal('update-todo-list'),
		id: TodoIdSchema,
		status: z.enum(['todo', 'in-progress', 'done']),
		text: z.string().optional(),
	})
	.meta({
		title: 'Update Todo List',
		description: 'The AI updates a current todo list item or creates a new one',
	})

export type UpsertPersonalTodoItemAction = z.infer<typeof UpsertPersonalTodoItemAction>

// Update Action
export const UpdateAction = z
	.object({
		_type: z.literal('update'),
		intent: z.string(),
		update: FocusedShapeSchema,
	})
	.meta({
		title: 'Update',
		description: 'The AI updates an existing shape.',
		_systemPromptCategory: 'edit',
	})

export type UpdateAction = z.infer<typeof UpdateAction>
// Unknown Action (catch-all for unrecognized actions)
export const UnknownAction = z
	.object({
		_type: z.literal('unknown'),
	})
	.meta({
		title: 'Unknown',
		description: 'An action with an unknown or unrecognized type.',
	})

export type UnknownAction = z.infer<typeof UnknownAction>

// Interactive objects (Phase 6)

// Equation Action
export const EquationAction = z
	.object({
		_type: z.literal('equation'),
		intent: z.string(),
		shapeId: SimpleShapeIdSchema,
		latex: z.string(),
		x: z.number(),
		y: z.number(),
		size: z.number(),
	})
	.meta({
		title: 'Equation',
		description:
			'The AI writes an equation, typeset from LaTeX, as an equation shape the user can edit. Use it for any formula or derivation step instead of a text shape. To change an existing equation, use its shapeId; to add one, use a new shapeId. LaTeX: the math only, with no dollar signs, such as "F = ma" or "\\\\frac{1}{2}mv^2". x and y: the top left corner. Size: the type size in pixels; 24 for body math, 32 for a headline result.',
	})

export type EquationAction = z.infer<typeof EquationAction>

const ParameterSchema = z.object({
	name: z.string(),
	value: z.number(),
	min: z.number(),
	max: z.number(),
	step: z.number(),
})

// Graph Action
export const GraphAction = z
	.object({
		_type: z.literal('graph'),
		intent: z.string(),
		shapeId: SimpleShapeIdSchema,
		x: z.number(),
		y: z.number(),
		width: z.number(),
		height: z.number(),
		functions: z.array(z.string()),
		parameters: z.array(ParameterSchema),
		xMin: z.number(),
		xMax: z.number(),
		yMin: z.number(),
		yMax: z.number(),
	})
	.meta({
		title: 'Graph',
		description:
			'The AI draws a live graph of functions of x, which the user can explore with sliders. Use it whenever a relationship between quantities should be seen, instead of drawing a curve with the pen. Functions: y as an expression of x and the parameters, such as "a*sin(b*x)" or "x^2 - c"; allowed are + - * / ^, parentheses, pi, e, and sin cos tan exp ln log sqrt abs. Parameters: each named number in the functions, with its starting value, its range, and its slider step; the user drags them, and the board shows their current values. To change an existing graph, use its shapeId. Width and height: the plot area in pixels; the sliders are added below it.',
	})

export type GraphAction = z.infer<typeof GraphAction>

// Simulation Action
export const SimulationAction = z
	.object({
		_type: z.literal('simulation'),
		intent: z.string(),
		shapeId: SimpleShapeIdSchema,
		x: z.number(),
		y: z.number(),
		kind: z.enum(['projectile']),
		speed: z.number(),
		angle: z.number(),
		gravity: z.number(),
		height: z.number(),
	})
	.meta({
		title: 'Simulation',
		description:
			'The AI places a deterministic simulation the user can play, pause, scrub, and change with sliders. Kind "projectile": a launched ball under gravity, with its speed in m/s, launch angle in degrees, gravity in m/s², and launch height in m. Use it when motion should be seen, not described. To change an existing simulation, use its shapeId.',
	})

export type SimulationAction = z.infer<typeof SimulationAction>

// Set Parameter Action
export const SetParameterAction = z
	.object({
		_type: z.literal('set_parameter'),
		intent: z.string(),
		shapeId: SimpleShapeIdSchema,
		name: z.string(),
		value: z.number(),
	})
	.meta({
		title: 'Set Parameter',
		description:
			"The AI sets one parameter of a graph or a simulation, the same way the user moves its slider, and the plot updates for both. Use it to show what a change does, such as doubling the speed. The board shows each shape's current parameter values; read them before changing one, because the user may have moved it.",
	})

export type SetParameterAction = z.infer<typeof SetParameterAction>

// Diagram Action
export const DiagramAction = z
	.object({
		_type: z.literal('diagram'),
		intent: z.string(),
		diagramId: z.string(),
		x: z.number(),
		y: z.number(),
		layout: z.enum(['flow', 'map']),
		nodes: z.array(z.object({ id: z.string(), label: z.string() })),
		edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
	})
	.meta({
		title: 'Diagram',
		description:
			'The AI draws a diagram from nodes and edges, and the app lays it out cleanly as ordinary boxes and bound arrows the user can move and edit. Use it for any flow, process, hierarchy, or concept map instead of placing boxes and arrows one by one. Layout "flow": top to bottom in steps, for processes and causes. Layout "map": spread out by links, for concept maps. Node labels: a few words. Edge labels: a few words, or "" for none. x and y: the top left corner. To redraw a diagram, send the same diagramId; nodes the user moved stay where they put them.',
	})

export type DiagramAction = z.infer<typeof DiagramAction>
