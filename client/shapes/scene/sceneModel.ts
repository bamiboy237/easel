import { compileExpression, CompiledExpression, expressionNames, functionNames, Scope } from '../math/expression'
import { clampParameter, ShapeParameter } from '../math/parameters'

/**
 * A scene is a visual described as data, in the style of Desmos and GeoGebra:
 * named parameters (sliders), and objects whose positions and sizes are
 * formulas of those parameters and of time `t`. The app evaluates and draws it,
 * so the agent never writes code, and both participants change it through the
 * same sliders and draggable points.
 *
 * Parameters and objects are maps keyed by name and id, not arrays, so a
 * person and the agent can change different parts of one scene at once.
 */

/** A point given by another point's id, or by an [x, y] pair of expressions. */
export type SceneRef = string | [string, string]

interface SceneObjectBase {
	/** An expression; the object shows when it is not 0. */
	visible?: string
	/** Which board ink to draw with: 0 charcoal, 1 red pencil, 2 blue, 3 forest. */
	ink?: number
}

export type SceneObject = SceneObjectBase &
	(
		| { type: 'let'; expr: string }
		| { type: 'point'; x: string; y: string; drag?: boolean; label?: string }
		| { type: 'segment'; from: SceneRef; to: SceneRef; label?: string }
		| { type: 'line'; from: SceneRef; to: SceneRef }
		| { type: 'vector'; from: SceneRef; dx: string; dy: string; label?: string }
		| { type: 'circle'; center: SceneRef; r: string; fill?: boolean }
		| { type: 'polygon'; points: SceneRef[]; fill?: boolean }
		| { type: 'plot'; y: string }
		| { type: 'curve'; x: string; y: string; from: string; to: string }
		| { type: 'trace'; of: string }
		| { type: 'label'; at: SceneRef; text: string }
		| { type: 'readout'; text: string }
		| { type: 'check'; expr: string; text: string }
	)

export type SceneObjectType = SceneObject['type']

export const SCENE_OBJECT_TYPES: SceneObjectType[] = [
	'let',
	'point',
	'segment',
	'line',
	'vector',
	'circle',
	'polygon',
	'plot',
	'curve',
	'trace',
	'label',
	'readout',
	'check',
]

export interface SceneProps {
	w: number
	h: number
	title: string
	xMin: number
	xMax: number
	yMin: number
	yMax: number
	/** How long time runs, in seconds. 0 means the scene has no clock. */
	duration: number
	/** Whether to draw the coordinate grid and axes. Diagrams such as free-body diagrams leave them out. */
	axes?: boolean
	params: Record<string, ShapeParameter>
	objects: Record<string, SceneObject>
}

/** Board inks, in order: charcoal, red pencil, blue, forest. */
export const SCENE_INKS = ['#302F2A', '#AE3B2C', '#2F5D8C', '#344C41']

const cache = new Map<string, CompiledExpression | Error>()

/** Compile with a cache, since the same scene is evaluated every frame. */
function compiled(source: string): CompiledExpression {
	let hit = cache.get(source)
	if (!hit) {
		try {
			hit = compileExpression(source)
		} catch (error) {
			hit = error instanceof Error ? error : new Error(String(error))
		}
		if (cache.size > 2000) cache.clear()
		cache.set(source, hit)
	}
	if (hit instanceof Error) throw hit
	return hit
}

/** The parameters in display order. */
export function sceneParameters(props: Pick<SceneProps, 'params'>): ShapeParameter[] {
	return Object.values(props.params)
}

/** The values of a scene at time t: its parameters, then its `let` values, in order. */
export interface SceneValues {
	scope: Scope
	/** Every point object's position, by id. */
	points: Record<string, [number, number]>
	/** Problems found while evaluating, by object id. */
	errors: Record<string, string>
}

/** Evaluate an expression in a scope, as a number or NaN. */
export function evaluateIn(source: string, scope: Scope): number {
	return compiled(source)(scope)
}

/**
 * Evaluate a scene at time t. Lets are evaluated in order, so each can use the
 * ones before it. Points come after the lets, and can use them.
 */
export function evaluateScene(props: Pick<SceneProps, 'params' | 'objects'>, t: number): SceneValues {
	const scope: Scope = { t }
	for (const p of Object.values(props.params)) scope[p.name] = p.value
	const errors: Record<string, string> = {}
	for (const [id, object] of letsInOrder(props.objects)) {
		try {
			scope[id] = evaluateIn(object.expr, scope)
		} catch (error) {
			errors[id] = (error as Error).message
			scope[id] = NaN
		}
	}
	const points: Record<string, [number, number]> = {}
	for (const [id, object] of Object.entries(props.objects)) {
		if (object.type !== 'point') continue
		try {
			points[id] = [evaluateIn(object.x, scope), evaluateIn(object.y, scope)]
		} catch (error) {
			errors[id] = (error as Error).message
		}
	}
	return { scope, points, errors }
}

