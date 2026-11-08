import z from 'zod'
import { FocusedColor } from '../format/FocusedColor'
import { FocusedFillSchema } from '../format/FocusedFill'
import { FocusedShapeSchema, FocusedTextAnchorSchema } from '../format/FocusedShape'
import { TOOL_GROUP_IDS } from '../toolGroups'
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
			'The AI asks the user one short question with two to four short choices, then stops and waits for the answer. Use it only when the request could reasonably go more than one way and the answer changes the work, for example one full diagram or a step-by-step series, or when the request is too vague to start, such as "Help me study". Ask with this action, not in a message: the user sees the choices as buttons and can also type their own answer. Put it before any board changes and make it the last action of the response.',
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

// Load Tools Action
export const LoadToolsAction = z
	.object({
		_type: z.literal('load_tools'),
		intent: z.string(),
		groups: z.array(z.enum(TOOL_GROUP_IDS as [string, ...string[]])),
	})
	.meta({
		title: 'Load Tools',
		description:
			'The AI loads tool groups it needs before using them, such as the pen and its drawing guide. They load from the next pass on and stay for the rest of the conversation. intent is the task to continue once they load. Only load a group that is listed as not loaded.',
	})

export type LoadToolsAction = z.infer<typeof LoadToolsAction>

// Claim User Shapes Action
export const ClaimUserShapesAction = z
	.object({
		_type: z.literal('claim_user_shapes'),
		shapeIds: z.array(z.string()),
		quote: z.string(),
	})
	.meta({
		title: 'Claim User Shapes',
		description:
			"Shapes the user made are protected: a change to them is rejected unless the user selected them or asked for it. When the user's message asks you to change, move, delete, or connect to existing shapes they describe (such as \"delete both sticky notes\" or \"an arrow from the ramp to the cart\"), send this action first with the IDs of exactly those shapes, and quote the user's words that ask for it, copied exactly from their message. Then make the change in the same response. Claim only the shapes the user's words name. Shapes the user selected need no claim.",
	})

