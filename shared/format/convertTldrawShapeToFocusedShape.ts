import {
	Box,
	Editor,
	Mat,
	isPageId,
	TLArrowBinding,
	TLArrowShape,
	TLDrawShape,
	TLGeoShape,
	TLGeoShapeGeoStyle,
	TLLineShape,
	TLNoteShape,
	TLShape,
	TLShapeId,
	renderPlaintextFromRichText,
	TLTextShape,
	Vec,
} from 'tldraw'
import { SimpleShapeId } from '../types/ids-schema'
import { convertTldrawFillToFocusedFill } from './FocusedFill'
import { convertTldrawFontSizeAndScaleToFocusedFontSize } from './FocusedFontSize'
import { FocusedGeoShapeType } from './FocusedGeoShapeType'
import {
	FocusedArrowShape,
	FocusedDrawShape,
	FocusedGeoShape,
	FocusedLineShape,
	FocusedNoteShape,
	FocusedShape,
	FocusedTextAnchor,
	FocusedTextShape,
	FocusedUnknownShape,
} from './FocusedShape'

/**
 * Convert a tldraw shape to a focused shape
 */
export function convertTldrawShapeToFocusedShape(editor: Editor, shape: TLShape): FocusedShape {
	switch (shape.type) {
		case 'text':
			return convertTextShapeToFocused(editor, shape as TLTextShape)
		case 'geo':
			return convertGeoShapeToFocused(editor, shape as TLGeoShape)
		case 'line':
			return convertLineShapeToFocused(editor, shape as TLLineShape)
		case 'arrow':
			return convertArrowShapeToFocused(editor, shape as TLArrowShape)
		case 'note':
			return convertNoteShapeToFocused(editor, shape as TLNoteShape)
		case 'draw':
			return convertDrawShapeToFocused(editor, shape as TLDrawShape)
		default:
			return convertUnknownShapeToFocused(editor, shape)
	}
}

export function convertTldrawShapeToFocusedType(shape: TLShape): FocusedShape['_type'] {
	switch (shape.type) {
		case 'geo': {
			const geoShape = shape as TLGeoShape
			return GEO_TO_FOCUSED_TYPES[geoShape.props.geo]
		}
		case 'text':
		case 'line':
		case 'arrow':
		case 'note':
		case 'draw':
			return shape.type
		default:
			return 'unknown'
	}
}

const GEO_TO_FOCUSED_TYPES: Record<TLGeoShapeGeoStyle, FocusedGeoShapeType> = {
	rectangle: 'rectangle',
	ellipse: 'ellipse',
	triangle: 'triangle',
	diamond: 'diamond',
	hexagon: 'hexagon',
	oval: 'pill',
	cloud: 'cloud',
	'x-box': 'x-box',
	'check-box': 'check-box',
	heart: 'heart',
	pentagon: 'pentagon',
	octagon: 'octagon',
	star: 'star',
	rhombus: 'parallelogram-right',
	'rhombus-2': 'parallelogram-left',
	trapezoid: 'trapezoid',
	'arrow-right': 'fat-arrow-right',
	'arrow-left': 'fat-arrow-left',
	'arrow-up': 'fat-arrow-up',
	'arrow-down': 'fat-arrow-down',
} as const

export function convertTldrawIdToSimpleId(id: TLShapeId): SimpleShapeId {
	return id.slice(6) as SimpleShapeId
}

function convertDrawShapeToFocused(editor: Editor, shape: TLDrawShape): FocusedDrawShape {
	return {
		_type: 'draw',
		color: shape.props.color,
		fill: convertTldrawFillToFocusedFill(shape.props.fill),
		note: (shape.meta.note as string) ?? '',
		shapeId: convertTldrawIdToSimpleId(shape.id),
	}
}

function convertTextShapeToFocused(editor: Editor, shape: TLTextShape): FocusedTextShape {
	const util = editor.getShapeUtil(shape)
	const text = util.getText(shape) ?? ''
	const bounds = getSimpleBounds(editor, shape)

	const position = new Vec()
	let anchor: FocusedTextAnchor = 'top-left'
	switch (shape.props.textAlign) {
		case 'middle': {
			anchor = 'top-center'
			position.x = bounds.center.x
			position.y = bounds.top
			break
		}
		case 'end': {
			anchor = 'top-right'
			position.x = bounds.right
			position.y = bounds.top
			break
		}
		case 'start': {
			anchor = 'top-left'
			position.x = bounds.left
			position.y = bounds.top
			break
		}
	}

	return {
		_type: 'text',
		anchor,
		color: shape.props.color,
		fontSize: convertTldrawFontSizeAndScaleToFocusedFontSize(editor, shape),
		maxWidth: shape.props.autoSize ? null : shape.props.w,
		note: (shape.meta.note as string) ?? '',
		shapeId: convertTldrawIdToSimpleId(shape.id),
		text: text,
		x: position.x,
		y: position.y,
	}
}