const letOrderCache = new WeakMap<object, [string, Extract<SceneObject, { type: 'let' }>][]>()

/**
 * The lets in an order where each comes after the lets it uses, so the agent
 * can define them in any order and update one to use a newer one. A let in a
 * cycle keeps its place and reads the others as not yet defined.
 */
export function letsInOrder(objects: Record<string, SceneObject>) {
	const cached = letOrderCache.get(objects)
	if (cached) return cached
	const lets = Object.entries(objects).filter(([, o]) => o.type === 'let') as [string, Extract<SceneObject, { type: 'let' }>][]
	const byId = new Map(lets)
	const ordered: typeof lets = []
	const state = new Map<string, 'visiting' | 'done'>()
	const visit = (id: string) => {
		if (state.get(id)) return
		state.set(id, 'visiting')
		let names: string[] = []
		try {
			names = expressionNames(byId.get(id)!.expr)
		} catch {
			// A let that does not parse is reported where it is read.
		}
		for (const name of names) if (byId.has(name) && !state.get(name)) visit(name)
		state.set(id, 'done')
		ordered.push([id, byId.get(id)!])
	}
	for (const [id] of lets) visit(id)
	letOrderCache.set(objects, ordered)
	return ordered
}

/** A reference as a position: a point's id, or an [x, y] pair of expressions. */
export function resolveRef(ref: SceneRef, values: SceneValues): [number, number] {
	if (typeof ref === 'string') return values.points[ref] ?? [NaN, NaN]
	return [evaluateIn(ref[0], values.scope), evaluateIn(ref[1], values.scope)]
}

/** Text with `{expression}` holes filled with rounded values, such as "range = {R} m". */
export function fillText(text: string, scope: Scope): string {
	return text.replace(/\{([^{}]+)\}/g, (_, source: string) => {
		try {
			return formatNumber(evaluateIn(source, scope))
		} catch {
			return '?'
		}
	})
}

export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return String(value)
	return String(Number(value.toPrecision(4)))
}

/** Whether an object shows at these values. */
export function isVisible(object: SceneObject, scope: Scope): boolean {
	if (!object.visible) return true
	try {
		return evaluateIn(object.visible, scope) !== 0
	} catch {
		return true
	}
}

/**
 * What the agent reads about a scene: its parameters, its computed values, and
 * its readouts, as numbers from the evaluator, so the agent quotes computed
 * values and sees the user's slider and point changes.
 */
export function describeScene(props: SceneProps): string {
	const values = evaluateScene(props, 0)
	const params = sceneParameters(props)
		.map((p) => `${p.name} = ${formatNumber(p.value)} (${formatNumber(p.min)} to ${formatNumber(p.max)})`)
		.join(', ')
	const lets = Object.entries(props.objects)
		.filter(([, o]) => o.type === 'let')
		.map(([id]) => `${id} = ${formatNumber(values.scope[id])}`)
		.join(', ')
	const readouts = Object.values(props.objects)
		.filter((o): o is Extract<SceneObject, { type: 'readout' }> => o.type === 'readout')
		.map((o) => fillText(o.text, values.scope))
		.join('; ')
	const objects = Object.entries(props.objects)
		.filter(([, o]) => o.type !== 'let' && o.type !== 'readout' && o.type !== 'check')
		.map(([id, o]) => `${id} (${o.type})`)
		.join(', ')
	const errors = Object.entries({ ...values.errors, ...findUndefinedNames(props) }).map(([id, e]) => `${id}: ${e}`)
	return [
		`Scene "${props.title}", x from ${props.xMin} to ${props.xMax}, y from ${props.yMin} to ${props.yMax}${props.duration > 0 ? `, time runs 0 to ${props.duration} s` : ''}.`,
		params && `Parameters: ${params}.`,
		lets && `Values at t = 0: ${lets}.`,
		readouts && `Readouts: ${readouts}.`,
		objects && `Objects: ${objects}.`,
		errors.length > 0 && `Errors: ${errors.join('; ')}.`,
	]
		.filter(Boolean)
		.join(' ')
}

