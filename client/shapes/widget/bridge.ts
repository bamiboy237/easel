import z from 'zod'

/**
 * Messages from a widget's frame. Each one is checked against this schema and
 * against size and rate caps before the host acts on it, because the frame runs
 * code the model wrote.
 */

/** The largest message, in characters of JSON, except a snapshot. */
export const MAX_MESSAGE_CHARS = 16_000
/** The largest snapshot, in characters of its data URL. */
export const MAX_SNAPSHOT_CHARS = 4_000_000
/** The largest a widget's whole state may grow, in characters of JSON. */
export const MAX_STATE_CHARS = 32_000
/** Messages a frame may send per second, on average, and in a burst. */
export const RATE_PER_SECOND = 60
export const RATE_BURST = 120
/** Dropped messages within one window after which the host stops the frame. */
export const MAX_DROPPED = 600
/** The window for counting dropped messages, in milliseconds. */
const DROP_WINDOW_MS = 5000

const Name = z.string().min(1).max(64)

export const WidgetMessage = z.discriminatedUnion('type', [
	z.object({ type: z.literal('ready') }),
	z.object({ type: z.literal('heartbeat') }),
	// A durable change, which the runtime sends only from the user's own input.
	// seq numbers the input event; a discrete one (a click or a key) starts its own undo step.
	z.object({ type: z.literal('set-param'), name: Name, value: z.number().finite(), user: z.literal(true), seq: z.number().int(), discrete: z.boolean() }),
	z.object({ type: z.literal('set-state'), key: Name, value: z.json(), user: z.literal(true), seq: z.number().int(), discrete: z.boolean() }),
	// Board keys pressed inside the frame, which the board handles as its own.
	z.object({
		type: z.literal('key'),
		key: z.string().max(16),
		ctrl: z.boolean(),
		meta: z.boolean(),
		shift: z.boolean(),
		alt: z.boolean(),
	}),
	// A wheel the widget did not use, so the board pans or zooms.
	z.object({
		type: z.literal('wheel'),
		dx: z.number().finite(),
		dy: z.number().finite(),
		x: z.number().finite(),
		y: z.number().finite(),
		ctrl: z.boolean(),
		meta: z.boolean(),
		shift: z.boolean(),
		alt: z.boolean(),
	}),
	z.object({ type: z.literal('press') }),
	// A restored widget's clocks are waiting for the user, or have started.
	z.object({ type: z.literal('held') }),
	z.object({ type: z.literal('resumed') }),
	// The smoke test's report, from a hidden copy of a new widget.
	z.object({ type: z.literal('smoke'), tested: z.number().int().min(0), problems: z.array(z.string().max(400)).max(12), fatal: z.boolean() }),
	z.object({
		type: z.literal('snapshot'),
		id: z.string().max(64),
		dataUrl: z.string().max(MAX_SNAPSHOT_CHARS).regex(/^data:image\/(png|jpeg|webp);base64,/).nullable(),
	}),
	z.object({ type: z.literal('error'), kind: z.enum(['loop', 'script']), message: z.string().max(500) }),
])

export type WidgetMessage = z.infer<typeof WidgetMessage>

/** A token bucket: true when one more message fits the rate cap. */
export class RateLimiter {
	private tokens = RATE_BURST
	private last = performance.now()
	private windowStart = performance.now()
	/** Messages dropped in the current window. */
	dropped = 0

	take(): boolean {
		const now = performance.now()
		if (now - this.windowStart > DROP_WINDOW_MS) {
			this.windowStart = now
			this.dropped = 0
		}
		this.tokens = Math.min(RATE_BURST, this.tokens + ((now - this.last) / 1000) * RATE_PER_SECOND)
		this.last = now
		if (this.tokens < 1) {
			this.dropped++
			return false
		}
		this.tokens -= 1
		return true
	}
}

/**
 * Check one message from a frame: its size, then its shape. Returns the message
 * or the reason it was refused.
 */
export function readWidgetMessage(data: unknown): { message: WidgetMessage } | { refused: string } {
	let size: number
	try {
		size = JSON.stringify(data)?.length ?? 0
	} catch {
		return { refused: 'not JSON' }
	}
	const isSnapshot = (data as { type?: unknown } | null)?.type === 'snapshot'
	if (size > (isSnapshot ? MAX_SNAPSHOT_CHARS + 200 : MAX_MESSAGE_CHARS)) return { refused: `too large (${size} characters)` }
	const parsed = WidgetMessage.safeParse(data)
	if (!parsed.success) return { refused: parsed.error.issues[0]?.message ?? 'not a widget message' }
	return { message: parsed.data }
}