export type ClaimUserShapesAction = z.infer<typeof ClaimUserShapesAction>

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
	/** The slider's unit, printed after its value: "m/s", "N", "kg", "°". Omit for pure numbers. */
	unit: z.string().optional(),
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
		labels: z.array(z.string()).optional(),
		xLabel: z.string().optional(),
		yLabel: z.string().optional(),
		parameters: z.array(ParameterSchema),
		xMin: z.number(),
		xMax: z.number(),
		yMin: z.number(),
		yMax: z.number(),
		points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string() })).optional(),
	})
	.meta({
		title: 'Graph',
		description:
			'The AI draws a live graph of functions of x, which the user can explore with sliders. Use it whenever a relationship between quantities should be seen, instead of drawing a curve with the pen. Functions: y as an expression of x and the parameters, such as "a*sin(b*x)" or "x^2 - c"; allowed are + - * / ^, parentheses, pi, e, and sin cos tan exp ln log sqrt abs. Labels: a short name for each function, in the same order, written at the end of its curve in its color, such as "demand", "height h", or "y = eˣ"; "" for none. With two or more curves, name every one. xLabel and yLabel: what each axis measures, with its unit, such as "t (s)" and "h (m)", or "x" and "y" for pure math. Pick ranges that show the interesting part, such as one or two periods of a wave, with the curves filling most of the plot. Parameters: each named number in the functions, with its starting value, its range, its slider step, and its unit when it has one (unit, such as "m/s²", "N", or "°"), so the slider reads "a 2 m/s²"; the user drags them, and the board shows their current values. To change an existing graph, use its shapeId. Width and height: the plot area in pixels, 520 by 340 or more for the main graph of a request; the sliders are added below it. points: the key points a teacher would mark, such as the top of a throw, where a velocity crosses zero, an equilibrium, or where two curves meet, each with its exact x and y and a short label such as "top: 2.04 s, 20.4 m"; each is drawn as a dot in its curve\'s ink with dashed guides to both axes. When two graphs show the same moment, mark it on both. Curve inks: a graph of several curves draws them in black, red, blue, then green; a graph of one curve gets its own ink, in the order such graphs land on the board: blue, then red, then green, so two graphs of one situation, such as height and velocity, read apart. Color each graph\'s equation and labels with its curve\'s ink: text in that color, and an equation wrapped in \\\\color{#2F5D8C}{...} for blue, #AE3B2C for red, or #344C41 for green.',
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

// Scene Action
/** An expression: text, or a plain number. */
const SceneExprSchema = z.union([z.string(), z.number()])
/** A position: a point's id, or an [x, y] pair of expressions. */
const SceneRefSchema = z.union([z.string(), z.array(SceneExprSchema)])
/** A segment's or line's end is a position; a curve's from and to are the range of s, often plain numbers. */
const SceneEndSchema = z.union([z.string(), z.number(), z.array(SceneExprSchema)])

const SceneObjectSchema = z.object({
	id: z.string(),
	type: z.enum(['let', 'point', 'segment', 'line', 'vector', 'circle', 'polygon', 'plot', 'curve', 'trace', 'label', 'readout', 'check', 'state', 'event']),
	expr: SceneExprSchema.optional(),
	x: SceneExprSchema.optional(),
	y: SceneExprSchema.optional(),
	drag: z.boolean().optional(),
	label: z.string().optional(),
	from: SceneEndSchema.optional(),
	to: SceneEndSchema.optional(),
	dx: SceneExprSchema.optional(),
	dy: SceneExprSchema.optional(),
	center: SceneRefSchema.optional(),
	r: SceneExprSchema.optional(),
	fill: z.boolean().optional(),
	points: z.array(SceneRefSchema).optional(),
	of: z.string().optional(),
	at: SceneRefSchema.optional(),
	text: z.string().optional(),
	visible: SceneExprSchema.optional(),
	ink: z.number().optional(),
	init: SceneExprSchema.optional(),
	rate: SceneExprSchema.optional(),
	when: SceneExprSchema.optional(),
	set: z.array(z.object({ name: z.string(), value: SceneExprSchema })).optional(),
	stop: z.boolean().optional(),
})

export const SceneAction = z
	.object({
		_type: z.literal('scene'),
		intent: z.string(),
		shapeId: SimpleShapeIdSchema,
		title: z.string(),
		x: z.number(),
		y: z.number(),
		width: z.number(),
		height: z.number(),
		xMin: z.number(),
		xMax: z.number(),
		yMin: z.number(),
		yMax: z.number(),
		duration: z.number(),
		axes: z.boolean(),
		params: z.array(ParameterSchema),
		objects: z.array(SceneObjectSchema),
		remove: z.array(z.string()).optional(),
		pinTime: z.number().optional(),
	})
	.meta({
		title: 'Scene',
		description: [
			'The AI builds a live scene: a visual made of geometry, formulas, and motion that the user explores with sliders, draggable points, and a play button. Use it for anything a graph or the projectile simulation does not cover: forces on an object, a pendulum, a wave, an orbit, a lever, vectors, geometry. Never draw these with the pen.',
			'Coordinates are math coordinates, y up, in the units of the topic, framed by xMin to xMax and yMin to yMax; both axes keep the same scale. Width and height are the plot in pixels for a new scene: 520 by 360 or more when the scene is the main visual, so its labels read beside the text around it; an existing scene keeps the size the user gave it, and sliders and the play row are added below. duration: how long time t runs in seconds when the user presses play, or 0 for no clock. axes: true to draw the grid and numbered axes, false for diagrams where coordinates mean nothing, such as forces on a box. With axes, frame the range so the numbers a reader needs, such as the distance to a hoop, fall on the axes, and name each axis at its far end with a label object giving the quantity and unit, such as "distance (m)". title: a few words.',
			'params: the named numbers the user can change, each with value, min, max, step. Expressions use params, lets, t, numbers, + - * / ^, comparisons joined with and, or, not, and functions: sin cos tan asin acos atan atan2(y,x) sqrt abs exp ln log min max mod hypot pow clamp(v,lo,hi) floor ceil round sign, deg(d) to turn degrees into radians, and if(test, a, b). Constants: pi, e. Inside a plot, x is the input; inside a curve, s is.',
			'objects, each with a unique id, drawn in the board inks (ink 0 charcoal, 1 red, 2 blue, 3 green): let {expr} a named value other objects can use by its id (lets can use each other in any order, but not in a loop); point {x, y, label}; segment and line {from, to}; vector {from, dx, dy, label}; circle {center, r, fill}; polygon {points}; plot {y} a function of x; curve {x, y, from, to} a curve in s from s = from to s = to; trace {of} the path a point has followed since t = 0, which needs a duration; label {at, text}; readout {text} a computed line shown in the corner, at most three short ones; check {expr, text} a statement that must hold for every slider value and time, such as "abs(R - v0^2*sin(2*deg(theta))/g) < 0.01", never drawn: the board tests it across the range of each slider and tells you when it fails. A position (from, to, center, at, and each of points) is a point id, or an ["x expression", "y expression"] pair. Text can embed values in braces, such as "range = {R} m", and a state in words with {test ? words : other words}, such as "{abs(dh) < 0.12 ? In : Miss}: {round(100*abs(dh))} cm {dh > 0 ? above : below} rim height at the hoop": a yes, a no, or any state is always words, never a 1 or a 0 the reader must decode. visible: an expression; the object shows when it is not 0.',
			'Motion with no simple formula in t, such as a pendulum beyond small angles, an orbit, damping, a bounce, or anything you would otherwise approximate with a series or repeated lets: always use state, never a series, an iteration, or a solved closed form. state {init, rate} is a variable named by its id that starts at init and changes at rate per second, stepped forward in time; rates can use params, states, lets, and t, and lets can use states. event {when, set, stop}: when its condition turns true, set gives states new values (a list of {name, value}), and stop: true stops the clock, such as a ball landing. A pendulum: state theta {init: "deg(th0)", rate: "omega"}, state omega {init: "0", rate: "-(g/L)*sin(theta)"}. A bounce: event {when: "y < 0", set: [{name: "vy", value: "-0.8*vy"}, {name: "y", value: "0"}]}. pinTime: a time in seconds to stop every viewer on, for the moment you are explaining; leave it out otherwise.',
			'A draggable point: set drag to true and x, y, or both to a param name; dragging moves those params, and a point with only x as a param slides sideways. A handle is red unless it has an ink. Ids are names: letters, digits, and _, starting with a letter, and not a param, t, pi, e, if, and, or, or not. Inside a plot, x is the input, and inside a curve, s is, even if an object has that id.',
			'Put the physics in lets and readouts, so every number shown is computed, and add a check or two for the facts the scene must get right: for a projectile, let vx = "v0*cos(deg(theta))", let T = "2*v0*sin(deg(theta))/g", readout "range = {vx*T} m". The board shows a scene\'s parameters, computed values, and any objects that could not be drawn, with the reason; read them before changing it. To change an existing scene, send it again with its shapeId: objects with the same id are replaced whole, new ones are added, ids in remove are deleted, unchanged objects can be left out, and parameters keep the values the user set (use set_parameter to change a value).',
		].join(' '),
	})

export type SceneAction = z.infer<typeof SceneAction>

// Widget Action
export const WidgetAction = z
	.object({
		_type: z.literal('widget'),
		intent: z.string(),
		shapeId: SimpleShapeIdSchema,
		title: z.string(),
		brief: z.string(),
		x: z.number(),
		y: z.number(),
		width: z.number(),
		height: z.number(),
		params: z.array(ParameterSchema),
		state: z.array(z.object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })),
	})
	.meta({
		title: 'Widget',
		description: [
			'The AI starts a widget: a small interactive program, written in HTML and JavaScript in the background and run in a sandbox on the board, behind a placeholder. If a widget template fits the topic, place it with widget_template instead. Reach for a new widget only when a template, a scene, a graph, or a diagram cannot do the job: a clickable prototype of a mockup, custom interaction such as sorting cards or stepping through an algorithm, pixel work, or 3D. It takes a minute to write, so tell the user it is on its way and carry on.',
			'brief: everything the program must show and do, in plain words, as the full spec for the writer, who sees nothing else: layout, controls, what each control changes, labels, and what the drawing must show so it teaches the idea. Name the values and names already on the board, such as a 10 N push or the product name, so the widget uses the same ones. params: named numbers shown as sliders under the widget that the user and you can change (use set_parameter), each with value, min, max, step. state: the other values the widget keeps on the board, each with a key and a starting value, such as {key: "screen", value: "signup"} or {key: "count", value: 0}; the widget may change only these, and the board records each change. width and height are the widget area in pixels. You see the widget as a snapshot in your view of the board, with its parameter and state values. To rewrite a widget, send it again with its shapeId and a new brief.',
		].join(' '),
	})