/**
 * A clean scene object from the model: a known type, the fields it needs as
 * strings, and expressions that parse. Returns the object, or the reason it
 * was dropped, so the agent can be told.
 */
export function sanitizeSceneObject(raw: unknown): { object: SceneObject } | { error: string } {
	if (!raw || typeof raw !== 'object') return { error: 'not an object' }
	const o = raw as Record<string, unknown>
	const type = o.type as SceneObjectType
	if (!SCENE_OBJECT_TYPES.includes(type)) return { error: `unknown type "${String(o.type)}"` }
	const str = (key: string) => (typeof o[key] === 'number' ? String(o[key]) : typeof o[key] === 'string' ? (o[key] as string).trim() : '')
	const ref = (value: unknown): SceneRef | null => {
		if (typeof value === 'string' && value.trim()) return value.trim()
		if (Array.isArray(value) && value.length === 2) return [String(value[0]), String(value[1])]
		return null
	}
	const base: SceneObjectBase = {}
	if (str('visible')) base.visible = str('visible')
	if (Number.isInteger(o.ink) && (o.ink as number) >= 0 && (o.ink as number) < SCENE_INKS.length) base.ink = o.ink as number
	const label = str('label') || undefined
	let object: SceneObject | null = null
	switch (type) {
		case 'let': {
			// Models sometimes name the formula differently; take the first one given.
			const expr = str('expr') || str('expression') || str('formula') || str('value')
			if (!expr) return { error: 'let needs an expr' }
			object = { ...base, type, expr }
			break
		}
		case 'point':
			object = { ...base, type, x: str('x'), y: str('y'), ...(o.drag === true ? { drag: true } : {}), ...(label ? { label } : {}) }
			break
		case 'segment':
		case 'line': {
			const from = ref(o.from)
			const to = ref(o.to)
			if (!from || !to) return { error: `${type} needs from and to` }
			object = type === 'segment' ? { ...base, type, from, to, ...(label ? { label } : {}) } : { ...base, type, from, to }
			break
		}
		case 'vector': {
			const from = ref(o.from) ?? (['0', '0'] as [string, string])
			object = { ...base, type, from, dx: str('dx'), dy: str('dy'), ...(label ? { label } : {}) }
			break
		}
		case 'circle': {
			const center = ref(o.center)
			if (!center) return { error: 'circle needs a center' }
			object = { ...base, type, center, r: str('r'), ...(o.fill === true ? { fill: true } : {}) }
			break
		}
		case 'polygon': {
			const points = Array.isArray(o.points) ? o.points.map(ref).filter((p): p is SceneRef => !!p) : []
			if (points.length < 3) return { error: 'polygon needs at least 3 points' }
			object = { ...base, type, points, ...(o.fill === true ? { fill: true } : {}) }
			break
		}
		case 'plot':
			object = { ...base, type, y: str('y').replace(/^y\s*=\s*/, '') }
			break
		case 'curve':
			object = { ...base, type, x: str('x'), y: str('y'), from: str('from') || '0', to: str('to') || '1' }
			break
		case 'trace':
			if (!str('of')) return { error: 'trace needs the id of a point' }
			object = { ...base, type, of: str('of') }
			break
		case 'label': {
			const at = ref(o.at)
			if (!at) return { error: 'label needs a position' }
			object = { ...base, type, at, text: str('text') }
			break
		}
		case 'readout':
			object = { ...base, type, text: str('text') }
			break
		case 'check': {
			const expr = str('expr') || str('expression') || str('formula')
			if (!expr) return { error: 'check needs an expr that should hold' }
			object = { ...base, type, expr, text: str('text') }
			break
		}
	}
	if (!object) return { error: 'could not read it' }
	for (const source of expressionsOf(object)) {
		try {
			compiled(source)
		} catch (error) {
			return { error: (error as Error).message }
		}
	}
	return { object }
}

/** Every expression in an object, for checking that they parse. */
function expressionsOf(object: SceneObject): string[] {
	const refs = (r: SceneRef) => (typeof r === 'string' ? [] : r)
	const own: string[] = object.visible ? [object.visible] : []
	switch (object.type) {
		case 'let':
			return [...own, object.expr]
		case 'point':
			return [...own, object.x, object.y]
		case 'segment':
		case 'line':
			return [...own, ...refs(object.from), ...refs(object.to)]
		case 'vector':
			return [...own, ...refs(object.from), object.dx, object.dy]
		case 'circle':
			return [...own, ...refs(object.center), object.r]
		case 'polygon':
			return [...own, ...object.points.flatMap(refs)]
		case 'plot':
			return [...own, object.y]
		case 'curve':
			return [...own, object.x, object.y, object.from, object.to]
		case 'label':
			return [...own, ...refs(object.at)]
		case 'check':
			return [...own, object.expr]
		default:
			return own
	}
}

