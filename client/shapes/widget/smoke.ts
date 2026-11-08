import { readWidgetMessage } from './bridge'
import { buildWidgetDocument, WidgetSource, WidgetValues } from './sandbox'

/** The longest the smoke test may take, in milliseconds. */
const SMOKE_TIMEOUT_MS = 20_000

export interface SmokeResult {
	/** How many controls it drove. */
	tested: number
	/** What did not work, in words the writer can act on. */
	problems: string[]
	/** True when the widget does nothing at all: it threw as it started, or no control did anything. */
	fatal: boolean
}

/**
 * Run a new widget in a hidden frame, in the same sandbox as on the board, and
 * drive its controls: it must start with no script error, and each button,
 * slider, number field, and drag handle must change its state or its drawing.
 * Nothing it does reaches the board.
 */
export function smokeTestWidget(source: WidgetSource, values: WidgetValues, size: { width: number; height: number }): Promise<SmokeResult> {
	const built = buildWidgetDocument(source, values, { smoke: true })
	if ('error' in built) return Promise.resolve({ tested: 0, problems: [built.error], fatal: true })
	return new Promise((resolve) => {
		const frame = document.createElement('iframe')
		frame.setAttribute('sandbox', 'allow-scripts')
		frame.setAttribute('referrerpolicy', 'no-referrer')
		frame.setAttribute('allow', '')
		frame.setAttribute('aria-hidden', 'true')
		frame.tabIndex = -1
		// In the viewport, so the browser keeps its animation frames running, but unseen and out of reach.
		Object.assign(frame.style, {
			position: 'fixed',
			left: '0px',
			top: '0px',
			width: `${Math.round(size.width)}px`,
			height: `${Math.round(size.height)}px`,
			border: '0',
			opacity: '0',
			pointerEvents: 'none',
			zIndex: '-1',
		})
		let loopError: string | null = null
		const finish = (result: SmokeResult) => {
			clearTimeout(timer)
			window.removeEventListener('message', onMessage)
			frame.remove()
			resolve(result)
		}
		const onMessage = (event: MessageEvent) => {
			if (event.source !== frame.contentWindow) return
			const read = readWidgetMessage(event.data)
			if ('refused' in read) return
			const message = read.message
			if (message.type === 'error' && message.kind === 'loop') {
				loopError = message.message
				finish({ tested: 0, problems: [`Its code ran too long without a break: ${message.message}`], fatal: true })
			} else if (message.type === 'smoke') {
				finish({ tested: message.tested, problems: message.problems, fatal: message.fatal })
			}
		}
		const timer = setTimeout(
			() => finish({ tested: 0, problems: [loopError ?? 'It did not finish starting and using its controls within 20 seconds.'], fatal: false }),
			SMOKE_TIMEOUT_MS
		)
		window.addEventListener('message', onMessage)
		frame.srcdoc = built.doc
		document.body.appendChild(frame)
	})
}
