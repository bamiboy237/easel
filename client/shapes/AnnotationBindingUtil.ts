import {
	BindingOnShapeChangeOptions,
	BindingOnShapeDeleteOptions,
	BindingUtil,
	Box,
	Editor,
	RecordProps,
	T,
	TLBinding,
	TLShapeId,
} from 'tldraw'
import { THREAD_TYPE, ThreadShape } from './ThreadShapeUtil'

export const ANNOTATION_BINDING = 'annotation'

export interface AnnotationBindingProps {
	/**
	 * The one binding that moves its annotation. A mark or thread with several
	 * targets follows only its first, so it moves once per change.
	 */
	leads: boolean
}

declare module 'tldraw' {
	export interface TLGlobalBindingPropsMap {
		[ANNOTATION_BINDING]: AnnotationBindingProps
	}
}

export type AnnotationBinding = TLBinding<typeof ANNOTATION_BINDING>

/**
 * Binds a mark's stroke, or its thread, to each shape the mark points at.
 * Moving or resizing the target moves the annotation with it, keeping its
 * place relative to the target. Deleting the last target leaves the thread
 * on the board, marked as detached.
 */
export class AnnotationBindingUtil extends BindingUtil<AnnotationBinding> {
	static override type = ANNOTATION_BINDING
	static override props: RecordProps<AnnotationBinding> = { leads: T.boolean }

	override getDefaultProps(): AnnotationBindingProps {
		return { leads: false }
	}

	override onAfterChangeToShape({ binding, shapeBefore, shapeAfter }: BindingOnShapeChangeOptions<AnnotationBinding>) {
		if (!binding.props.leads) return
		const { editor } = this
		const annotation = editor.getShape(binding.fromId)
		if (!annotation) return
		// When the user moves the annotation along with its target, it already moved.
		if (editor.getSelectedShapeIds().includes(annotation.id)) return

		// Measure both versions fresh: the geometry cache already holds the new one.
		const util = editor.getShapeUtil(shapeAfter)
		const before = util.getGeometry(shapeBefore).bounds
		const after = util.getGeometry(shapeAfter).bounds
		const from = Box.From({ x: shapeBefore.x + before.x, y: shapeBefore.y + before.y, w: before.w, h: before.h })
		const to = Box.From({ x: shapeAfter.x + after.x, y: shapeAfter.y + after.y, w: after.w, h: after.h })
		if (from.x === to.x && from.y === to.y && from.w === to.w && from.h === to.h) return

		const bounds = editor.getShapePageBounds(annotation)
		if (!bounds) return
		if (annotation.type === THREAD_TYPE) {
			// A thread sits beside its target: it keeps its offset from the target's top right.
			const dx = to.maxX - from.maxX
			const dy = to.y - from.y
			editor.updateShape({ id: annotation.id, type: annotation.type, x: annotation.x + dx, y: annotation.y + dy })
			return
		}
		// A mark sits on its target: it keeps its place within the target, and
		// grows or shrinks with it, so a circle still circles a resized graph.
		const sx = from.w ? to.w / from.w : 1
		const sy = from.h ? to.h / from.h : 1
		if (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001) {
			editor.resizeShape(annotation.id, { x: sx, y: sy }, { scaleOrigin: { x: bounds.x, y: bounds.y } })
		}
		const target = { x: to.x + (bounds.x - from.x) * sx, y: to.y + (bounds.y - from.y) * sy }
		const now = editor.getShapePageBounds(annotation.id)
		const current = editor.getShape(annotation.id)
		if (!now || !current) return
		editor.updateShape({ id: current.id, type: current.type, x: current.x + target.x - now.x, y: current.y + target.y - now.y })
	}

	override onBeforeDeleteToShape({ binding, shape }: BindingOnShapeDeleteOptions<AnnotationBinding>) {
		const { editor } = this
		const annotation = editor.getShape(binding.fromId)
		if (!annotation) return
		// The next remaining target takes over moving the annotation.
		const others = editor
			.getBindingsFromShape<AnnotationBinding>(annotation.id, ANNOTATION_BINDING)
			.filter((b) => b.id !== binding.id && b.toId !== shape.id && editor.getShape(b.toId))
		if (binding.props.leads && others[0]) {
			editor.updateBinding<AnnotationBinding>({ id: others[0].id, type: ANNOTATION_BINDING, props: { leads: true } })
		}
		if (others.length === 0 && annotation.type === THREAD_TYPE) {
			editor.updateShape<ThreadShape>({ id: annotation.id, type: THREAD_TYPE, props: { detached: true } })
		}
	}
}

/** Bind an annotation to its targets; the first target leads. */
export function bindAnnotation(editor: Editor, annotationId: TLShapeId, targetIds: TLShapeId[]) {
	targetIds
		.filter((id) => editor.getShape(id))
		.forEach((toId, i) => {
			editor.createBinding<AnnotationBinding>({
				type: ANNOTATION_BINDING,
				fromId: annotationId,
				toId,
				props: { leads: i === 0 },
			})
		})
}