function convertGeoShapeToFocused(editor: Editor, shape: TLGeoShape): FocusedGeoShape {
	const util = editor.getShapeUtil(shape)
	const text = util.getText(shape)
	const bounds = getSimpleBounds(editor, shape)
	const shapeTextAlign = shape.props.align

	let newTextAlign: FocusedGeoShape['textAlign']
	switch (shapeTextAlign) {
		case 'start-legacy':
			newTextAlign = 'start'
			break
		case 'middle-legacy':
			newTextAlign = 'middle'
			break
		case 'end-legacy':
			newTextAlign = 'end'
			break
		default:
			newTextAlign = shapeTextAlign
			break
	}

	return {
		_type: GEO_TO_FOCUSED_TYPES[shape.props.geo],
		color: shape.props.color,
		fill: convertTldrawFillToFocusedFill(shape.props.fill),
		h: shape.props.h,
		note: (shape.meta.note as string) ?? '',
		shapeId: convertTldrawIdToSimpleId(shape.id),
		text: text ?? '',
		textAlign: newTextAlign,
		w: shape.props.w,
		x: bounds.x,
		y: bounds.y,
	}
}

function convertLineShapeToFocused(editor: Editor, shape: TLLineShape): FocusedLineShape {
	const bounds = getSimpleBounds(editor, shape)
	const points = Object.values(shape.props.points).sort((a, b) => a.index.localeCompare(b.index))
	return {
		_type: 'line',
		color: shape.props.color,
		note: (shape.meta.note as string) ?? '',
		shapeId: convertTldrawIdToSimpleId(shape.id),
		x1: points[0].x + bounds.x,
		x2: points[1].x + bounds.x,
		y1: points[0].y + bounds.y,
		y2: points[1].y + bounds.y,
	}
}

function convertArrowShapeToFocused(editor: Editor, shape: TLArrowShape): FocusedArrowShape {
	const bounds = getSimpleBounds(editor, shape)
	const bindings = editor.store.query.records('binding').get()
	const arrowBindings = bindings.filter(
		(b) => b.type === 'arrow' && b.fromId === shape.id
	) as TLArrowBinding[]
	const startBinding = arrowBindings.find((b) => b.props.terminal === 'start')
	const endBinding = arrowBindings.find((b) => b.props.terminal === 'end')

	return {
		_type: 'arrow',
		bend: shape.props.bend * -1,
		color: shape.props.color,
		fromId: startBinding ? convertTldrawIdToSimpleId(startBinding.toId) : null,
		note: (shape.meta.note as string) ?? '',
		shapeId: convertTldrawIdToSimpleId(shape.id),
		text: (shape.meta.text as string) ?? '',
		toId: endBinding ? convertTldrawIdToSimpleId(endBinding.toId) : null,
		x1: shape.props.start.x + bounds.x,
		x2: shape.props.end.x + bounds.x,
		y1: shape.props.start.y + bounds.y,
		y2: shape.props.end.y + bounds.y,
	}
}

function convertNoteShapeToFocused(editor: Editor, shape: TLNoteShape): FocusedNoteShape {
	const util = editor.getShapeUtil(shape)
	const text = util.getText(shape)
	const bounds = getSimpleBounds(editor, shape)
	return {
		_type: 'note',
		color: shape.props.color,
		note: (shape.meta.note as string) ?? '',
		shapeId: convertTldrawIdToSimpleId(shape.id),
		text: text ?? '',
		x: bounds.x,
		y: bounds.y,
	}
}

/**
 * Shapes the format does not know can still be described to the agent in a
 * line, such as an equation's LaTeX or a graph's functions and parameter
 * values. The client registers a describer for each of its own shape types.
 */
const shapeDescribers = new Map<string, (shape: TLShape) => string>()

export function registerShapeDescriber(type: string, describe: (shape: TLShape) => string) {
	shapeDescribers.set(type, describe)
}

