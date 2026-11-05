import { parse } from 'acorn'

/**
 * The sandbox for generated widgets. A widget is HTML, CSS, and JavaScript the
 * model wrote, so the board treats it as untrusted:
 *
 * - The frame has an opaque origin (`allow-scripts` without
 *   `allow-same-origin`), so it cannot reach the board page, its storage, or
 *   its cookies.
 * - A strict CSP blocks every network request, and lets only the scripts this
 *   file adds run: no inline handlers, no `eval`, no script tags from the model.
 * - The HTML loses every element and attribute that could load or navigate.
 * - Loops are instrumented, so a loop that runs too long throws instead of
 *   freezing the board, even where the frame shares the board's thread.
 */

/** The longest a widget's script may run in one task before it is stopped, in milliseconds. */
export const LOOP_BUDGET_MS = 1000

/** The name of the loop guard inside the frame. It cannot clash with the widget's names. */
const GUARD = '__easelLoopGuard'

type AstNode = { type: string; start: number; end: number; [key: string]: unknown }

const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'])

/**
 * Add a guard call at the start of every loop body. The guard throws once one
 * task has run longer than the budget, so a runaway loop ends with an error.
 * Returns the code, or the parse error to give back to the model.
 */
export function guardLoops(js: string): { code: string } | { error: string } {
	let ast: AstNode
	try {
		ast = parse(js, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as AstNode
	} catch (error) {
		return { error: `The script does not parse: ${(error as Error).message}` }
	}
	const edits: { at: number; text: string }[] = []
	const visit = (node: unknown) => {
		if (Array.isArray(node)) {
			node.forEach(visit)
			return
		}
		if (!node || typeof node !== 'object' || typeof (node as AstNode).type !== 'string') return
		const n = node as AstNode
		if (LOOPS.has(n.type)) {
			const body = n.body as AstNode
			if (body.type === 'BlockStatement') {
				edits.push({ at: body.start + 1, text: `${GUARD}();` })
			} else {
				// A body without braces gets them, so the guard and the body stay one statement.
				edits.push({ at: body.start, text: `{${GUARD}();` })
				edits.push({ at: body.end, text: '}' })
			}
		}
		for (const [key, value] of Object.entries(n)) {
			if (key === 'type' || key === 'start' || key === 'end') continue
			if (value && typeof value === 'object') visit(value)
		}
	}
	visit(ast)
	edits.sort((a, b) => b.at - a.at)
	let code = js
	for (const edit of edits) code = code.slice(0, edit.at) + edit.text + code.slice(edit.at)
	return { code }
}

/** Elements a widget's HTML may not hold: they run code, load from the network, or navigate. */
const BLOCKED_ELEMENTS = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'meta', 'base', 'form', 'portal', 'applet']

/** Attributes that load or navigate, which may only point inside the widget. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'background', 'ping', 'xlink:href', 'data'])

function isInsideUrl(value: string): boolean {
	const v = value.trim().toLowerCase()
	return v === '' || v.startsWith('#') || v.startsWith('data:image/') || v.startsWith('blob:')
}

/** The widget's HTML without anything that runs code, loads, or navigates. */
export function sanitizeWidgetHtml(html: string): string {
	const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
	for (const el of doc.body.querySelectorAll(BLOCKED_ELEMENTS.join(','))) el.remove()
	for (const el of doc.body.querySelectorAll('*')) {
		for (const attr of [...el.attributes]) {
			const name = attr.name.toLowerCase()
			if (name.startsWith('on')) el.removeAttribute(attr.name)
			else if (URL_ATTRIBUTES.has(name) && !isInsideUrl(attr.value)) el.removeAttribute(attr.name)
			else if (name === 'target') el.removeAttribute(attr.name)
		}
	}
	return doc.body.innerHTML
}

/** CSS without imports, so a style sheet cannot load another from the network. */
export function sanitizeWidgetCss(css: string): string {
	return css.replace(/@import[^;]*;?/gi, '').replace(/<\/style/gi, '')
}

/** Text safe to put inside a script element. */
function scriptSafe(text: string): string {
	return text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}

export interface WidgetSource {
	html: string
	css: string
	js: string
}

export interface WidgetValues {
	params: Record<string, number>
	state: Record<string, unknown>
}

/**
 * The frame's document: the CSP, the runtime, then the widget. The runtime
 * holds the values at build time, so the widget can read them as it starts.
 */
