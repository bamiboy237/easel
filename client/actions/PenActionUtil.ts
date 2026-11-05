import { b64Vecs, TLDrawShapeSegment, TLShapeId, Vec, VecModel } from 'tldraw'
import { asColor } from '../../shared/format/FocusedColor'
import { convertFocusedFillToTldrawFill } from '../../shared/format/FocusedFill'
import { PenAction } from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { AgentHelpers } from '../AgentHelpers'
import { AgentActionUtil, registerActionUtil } from './AgentActionUtil'

export const PenActionUtil = registerActionUtil(
	class PenActionUtil extends AgentActionUtil<PenAction> {
		static override type = 'pen' as const

		override getInfo(action: Streaming<PenAction>) {
			return {
				icon: 'pencil' as const,
				description: action.intent ?? '',
			}
		}

		override sanitizeAction(action: Streaming<PenAction>, helpers: AgentHelpers) {
			if (!action.points) return action

			// Ensure the shape has a unique ID
			action.shapeId = helpers.ensureShapeIdIsUnique(action.shapeId)

			// Don't include the final point if we're still streaming.
			// Its numbers might be incomplete.
			const points = action.complete ? action.points : action.points.slice(0, -1)

			// This is a complex action for the model, so validate the data it gives us
			const validPoints = points
				.map((point) => helpers.ensureValueIsVec(point))
				.filter((v) => v !== null)

			action.points = validPoints
			action.closed = helpers.ensureValueIsBoolean(action.closed) ?? false
			action.fill = helpers.ensureValueIsFocusedFill(action.fill) ?? 'none'

			return action
		}

		override applyAction(action: Streaming<PenAction>, helpers: AgentHelpers) {
			if (!action.points) return
			if (action.points.length === 0) return

			if (!action.shapeId) return
			const shapeId = `shape:${action.shapeId}` as TLShapeId

			action.points = action.points.map((point) => helpers.removeOffsetFromVec(point))

			if (action.closed) {
				const firstPoint = action.points[0]
				action.points.push(firstPoint)
			}

			const minX = Math.min(...action.points.map((p) => p.x))
			const minY = Math.min(...action.points.map((p) => p.y))

			const points: VecModel[] =
				action.style === 'smooth' && action.points.length >= 3
					? // A smooth line curves through every point instead of running straight
						// between them, so a wheel drawn with a dozen points reads as round.
						smoothThrough(action.closed ? action.points.slice(0, -1) : action.points, !!action.closed)
					: straightThrough(action.points, action.style === 'smooth' ? 10 : 2)

			// Require at least 2 points to draw a line
			if (points.length <= 1) {
				return
			}

			const segmentPoints = points.map((point) => ({
				x: point.x - minX,
				y: point.y - minY,
				z: 0.75,
			}))
			const base64Points = b64Vecs.encodePoints(segmentPoints)

			const segments: TLDrawShapeSegment[] = [
				{
					type: 'free',
					path: base64Points,
				},
			]

			this.editor.createShape({
				id: shapeId,
				type: 'draw',
				x: minX,
				y: minY,
				isLocked: !action.complete,
				props: {
					color: asColor(action.color ?? 'black'),
					fill: convertFocusedFillToTldrawFill(action.fill ?? 'none'),
					dash: 'draw',
					size: 's',
					segments,
					isComplete: action.complete,
					isClosed: action.closed,
					isPen: true,
				},
			})
		}
	}
)

/** Points along straight lines between the given points, at most `step` apart. */
function straightThrough(input: VecModel[], step: number): VecModel[] {
	const points: VecModel[] = []
	for (let i = 0; i < input.length - 1; i++) {
		const point = input[i]
		const next = input[i + 1]
		points.push(point)
		const count = Math.floor(Vec.Dist(point, next) / step)
		for (let j = 0; j < count; j++) points.push(Vec.Lrp(point, next, (j + 1) / (count + 1)))
	}
	if (input.length) points.push(input[input.length - 1])
	return points
}

/**
 * Points along a centripetal Catmull-Rom spline through the given points, about
 * 6 px apart. The centripetal form never loops or overshoots at sharp turns or
 * uneven spacing (Yuksel, Schaefer, and Keyser, "Parameterization and
 * applications of Catmull-Rom curves", 2011). A closed line wraps around, so it
 * has no corner where it joins.
 */
function smoothThrough(input: VecModel[], closed: boolean): VecModel[] {
	const n = input.length
	const at = (i: number) => {
		if (closed) return input[((i % n) + n) % n]
		// Past an open end, mirror the neighbor so the end tangent follows the line.
		if (i < 0) return Vec.Sub(Vec.Mul(input[0], 2), input[1])
		if (i >= n) return Vec.Sub(Vec.Mul(input[n - 1], 2), input[n - 2])
		return input[i]
	}
	const points: VecModel[] = []
	const segments = closed ? n : n - 1
	for (let i = 0; i < segments; i++) {
		const p0 = at(i - 1)
		const p1 = at(i)
		const p2 = at(i + 1)
		const p3 = at(i + 2)
		// Knot spacing by the square root of the distance: the centripetal parameterization.
		const t0 = 0
		const t1 = t0 + Math.max(Math.sqrt(Vec.Dist(p0, p1)), 1e-3)
		const t2 = t1 + Math.max(Math.sqrt(Vec.Dist(p1, p2)), 1e-3)
		const t3 = t2 + Math.max(Math.sqrt(Vec.Dist(p2, p3)), 1e-3)
		const steps = Math.max(1, Math.ceil(Vec.Dist(p1, p2) / 6))
		for (let s = 0; s < steps; s++) {
			const t = t1 + ((t2 - t1) * s) / steps
			const a1 = Vec.Lrp(p0, p1, (t - t0) / (t1 - t0))
			const a2 = Vec.Lrp(p1, p2, (t - t1) / (t2 - t1))
			const a3 = Vec.Lrp(p2, p3, (t - t2) / (t3 - t2))
			const b1 = Vec.Lrp(a1, a2, (t - t0) / (t2 - t0))
			const b2 = Vec.Lrp(a2, a3, (t - t1) / (t3 - t1))
			points.push(Vec.Lrp(b1, b2, (t - t1) / (t2 - t1)))
		}
	}
	points.push(closed ? input[0] : input[n - 1])
	return points
}