/** Names expressions already use for something else, so an object id cannot take them. */
const RESERVED_NAMES = new Set(['t', 'x', 's', 'pi', 'e', 'if', ...functionNames()])

/**
 * Why an object id cannot be used, or null. Ids are names other expressions
 * use, so they must be identifiers, and not a parameter, a function, or a
 * reserved name such as t. Numeric ids would also change the evaluation order.
 */
export function checkSceneObjectId(id: string, params: Record<string, ShapeParameter>): string | null {
	if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(id)) return 'an id must be a name made of letters, digits, and _, starting with a letter'
	if (RESERVED_NAMES.has(id)) return `"${id}" is a reserved name`
	if (Object.hasOwn(params, id)) return `"${id}" is already a parameter`
	return null
}

/**
 * Names an object uses that are not defined where it is evaluated: not a
 * parameter, not an earlier let, not t, x in a plot, or s in a curve. Each one
 * would quietly give NaN, so they are reported to the agent.
 */
export function findUndefinedNames(props: Pick<SceneProps, 'params' | 'objects'>): Record<string, string> {
	const problems: Record<string, string> = {}
	const known = new Set<string>(['t', ...Object.keys(props.params)])
	const points = new Set(Object.entries(props.objects).filter(([, o]) => o.type === 'point').map(([id]) => id))
	const check = (id: string, sources: string[], extra: string[] = []) => {
		const missing = new Set<string>()
		for (const source of sources) {
			try {
				for (const name of expressionNames(source)) if (!known.has(name) && !extra.includes(name)) missing.add(name)
			} catch {
				// Parse errors are reported where the object is read.
			}
		}
		if (missing.size > 0) {
			problems[id] = `uses ${[...missing].map((n) => `"${n}"`).join(', ')}, which ${missing.size === 1 ? 'is' : 'are'} not defined here, or part of a loop of lets`
		}
	}
	for (const [id, o] of letsInOrder(props.objects)) {
		check(id, [o.expr])
		known.add(id)
	}
	for (const [id, o] of Object.entries(props.objects)) {
		if (o.type === 'let') continue
		if (o.type === 'readout' || o.type === 'label') {
			check(id, [...textExpressions(o.text), ...(o.type === 'label' ? refExpressions(o.at) : []), ...(o.visible ? [o.visible] : [])])
			continue
		}
		if (o.type === 'trace' && !points.has(o.of)) {
			problems[id] = `traces "${o.of}", which is not a point`
			continue
		}
		const refs = [o.type === 'segment' || o.type === 'line' ? [o.from, o.to] : [], o.type === 'vector' ? [o.from] : [], o.type === 'circle' ? [o.center] : [], o.type === 'polygon' ? o.points : []].flat()
		const missingPoint = refs.find((r) => typeof r === 'string' && !points.has(r))
		if (missingPoint) {
			problems[id] = `refers to "${missingPoint}", which is not a point`
			continue
		}
		check(id, expressionsOf(o), o.type === 'plot' ? ['x'] : o.type === 'curve' ? ['s'] : [])
	}
	return problems
}

function textExpressions(text: string): string[] {
	return [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1])
}

function refExpressions(ref: SceneRef): string[] {
	return typeof ref === 'string' ? [] : ref
}

/** A draggable point moves the parameters its coordinates name. */
export function dragTargets(object: SceneObject, params: Record<string, ShapeParameter>) {
	if (object.type !== 'point' || !object.drag) return null
	const x = params[object.x]
	const y = params[object.y]
	if (!x && !y) return null
	return { x: x ?? null, y: y ?? null }
}

/** Whether a check's result counts as holding: a finite number that is not 0. */
export function checkHolds(result: number): boolean {
	return Number.isFinite(result) && result !== 0
}

/** A problem in a scene: a stable key for not repeating it, and the text the agent reads. */
export interface SceneProblem {
	key: string
	text: string
}

/**
 * Problems in a scene, found by evaluating it, for the agent to fix: names
 * that are not defined, the agent's own checks that fail, values that stop
 * being numbers somewhere in a slider's range, visible points outside the
 * frame, and angles in degrees passed to sin, cos, or tan without deg(). Each
 * scene is sampled with every parameter at its minimum, middle, and maximum
 * (on its step, as a slider would set it), and time at its start, middle, and
 * end. Each sample is evaluated once. Keys name the object and the kind of
 * problem, never a value the user can change, so the same problem is not
 * reported again when a slider moves.
 */
