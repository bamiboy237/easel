import { Box, Editor, TLShape, TLShapeId, VecModel } from 'tldraw'
import { convertTldrawShapeToFocusedShape } from '../../shared/format/convertTldrawShapeToFocusedShape'
import { getShapeCreator } from '../agent/managers/BoardCommandManager'
import { EQUATION_TYPE, EquationShape, renderEquation } from '../shapes/EquationShapeUtil'
import { GRAPH_TYPE, GraphShape, PARAMETER_PAD, PARAMETER_ROW, parametersHeight, viewYMin } from '../shapes/GraphShapeUtil'
import { compileExpression } from '../shapes/math/expression'
import { describeParameters, parameterScope, ShapeParameter } from '../shapes/math/parameters'
import { SCENE_TYPE, sceneChromeHeight, SceneShape } from '../shapes/SceneShapeUtil'
import { evaluateIn, evaluateScene, resolveRef, SceneObject, sceneParameters } from '../shapes/scene/sceneModel'
import { SIMULATION_TYPE, SimulationShape } from '../shapes/SimulationShapeUtil'
import { WIDGET_TYPE, WidgetShape } from '../shapes/WidgetShapeUtil'

/**
 * Pointing targets: a shape, or a named part of one, such as `g1.curve`,
 * `g1.point2`, `eq3.term2`, or `scene1.ball`. Part IDs are built from what each
 * shape already stores (a graph's functions and marked points, a scene's
 * object ids, an equation's top-level terms, any shape's parameters), so they
 * stay stable while the shape keeps its content.
 */
export interface BoardTarget {
	/** The ID as the voice model gave it. */
	ref: string
	shapeId: TLShapeId
	/** The part name after the dot, or null for the whole shape. */
	part: string | null
	/** A few words about it, for matching it to what the voice says. */
	label: string
	/** The part's bounds on the page. */
	bounds: Box
	/** Where the cursor's tip lands, on the page. */
	anchor: VecModel
	/** For a curve: its line on the page, so a highlight follows the curve. */
	path?: VecModel[]
}

interface Part {
	name: string
	label: string
	/** In the shape's own coordinates. */
	bounds: Box
	anchor?: VecModel
	path?: VecModel[]
}

const EQUATION_PAD = 8

function shapeIdOf(editor: Editor, simple: string): TLShapeId | null {
	const id = (simple.startsWith('shape:') ? simple : `shape:${simple}`) as TLShapeId
	return editor.getShape(id) ? id : null
}

/** Resolve a shape ID or a part ID to where it is on the page. Null when it is not on the board. */
export function resolveTarget(editor: Editor, ref: string): BoardTarget | null {
	const clean = ref.trim().replace(/^\[|\]$/g, '')
	const whole = shapeIdOf(editor, clean)
	let shapeId = whole
	let partName: string | null = null
	if (!whole) {
		const dot = clean.lastIndexOf('.')
		if (dot <= 0) return null
		shapeId = shapeIdOf(editor, clean.slice(0, dot))
		partName = clean.slice(dot + 1)
	}
	if (!shapeId) return null
	const shape = editor.getShape(shapeId)!
	const pageBounds = editor.getShapePageBounds(shapeId)
	if (!pageBounds) return null
	if (partName === null) {
		return { ref, shapeId, part: null, label: describeShape(editor, shape), bounds: pageBounds, anchor: shapeAnchor(pageBounds) }
	}
	const part = getParts(editor, shape).find((p) => p.name.toLowerCase() === partName!.toLowerCase())
	// An unknown part still points at its shape, so the cursor is never lost.
	if (!part) {
		return { ref, shapeId, part: null, label: describeShape(editor, shape), bounds: pageBounds, anchor: shapeAnchor(pageBounds) }
	}
	const transform = editor.getShapePageTransform(shapeId)
	const toPage = (p: VecModel) => transform.applyToPoint(p)
	const corners = part.bounds.corners.map(toPage)
	const bounds = Box.FromPoints(corners)
	// A part without its own point, such as an equation's term, is pointed at from just below, so the cursor never covers it.
	const anchor = part.anchor ? toPage(part.anchor) : { x: bounds.midX, y: bounds.maxY + 2 }
	return { ref, shapeId, part: part.name, label: part.label, bounds, anchor, path: part.path?.map(toPage) }
}