export type WidgetAction = z.infer<typeof WidgetAction>

// Widget Template Action
export const WidgetTemplateAction = z
	.object({
		_type: z.literal('widget_template'),
		intent: z.string(),
		shapeId: SimpleShapeIdSchema,
		template: z.string(),
		x: z.number(),
		y: z.number(),
		state: z.array(z.object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })),
	})
	.meta({
		title: 'Widget Template',
		description:
			'The AI places a ready-made widget from the widget templates listed in the prompt, with its own starting values for any of the template state keys (or an empty list). A widget template is hand-written, checked, and lands at once, ready to use, so whenever one fits the topic, always place it instead of writing a widget, and then talk the user through it. Write a widget only when no widget template fits.',
	})

export type WidgetTemplateAction = z.infer<typeof WidgetTemplateAction>

// Render Animation Action
export const RenderAnimationAction = z
	.object({
		_type: z.literal('render_animation'),
		intent: z.string(),
		shapeId: SimpleShapeIdSchema,
		title: z.string(),
		brief: z.string(),
		x: z.number(),
		y: z.number(),
		width: z.number().optional(),
		height: z.number().optional(),
	})
	.meta({
		title: 'Render Animation',
		description: [
			'The AI starts an animation: a polished Manim video, about 10 to 30 seconds, written and rendered in the background behind a placeholder that shows it taking shape. Use it when the user asks to animate something, or to see how something moves, grows, or changes over time as a story to watch, such as a projectile with its velocity vectors, a wave built from a circle, an algorithm step by step, or a process in stages. When the user wants to change values and explore, a live scene (scene or scene_template) is the better choice. It takes about a minute, so tell the user it is on its way and carry on.',
			'brief: everything the animation must show, in order, as the full spec for the writer, who sees nothing else: the situation with its numbers, what moves and how, what is labelled, which colour means what, and the one idea the last frame should hold. width is the video width in pixels (default 640; the height follows at 16:9). The board shows you the finished video as its last frame. To remake an animation, send it again with its shapeId and a new brief; asking again for one already on the board with the same title and brief is served from the cache at once.',
		].join(' '),
	})

