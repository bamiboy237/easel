import { compileExpression, CompiledExpression, Scope } from '../math/expression'
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
	for (const [id, object] of Object.entries(props.objects)) {
		if (object.type !== 'let') continue
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
		.filter(([, o]) => o.type !== 'let' && o.type !== 'readout')
		.map(([id, o]) => `${id} (${o.type})`)
		.join(', ')
	const errors = Object.entries(values.errors).map(([id, e]) => `${id}: ${e}`)
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
		case 'let':
			object = { ...base, type, expr: str('expr') }
			break
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
		default:
			return own
	}
}

/** A draggable point moves the parameters its coordinates name. */
export function dragTargets(object: SceneObject, params: Record<string, ShapeParameter>) {
	if (object.type !== 'point' || !object.drag) return null
	const x = params[object.x]
	const y = params[object.y]
	if (!x && !y) return null
	return { x: x ?? null, y: y ?? null }
}

export { clampParameter }