/**
 * The note to save on a shape the agent changed, without the description the
 * agent was shown. The description is rebuilt from the shape each time it is
 * read, so a saved copy would repeat and go stale.
 */
export function stripShapeDescription(shape: Partial<TLShape>, note: string): string {
	if (!shape.type || !shape.props) return note
	const described = shapeDescribers.get(shape.type)?.(shape as TLShape)
	if (!described || !note.startsWith(described)) return note
	return note.slice(described.length).trim()
}

function convertUnknownShapeToFocused(editor: Editor, shape: TLShape): FocusedUnknownShape {
	const bounds = getSimpleBounds(editor, shape)
	const described = shapeDescribers.get(shape.type)?.(shape)
	const note = (shape.meta.note as string) ?? ''
	return {
		_type: 'unknown',
		note: described ? (note ? `${described} ${note}` : described) : note,
		shapeId: convertTldrawIdToSimpleId(shape.id),
		subType: shape.type,
		x: bounds.x,
		y: bounds.y,
	}
}

function getSimpleBounds(editor: Editor, shape: TLShape): Box {
	// Compute page position from the shape record's own x/y, not the editor's cached bounds.
	// This is critical for diffing historical shape records where the editor's
	// current state differs from the shape record being converted.
	const pagePoint = getShapePagePoint(editor, shape)

	// Try to get dimensions from shape props first
	const props = shape.props as { w?: number; h?: number }
	if (props.w !== undefined && props.h !== undefined) {
		return new Box(pagePoint.x, pagePoint.y, props.w, props.h)
	}

	// Fall back to editor bounds for dimensions only (position comes from shape record)
	const bounds = editor.getShapePageBounds(shape)
	if (bounds) {
		return new Box(pagePoint.x, pagePoint.y, bounds.w, bounds.h)
	}

	// The shape is not on the board, for example a shape from an earlier diff.
	// Measure its geometry directly. Creating a stand-in shape on the board would
	// write to the store, and every store write is a board command.
	let size = { w: 0, h: 0 }
	// A text shape measures itself through a cache of shapes on the board, which
	// throws for one that is not there, so measure its words directly.
	if (shape.type === 'text') return new Box(pagePoint.x, pagePoint.y, ...measureTextOffBoard(editor, shape as TLTextShape))
	try {
		const local = editor.getShapeUtil(shape).getGeometry(shape).bounds
		const corners = Mat.applyToPoints(Mat.Rotate(shape.rotation), local.corners)
		const rotated = Box.FromPoints(corners)
		size = { w: rotated.w, h: rotated.h }
	} catch (error) {
		console.warn('Could not measure a shape that is not on the board.', shape.id, error)
	}
	return new Box(pagePoint.x, pagePoint.y, size.w, size.h)
}

/** tldraw's text sizes, in px at scale 1. */
const TEXT_SIZES: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 }

/** A text shape's size from its words and style, for a shape that is not on the board. */
function measureTextOffBoard(editor: Editor, shape: TLTextShape): [number, number] {
	const { size, scale, autoSize, w } = shape.props
	const fontSize = (TEXT_SIZES[size] ?? 24) * (scale || 1)
	try {
		const text = renderPlaintextFromRichText(editor, shape.props.richText) || ' '
		const measured = editor.textMeasure.measureText(text, {
			fontFamily: "'Source Serif 4 Variable', Georgia, serif",
			fontSize,
			fontWeight: 'normal',
			fontStyle: 'normal',
			lineHeight: 1.35,
			maxWidth: autoSize ? null : Math.max(1, w),
			padding: '0px',
		})
		return [autoSize ? measured.w : Math.max(w, 1), measured.h]
	} catch {
		return [Math.max(w, 1), fontSize * 1.35]
	}
}

/**
 * Get the page-space position of a shape from its record's x/y values.
 * For shapes at the root level, this is just shape.x/y.
 * For shapes inside frames/groups, we transform through the parent's page transform.
 */
function getShapePagePoint(editor: Editor, shape: TLShape): Vec {
	// If the shape is at the root level (parent is a page), use x/y directly
	if (isPageId(shape.parentId)) {
		return new Vec(shape.x, shape.y)
	}

	// For shapes inside parents, get the parent's page transform and apply it
	// Note: We use the editor's current parent transform, which is correct as long
	// as the parent itself hasn't moved in the same diff (uncommon case)
	const parentTransform = editor.getShapePageTransform(shape.parentId)
	return parentTransform.applyToPoint(new Vec(shape.x, shape.y))
}