/** The cursor's tip lands a little inside the top left of a shape, as a hand points at it. */
function shapeAnchor(bounds: Box): VecModel {
	return { x: bounds.x + Math.min(bounds.w * 0.35, 60), y: bounds.y + Math.min(bounds.h * 0.4, 40) }
}

/** The named parts of a shape. */
export function getParts(editor: Editor, shape: TLShape): Part[] {
	try {
		if (shape.type === GRAPH_TYPE) return graphParts(shape as GraphShape)
		if (shape.type === SCENE_TYPE) return sceneParts(shape as SceneShape)
		if (shape.type === EQUATION_TYPE) return equationParts(shape as EquationShape)
		if (shape.type === SIMULATION_TYPE) return sliderParts((shape as SimulationShape).props.parameters, (shape as SimulationShape).props.h, (shape as SimulationShape).props.w)
		if (shape.type === WIDGET_TYPE) {
			const props = (shape as WidgetShape).props
			return sliderParts(Object.values(props.params), props.h, props.w)
		}
	} catch (error) {
		console.warn('Could not list the parts of', shape.id, error)
	}
	return []
}

/** Slider rows sit at the bottom of a shape, one per parameter. */
function sliderParts(parameters: ShapeParameter[], h: number, w: number): Part[] {
	const top = h - parametersHeight(parameters) + PARAMETER_PAD
	return parameters.map((p, i) => ({
		name: p.name,
		label: `the ${p.name} slider, now ${round(p.value)}`,
		bounds: new Box(0, top + i * PARAMETER_ROW, w, PARAMETER_ROW),
		// On the slider's thumb: the track runs across about the middle 58 percent of the row.
		anchor: { x: w * (0.24 + 0.58 * Math.min(1, Math.max(0, (p.value - p.min) / (p.max - p.min || 1)))), y: top + i * PARAMETER_ROW + PARAMETER_ROW / 2 + 4 },
	}))
}

function graphParts(shape: GraphShape): Part[] {
	const { w, h, functions, parameters, xMin, xMax, yMax } = shape.props
	const plotHeight = Math.max(40, h - parametersHeight(parameters))
	const yMin = viewYMin(shape.props.yMin, yMax, plotHeight)
	const px = (x: number) => ((x - xMin) / (xMax - xMin)) * w
	const py = (y: number) => ((yMax - y) / (yMax - yMin)) * plotHeight
	const scope = parameterScope(parameters)
	const parts: Part[] = []
	functions.forEach((f, i) => {
		let fn: ((x: number) => number) | null = null
		try {
			const compiled = compileExpression(f.expression)
			fn = (x) => compiled({ ...scope, x })
		} catch {
			return
		}
		const path: VecModel[] = []
		for (let k = 0; k <= 120; k++) {
			const x = xMin + ((xMax - xMin) * k) / 120
			const y = fn(x)
			if (Number.isFinite(y) && y >= yMin && y <= yMax) path.push({ x: px(x), y: py(y) })
		}
		if (path.length < 2) return
		const name = i === 0 ? 'curve' : `curve${i + 1}`
		parts.push({
			name,
			label: `the curve y = ${f.expression}${f.label ? `, "${f.label}"` : ''} on the graph`,
			bounds: Box.FromPoints(path).expandBy(4),
			// The cursor lands on the curve a little past its middle.
			anchor: path[Math.floor(path.length * 0.6)],
			path,
		})
	})
	;(shape.props.points ?? []).forEach((p, i) => {
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return
		const at = { x: px(p.x), y: py(p.y) }
		parts.push({
			name: `point${i + 1}`,
			label: `the marked point (${p.x}, ${p.y})${p.label ? `, "${p.label}"` : ''}`,
			bounds: new Box(at.x - 10, at.y - 10, 20, 20),
			anchor: at,
		})
	})
	return [...parts, ...sliderParts(parameters, h, w)]
}

