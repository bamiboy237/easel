import { atom, Editor, OverlayUtil, TLOverlay, VecModel } from 'tldraw'
import { AiCursorFlight, getAiCursor } from '../agent/aiCursor'
import { getVoiceManager, VoiceMark } from '../voice/VoiceManager'

interface VoiceCursorOverlay extends TLOverlay {
	type: 'voice-cursor'
	props: { cursor: AiCursorFlight | null; marks: VoiceMark[] }
}

/** The board's accent ink, for the AI's cursor. */
const ACCENT = '#344c41'
/** A highlighter's warm yellow, laid over the ink. */
const HIGHLIGHTER = 'rgba(240, 196, 64, 0.42)'
const FADE_IN_MS = 180
const FADE_OUT_MS = 500
const PULSE_MS = 900

/**
 * The AI's cursor on the board, and the parts it highlights while it talks.
 * The cursor flies to each target along a curve; a highlight is a stroke of
 * yellow marker over the part, along a curve's own line when it has one.
 */
export class VoiceCursorOverlayUtil extends OverlayUtil<VoiceCursorOverlay> {
	static override type = 'voice-cursor' as const
	override options = { zIndex: 720 }

	private readonly $frame = atom('voice cursor frame', 0)
	private animating = false

	constructor(editor: Editor) {
		super(editor)
		editor.on('tick', this.handleTick)
	}

	override dispose() {
		this.editor.off('tick', this.handleTick)
	}

	private handleTick = () => {
		if (this.animating) this.$frame.update((n) => n + 1)
	}

	override isActive(): boolean {
		const voice = getVoiceManager(this.editor)
		return !!getAiCursor(this.editor).$cursor.get() || (!!voice && voice.$marks.get().length > 0)
	}

	override getOverlays(): VoiceCursorOverlay[] {
		const voice = getVoiceManager(this.editor)
		this.$frame.get()
		return [{ id: 'voice-cursor', type: 'voice-cursor', props: { cursor: getAiCursor(this.editor).$cursor.get(), marks: voice?.$marks.get() ?? [] } }]
	}

	override render(ctx: CanvasRenderingContext2D, overlays: VoiceCursorOverlay[]): void {
		const zoom = this.editor.getZoomLevel()
		const now = performance.now()
		let animating = false
		for (const { props } of overlays) {
			for (const mark of props.marks) {
				const fadeIn = Math.min(1, Math.max(0, (now - mark.startedAt) / FADE_IN_MS))
				const fadeOut = mark.fadingAt === null ? 1 : Math.max(0, 1 - (now - mark.fadingAt) / FADE_OUT_MS)
				const alpha = fadeIn * fadeOut
				if (fadeIn < 1 || (mark.fadingAt !== null && fadeOut > 0)) animating = true
				if (alpha <= 0) continue
				if (mark.highlight) this.renderHighlight(ctx, mark, alpha, zoom)
				else {
					const pulse = (now - mark.startedAt) / PULSE_MS
					if (pulse >= 0 && pulse < 1) {
						animating = true
						this.renderPulse(ctx, mark.target.anchor, pulse, zoom)
					} else if (pulse < 0) animating = true
				}
			}
			if (props.cursor) {
				const t = (now - props.cursor.startedAt) / props.cursor.duration
				if (t < 1) {
					animating = true
					this.renderTrail(ctx, props.cursor, t, zoom)
				}
				const at = getAiCursor(this.editor).position(now)
				if (at) this.renderCursor(ctx, at, zoom)
			}
		}
		this.animating = animating
	}

	private renderHighlight(ctx: CanvasRenderingContext2D, mark: VoiceMark, alpha: number, zoom: number) {
		const { target } = mark
		ctx.save()
		ctx.globalAlpha = alpha
		ctx.globalCompositeOperation = 'multiply'
		if (target.path && target.path.length > 1) {
			// A marker stroke along the curve itself.
			ctx.strokeStyle = HIGHLIGHTER
			ctx.lineWidth = Math.max(10, 14 / zoom)
			ctx.lineCap = 'round'
			ctx.lineJoin = 'round'
			ctx.beginPath()
			ctx.moveTo(target.path[0].x, target.path[0].y)
			for (const p of target.path.slice(1)) ctx.lineTo(p.x, p.y)
			ctx.stroke()
		} else {
			const b = target.bounds.clone().expandBy(4 / zoom)
			ctx.fillStyle = HIGHLIGHTER
			ctx.beginPath()
			ctx.roundRect(b.x, b.y, b.w, b.h, 6 / zoom)
			ctx.fill()
		}
		ctx.restore()
	}

	private renderPulse(ctx: CanvasRenderingContext2D, at: VecModel, t: number, zoom: number) {
		ctx.save()
		ctx.strokeStyle = ACCENT
		ctx.globalAlpha = 0.5 * (1 - t)
		ctx.lineWidth = 1.5 / zoom
		ctx.beginPath()
		ctx.arc(at.x, at.y, (8 + 22 * t) / zoom, 0, Math.PI * 2)
		ctx.stroke()
		ctx.restore()
	}

	/** A faint dotted line ahead of the cursor while it flies. */
	private renderTrail(ctx: CanvasRenderingContext2D, cursor: AiCursorFlight, t: number, zoom: number) {
		ctx.save()
		ctx.strokeStyle = ACCENT
		ctx.globalAlpha = 0.22 * (1 - Math.max(0, t))
		ctx.lineWidth = 1.25 / zoom
		ctx.setLineDash([2 / zoom, 5 / zoom])
		ctx.beginPath()
		ctx.moveTo(cursor.from.x, cursor.from.y)
		ctx.quadraticCurveTo(cursor.control.x, cursor.control.y, cursor.to.x, cursor.to.y)
		ctx.stroke()
		ctx.restore()
	}

	/** An arrow pointer in the accent ink, with a paper edge, the same size at any zoom. */
	private renderCursor(ctx: CanvasRenderingContext2D, at: VecModel, zoom: number) {
		const s = 1 / zoom
		ctx.save()
		ctx.translate(at.x, at.y)
		ctx.scale(s, s)
		ctx.shadowColor = 'rgba(60, 45, 20, 0.18)'
		ctx.shadowBlur = 4
		ctx.shadowOffsetY = 1
		ctx.beginPath()
		ctx.moveTo(0, 0)
		ctx.lineTo(0, 18)
		ctx.lineTo(4.6, 13.8)
		ctx.lineTo(8, 21)
		ctx.lineTo(11, 19.6)
		ctx.lineTo(7.7, 12.6)
		ctx.lineTo(13.6, 12.6)
		ctx.closePath()
		ctx.fillStyle = ACCENT
		ctx.fill()
		ctx.shadowColor = 'transparent'
		ctx.strokeStyle = '#fffefb'
		ctx.lineWidth = 1.5
		ctx.lineJoin = 'round'
		ctx.stroke()
		ctx.restore()
	}
}