export function buildWidgetDocument(source: WidgetSource, values: WidgetValues): { doc: string } | { error: string } {
	const guarded = guardLoops(source.js)
	if ('error' in guarded) return guarded
	const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
	const csp = [
		"default-src 'none'",
		`script-src 'nonce-${nonce}'`,
		"style-src 'unsafe-inline'",
		'img-src data: blob:',
		'font-src data:',
		'media-src data: blob:',
		"connect-src 'none'",
		"worker-src 'none'",
		"frame-src 'none'",
		"form-action 'none'",
		"base-uri 'none'",
	].join('; ')
	const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{margin:0;padding:0;overflow:hidden;font-family:'Inter',system-ui,sans-serif;background:#fffdf8;color:#302f2a}${sanitizeWidgetCss(source.css)}</style>
<script nonce="${nonce}">${scriptSafe(runtimeScript(values))}</script>
</head><body>${sanitizeWidgetHtml(source.html)}
<script nonce="${nonce}">${scriptSafe(guarded.code)}
</script></body></html>`
	return { doc }
}

/**
 * The runtime inside the frame: the `easel` object the widget uses, the loop
 * guard, the heartbeat the host watches, and snapshots. It talks to the host
 * only through postMessage.
 */
function runtimeScript(values: WidgetValues): string {
	return `(() => {
'use strict';
const host = window.parent;
const post = (message) => { try { host.postMessage(message, '*') } catch (e) {} };
// WebRTC can reach the network past the CSP, so the widget does not get it.
for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
	try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }) } catch (e) {}
}
let values = ${JSON.stringify(values).replace(/</g, '\\u003c')};
const listeners = [];
let started = 0, pending = false, stopped = false;
window.${GUARD} = () => {
	if (stopped) throw new Error('This widget was stopped.');
	const now = performance.now();
	if (!pending) { pending = true; started = now; setTimeout(() => { pending = false }, 0) }
	if (now - started > ${LOOP_BUDGET_MS}) {
		stopped = true;
		post({ type: 'error', kind: 'loop', message: 'A loop ran for more than ${LOOP_BUDGET_MS / 1000} second, so the widget was stopped.' });
		throw new Error('This widget was stopped: a loop ran too long.');
	}
};
window.__easelReport = (e) => post({ type: 'error', kind: 'script', message: String((e && e.message) || e).slice(0, 400) });
window.addEventListener('error', (e) => window.__easelReport(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => window.__easelReport(e.reason));
const copy = (v) => JSON.parse(JSON.stringify(v));
const easel = {
	get params() { return copy(values.params) },
	get state() { return copy(values.state) },
	onChange(callback) { if (typeof callback === 'function') listeners.push(callback) },
	setParam(name, value) { post({ type: 'set-param', name: String(name), value: Number(value) }) },
	setState(key, value) { post({ type: 'set-state', key: String(key), value: copy(value === undefined ? null : value) }) },
	snapshot: null,
};
Object.defineProperty(window, 'easel', { value: easel, configurable: false, writable: false });
async function defaultSnapshot() {
	const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
	const canvas = document.createElement('canvas');
	canvas.width = w; canvas.height = h;
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#fffdf8';
	ctx.fillRect(0, 0, w, h);
	try {
		const clone = document.documentElement.cloneNode(true);
		for (const s of clone.querySelectorAll('script')) s.remove();
		const xml = new XMLSerializer().serializeToString(clone);
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><foreignObject width="100%" height="100%">' + xml + '</foreignObject></svg>';
		const img = new Image();
		img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
		await img.decode();
		ctx.drawImage(img, 0, 0);
	} catch (e) {}
	// A foreignObject image leaves canvases blank, so they are drawn on top.
	for (const c of document.querySelectorAll('canvas')) {
		const r = c.getBoundingClientRect();
		try { ctx.drawImage(c, r.left, r.top, r.width, r.height) } catch (e) {}
	}
	return canvas.toDataURL('image/png');
}
window.addEventListener('message', async (event) => {
	if (event.source !== host) return;
	const data = event.data || {};
	if (data.type === 'values') {
		values = { params: data.params || {}, state: data.state || {} };
		for (const callback of listeners) { try { callback(easel) } catch (e) { window.__easelReport(e) } }
	} else if (data.type === 'snapshot-request') {
		let dataUrl = null;
		try { dataUrl = typeof easel.snapshot === 'function' ? await easel.snapshot() : await defaultSnapshot() } catch (e) {}
		if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) { try { dataUrl = await defaultSnapshot() } catch (e) { dataUrl = null } }
		post({ type: 'snapshot', id: String(data.id), dataUrl });
	}
});
setInterval(() => post({ type: 'heartbeat' }), 500);
window.addEventListener('DOMContentLoaded', () => post({ type: 'ready' }));
})();`
}