export function checkScene(props: SceneProps): SceneProblem[] {
	const problems: SceneProblem[] = []
	const add = (key: string, text: string) => {
		if (!problems.some((p) => p.key === key)) problems.push({ key, text })
	}
	const undefinedNames = findUndefinedNames(props)
	for (const [id, problem] of Object.entries(undefinedNames)) add(`${id}:undefined`, `${id} ${problem}`)
	const undefinedIds = new Set(Object.keys(undefinedNames))

	const params = Object.values(props.params)
	const times = props.duration > 0 ? [0, props.duration / 2, props.duration] : [0]
	const sampleSets: { label: string; params: Record<string, ShapeParameter>; t: number }[] = []
	for (const t of times) sampleSets.push({ label: t ? `t = ${formatNumber(t)}` : '', params: props.params, t })
	for (const p of params) {
		const values = [...new Set([p.min, (p.min + p.max) / 2, p.max].map((v) => clampParameter(p, v)))]
		for (const value of values) {
			sampleSets.push({
				label: `${p.name} = ${formatNumber(value)}`,
				params: { ...props.params, [p.name]: { ...p, value } },
				t: 0,
			})
		}
	}
	const samples = sampleSets.map((sample) => ({
		...sample,
		values: evaluateScene({ params: sample.params, objects: props.objects }, sample.t),
	}))
	const where = (label: string) => (label ? ` when ${label}` : '')

	// The agent's own checks must hold everywhere.
	for (const [id, o] of Object.entries(props.objects)) {
		if (o.type !== 'check' || undefinedIds.has(id)) continue
		for (const sample of samples) {
			let result = NaN
			try {
				result = evaluateIn(o.expr, sample.values.scope)
			} catch {
				// Parse errors are reported where the object is read.
			}
			if (!checkHolds(result)) {
				add(`${id}:check`, `check ${id} fails${where(sample.label)}: ${o.text || o.expr}`)
				break
			}
		}
	}

	// Values that stop being numbers somewhere in a slider's range. A point the
	// scene hides at that moment is not drawn, so it is not a problem there.
	const broken = new Set<string>(undefinedIds)
	for (const sample of samples) {
		for (const [id, o] of letsInOrder(props.objects)) {
			if (broken.has(id) || Number.isFinite(sample.values.scope[id])) continue
			broken.add(id)
			add(`${id}:nan`, `let ${id} = ${o.expr} is not a number${where(sample.label)}`)
		}
		for (const [id, o] of Object.entries(props.objects)) {
			if (o.type !== 'point' || broken.has(id) || !isVisible(o, sample.values.scope)) continue
			const p = sample.values.points[id]
			if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) continue
			broken.add(id)
			add(`${id}:nan`, `point ${id} has no position${where(sample.label)}`)
		}
	}

	// Visible points outside the frame at the starting values.
	const start = samples[0].values
	const marginX = (props.xMax - props.xMin) * 0.05
	const marginY = (props.yMax - props.yMin) * 0.05
	for (const [id, p] of Object.entries(start.points)) {
		const o = props.objects[id]
		if (broken.has(id) || !o || !isVisible(o, start.scope) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue
		if (p[0] < props.xMin - marginX || p[0] > props.xMax + marginX || p[1] < props.yMin - marginY || p[1] > props.yMax + marginY) {
			add(`${id}:outside`, `point ${id} at (${formatNumber(p[0])}, ${formatNumber(p[1])}) is outside the frame x ${props.xMin} to ${props.xMax}, y ${props.yMin} to ${props.yMax}`)
		}
	}

	// A parameter whose range is in degrees, used directly in sin, cos, or tan.
	const degreeParams = params.filter((p) => p.max - p.min > 2 * Math.PI + 0.01 && p.max <= 360 && /angle|theta|phi|alpha|beta|deg/i.test(p.name))
	for (const [id, o] of Object.entries(props.objects)) {
		for (const source of expressionsOf(o)) {
			for (const p of degreeParams) {
				if (new RegExp(`\\b(sin|cos|tan)\\(\\s*${p.name}(?![A-Za-z0-9_])`).test(source)) {
					add(`${id}:degrees:${p.name}`, `${id} passes ${p.name}, which looks like degrees (${formatNumber(p.min)} to ${formatNumber(p.max)}), to a trig function without deg()`)
				}
			}
		}
	}
	return problems
}