export type RenderAnimationAction = z.infer<typeof RenderAnimationAction>

// Scene Object Action
export const SceneObjectAction = z
	.object({
		_type: z.literal('scene_object'),
		intent: z.string(),
		shapeId: SimpleShapeIdSchema,
		object: SceneObjectSchema,
	})
	.meta({
		title: 'Scene Object',
		description:
			'The AI adds one object to an existing scene, or replaces the object with the same id, in the same format as the objects of a scene action. Each one lands on the board as soon as it is written. Use it to build a scene up after a scene action that sets its frame and params, to fix one object a problem names, or to add one thing.',
	})

export type SceneObjectAction = z.infer<typeof SceneObjectAction>

// Scene Template Action
export const SceneTemplateAction = z
	.object({
		_type: z.literal('scene_template'),
		intent: z.string(),
		shapeId: SimpleShapeIdSchema,
		template: z.string(),
		x: z.number(),
		y: z.number(),
		params: z.array(z.object({ name: z.string(), value: z.number() })),
	})
	.meta({
		title: 'Scene Template',
		description:
			'The AI places a ready-made scene from the templates listed in the prompt, with its own starting values for any of the template params. A template is checked and verified, and lands at once, so prefer one whenever it fits the topic; then change it with scene_object or set_parameter if needed. Write a new scene only when no template fits.',
	})