function sceneParts(shape: SceneShape): Part[] {
	const { w, h, xMin, xMax, yMin, yMax, objects } = shape.props
	const plotHeight = Math.max(60, h - sceneChromeHeight(shape.props))
	const unitsPerPixel = Math.max((xMax - xMin) / w, (yMax - yMin) / plotHeight)
	const left = (xMin + xMax) / 2 - (w * unitsPerPixel) / 2
	const top = (yMin + yMax) / 2 + (plotHeight * unitsPerPixel) / 2
	const toLocal = ([x, y]: [number, number]): VecModel => ({ x: (x - left) / unitsPerPixel, y: (top - y) / unitsPerPixel })
	const values = evaluateScene(shape.props, 0)
	const parts: Part[] = []
	const add = (id: string, o: SceneObject, points: [number, number][], what: string, path = false) => {
		const local = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)).map(toLocal)
		if (local.length === 0) return
		const label = 'label' in o && o.label ? `, "${o.label}"` : ''
		parts.push({
			name: id,
			label: `the ${what} ${id}${label} in the scene`,
			bounds: Box.FromPoints(local).expandBy(10),
			anchor: local.length === 2 ? { x: (local[0].x + local[1].x) / 2, y: (local[0].y + local[1].y) / 2 } : local[0],
			path: path && local.length > 1 ? local : undefined,
		})
	}
	for (const [id, o] of Object.entries(objects)) {
		switch (o.type) {
			case 'point':
				add(id, o, [values.points[id]], 'point')
				break
			case 'segment':
			case 'line':
				add(id, o, [resolveRef(o.from, values), resolveRef(o.to, values)], o.type, true)
				break
			case 'vector': {
				const from = resolveRef(o.from, values)
				const to: [number, number] = [from[0] + evaluateIn(o.dx, values.scope), from[1] + evaluateIn(o.dy, values.scope)]
				add(id, o, [from, to], 'arrow', true)
				break
			}
			case 'circle': {
				const [cx, cy] = resolveRef(o.center, values)
				const r = evaluateIn(o.r, values.scope)
				add(id, o, [[cx - r, cy - r], [cx + r, cy + r]], 'circle')
				break
			}
			case 'polygon':
				add(id, o, o.points.map((p) => resolveRef(p, values)), 'shape')
				break
			case 'label':
				add(id, o, [resolveRef(o.at, values)], 'label')
				break
		}
	}
	return [...parts, ...sliderParts(sceneParameters(shape.props), h, w)]
}

/**
 * An equation's top-level terms, as typeset: the runs between plus, minus, and
 * relation signs, numbered from the left (term1, term2, ...), and its two sides
 * (lhs, rhs) around the first relation.
 */
function equationParts(shape: EquationShape): Part[] {
	if (typeof document === 'undefined') return []
	const { latex, size } = shape.props
	const rendered = renderEquation(latex)
	if (!rendered.html) return []
	const probe = document.createElement('div')
	probe.className = 'equation-body'
	probe.style.cssText = `position:absolute;visibility:hidden;left:-10000px;top:0;font-size:${size}px;white-space:nowrap;`
	probe.innerHTML = rendered.html
	document.body.appendChild(probe)
	try {
		const origin = probe.getBoundingClientRect()
		const local = (r: DOMRect) => new Box(r.left - origin.left + EQUATION_PAD, r.top - origin.top + EQUATION_PAD, r.width, r.height)
		const groups: { els: Element[]; side: number }[] = []
		let current: Element[] = []
		let side = 0
		const flush = () => {
			if (current.length > 0) groups.push({ els: current, side })
			current = []
		}
		for (const base of Array.from(probe.querySelectorAll('.katex-html > .base'))) {
			for (const el of Array.from(base.children)) {
				if (el.classList.contains('strut')) continue
				if (el.classList.contains('mrel')) {
					flush()
					side++
					continue
				}
				if (el.classList.contains('mbin')) {
					flush()
					continue
				}
				current.push(el)
			}
		}
		flush()
		const union = (els: Element[]) => Box.Common(els.map((el) => local(el.getBoundingClientRect())).filter((b) => b.w > 0))
		const parts: Part[] = groups.map((g, i) => ({
			name: `term${i + 1}`,
			label: `the term ${g.els.map((el) => el.textContent ?? '').join('').replace(/[\u200b\s]+/g, ' ').trim()} in the equation`,
			bounds: union(g.els).expandBy(3),
		}))
		const lhs = groups.filter((g) => g.side === 0).flatMap((g) => g.els)
		const rhs = groups.filter((g) => g.side >= 1).flatMap((g) => g.els)
		if (lhs.length > 0 && rhs.length > 0) {
			parts.push({ name: 'lhs', label: 'the left side of the equation', bounds: union(lhs).expandBy(3) })
			parts.push({ name: 'rhs', label: 'the right side of the equation', bounds: union(rhs).expandBy(3) })
		}
		return parts.filter((p) => p.bounds.w > 0)
	} finally {
		probe.remove()
	}
}

function round(n: number) {
	return Math.round(n * 1000) / 1000
}

/** What a shape shows, in one line. */
export function describeShape(editor: Editor, shape: TLShape): string {
	let text = ''
	try {
		const focused = convertTldrawShapeToFocusedShape(editor, shape) as { text?: unknown; note?: unknown; _type: string }
		text = typeof focused.text === 'string' && focused.text ? focused.text : typeof focused.note === 'string' ? focused.note : ''
		if (!text && shape.type === 'frame') text = (shape.props as { name?: string }).name ?? ''
	} catch {
		// A shape the format cannot read is still listed by its type.
	}
	return text.replace(/\s+/g, ' ').trim()
}

/**
 * The board as the voice model reads it: one line per shape, the shapes in
 * view first, with each shape's parameters and part IDs.
 */
export function describeBoardForVoice(editor: Editor, max = 50): string {
	const view = editor.getViewportPageBounds()
	const shapes = editor
		.getCurrentPageShapesSorted()
		.filter((s) => s.type !== 'arrow' && !s.meta.scenePreview)
		.map((s) => ({ s, b: editor.getShapePageBounds(s) }))
		.filter((x): x is { s: TLShape; b: Box } => !!x.b)
		.sort((a, b) => Number(view.collides(b.b)) - Number(view.collides(a.b)) || a.b.y - b.b.y || a.b.x - b.b.x)
	const lines: string[] = []
	for (const { s, b } of shapes.slice(0, max)) {
		const id = s.id.replace(/^shape:/, '')
		const owner = getShapeCreator(s) === 'user' || editor.getShapeAncestors(s).some((a) => a.type === 'frame' && getShapeCreator(a) === 'user') ? ", the user's" : ''
		const where = view.collides(b) ? 'in view' : 'out of view'
		const described = describeShape(editor, s)
		const params = parametersOf(s)
		// Long descriptions are cut, but a shape's parameters are always listed whole.
		const text = described.length > 360 ? `${described.slice(0, 360)}...` : described
		let line = `${id} (${s.type}${owner}, ${where}): ${text}`
		if (params.length > 0 && !text.includes(describeParameters(params))) line += ` Parameters: ${describeParameters(params)}.`
		const parts = getParts(editor, s).map((p) => `${id}.${p.name}`)
		if (parts.length > 0) line += ` Parts: ${parts.join(', ')}.`
		lines.push(line)
	}
	if (shapes.length > max) lines.push(`(${shapes.length - max} more shapes further away.)`)
	const selected = editor.getSelectedShapeIds().map((id) => id.replace(/^shape:/, ''))
	if (selected.length > 0) lines.push(`Selected by the user: ${selected.join(', ')}.`)
	return lines.length > 0 ? lines.join('\n') : 'The board is empty.'
}

function parametersOf(shape: TLShape): ShapeParameter[] {
	if (shape.type === GRAPH_TYPE) return (shape as GraphShape).props.parameters
	if (shape.type === SIMULATION_TYPE) return (shape as SimulationShape).props.parameters
	if (shape.type === SCENE_TYPE) return sceneParameters((shape as SceneShape).props)
	if (shape.type === WIDGET_TYPE) return Object.values((shape as WidgetShape).props.params)
	return []
}