export type SceneTemplateAction = z.infer<typeof SceneTemplateAction>

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
			"The AI sets one parameter of a graph, a simulation, or a scene, the same way the user moves its slider, and the plot updates for both. Use it to show what a change does, such as doubling the speed. The board shows each shape's current parameter values; read them before changing one, because the user may have moved it.",
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
		layout: z.enum(['flow', 'map', 'timeline']),
		nodes: z.array(
			z.object({
				id: z.string(),
				label: z.string(),
				date: z.string().optional(),
				group: z.string().optional(),
				note: z.string().optional(),
			})
		),
		edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
	})
	.meta({
		title: 'Diagram',
		description:
			'The AI draws a diagram from nodes and edges, and the app lays it out cleanly as ordinary boxes and bound arrows the user can move and edit. Use it for any flow, process, hierarchy, concept map, or timeline instead of placing boxes, arrows, or rows of text one by one. Layout "flow": top to bottom in steps, for processes and causes. Layout "map": spread out by links, for concept maps and mind maps. Layout "timeline": dated events in time order, drawn as a column of dates, a spine with one dot per event, and each event beside its dot; use it for every timeline or chronology, with edges []. Node labels: a few words. Edge labels: one to three words, a linking verb such as "causes", "feeds", or "turns into", or "" for none. Keep a flow to about 12 boxes and never over 18: make each vote or check one decision that names the stage it covers ("House committee and floor pass it?"), not a step and then a question, draw a retry as a step and its own decision ("Reconcile versions", then "Both pass the same text?") rather than an arrow back up to an earlier step, state the exact rule in the question ("Two-thirds of each chamber override?", "No action for 10 days, Sundays excepted?"), and give one actor\'s choice all its ways out from one decision (the President: "signs", "vetoes", "no action"). Keep a concept map to 6 to 9 concepts of two to four words with about one link per concept, keeping only the links the explanation needs; put finer detail in a note beside it. A map of a cycle, such as the water, carbon, or nitrogen cycle, must close and be complete, and may take up to 12 concepts: every store or stage has a way in and a way back out into the loop, with no dead end (groundwater flows back to rivers and the oceans), and every process a textbook names for that cycle is there as a concept or a labelled link (the water cycle: evaporation, transpiration from plants, condensation, precipitation, runoff, infiltration, and groundwater flow). In a concept map, list the main loop (the cycle itself, in order) or the main chain of causes first: the app draws it first and largest, and the rest around it. In a flow, word each decision as a short question ending in "?", such as "Same text in both chambers?" or "Two-thirds override?", and label its ways out "yes" and "no"; the app draws decisions as diamonds and the start and ends as pills, and colors the ways out and the outcomes green and red. Give each decision every real outcome, including the easily forgotten ones, and a step that resolves a disagreement before any failure it can lead to (two chambers that pass different versions go to a conference committee or trade amendments, then vote on the same text), and give each way out its own small end box next to the step it leaves, such as "Vetoed: bill dies", rather than routing long arrows back to one shared end. In a flow or a concept map whose parts belong to two to four kinds the reader should tell apart, such as oxygen-poor and oxygen-rich blood, the browser, server, and data tiers, or political, economic, and social causes, give each node a group with the same words every time: each group gets one color, in the order blue, red, green, violet, and a legend names them. For example, the heart: {"id":"ra","label":"Right atrium","group":"Oxygen-poor blood"}, {"id":"la","label":"Left atrium","group":"Oxygen-rich blood"}; the water cycle: "Water stores" for oceans, clouds, plants, and groundwater, "Processes" for evaporation, transpiration, condensation, and precipitation; a revolution\'s causes: "Economic", "Social", "Political". A map or flow without groups is drawn in plain ink. In a timeline, give each node a date (such as "1957", or "Apr 1961" when two events share a year), a label saying what happened, and, when the events belong to sides, kinds, or phases, such as two countries, or protests, war, and peace, a group with the same words every time: each group gets one color for its dates and dots, and a legend. Give the key event a note: one short line of detail under it. x and y: the top left corner. To redraw a diagram, send the same diagramId; nodes the user moved stay where they put them.',
	})

export type DiagramAction = z.infer<typeof DiagramAction>
