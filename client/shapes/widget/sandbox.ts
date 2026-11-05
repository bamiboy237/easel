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
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/** Names the widget's code may not use: the runtime's own globals start with this. */
const RESERVED_PREFIX = '__easel'

/**
 * Add a guard call at the start of every loop body and every function body.
 * The guard throws once one task has run longer than the budget, so a runaway
 * loop, recursion, or callback ends with an error. Returns the code, or the
 * problem to give back to the model.
 */
export function guardLoops(js: string): { code: string } | { error: string } {
	let ast: AstNode
	try {
		ast = parse(js, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as AstNode
	} catch (error) {
		return { error: `The script does not parse: ${(error as Error).message}` }
	}
	const edits: { at: number; text: string; close?: boolean; order?: number }[] = []
	let reserved: string | null = null
	// The guard goes after any directives, such as "use strict", so they still apply.
	const atBlockStart = (body: AstNode) => {
		const statements = (body.body as AstNode[]) ?? []
		const directives = statements.filter((st, i) => statements.slice(0, i + 1).every((d) => typeof d.directive === 'string'))
		const at = directives.length ? directives[directives.length - 1].end : body.start + 1
		edits.push({ at, text: `${GUARD}();` })
	}
	const visit = (node: unknown) => {
		if (Array.isArray(node)) {
			node.forEach(visit)
			return
		}
		if (!node || typeof node !== 'object' || typeof (node as AstNode).type !== 'string') return
		const n = node as AstNode
		// The guard is a global, so a name that could shadow it is refused.
		if (n.type === 'Identifier' && String(n.name).startsWith(RESERVED_PREFIX)) reserved = String(n.name)
		if (LOOPS.has(n.type)) {
			const body = n.body as AstNode
			if (body.type === 'BlockStatement') {
				atBlockStart(body)
			} else {
				// A body without braces gets them, so the guard and the body stay one statement.
				edits.push({ at: body.start, text: `{${GUARD}();` })
				edits.push({ at: body.end, text: '}', close: true })
			}
		}
		if (FUNCTIONS.has(n.type)) {
			const body = n.body as AstNode
			if (body.type === 'BlockStatement') {
				atBlockStart(body)
			} else {
				// An arrow with an expression body: (guard(), expression).
				edits.push({ at: body.start, text: `(${GUARD}(),` })
				edits.push({ at: body.end, text: ')', close: true })
			}
		}
		for (const [key, value] of Object.entries(n)) {
			if (key === 'type' || key === 'start' || key === 'end') continue
			if (value && typeof value === 'object') visit(value)
		}
	}
	visit(ast)
	if (reserved) return { error: `The script uses the name ${reserved}; names starting with ${RESERVED_PREFIX} are reserved.` }
	// Edits are applied from the end, so each keeps its position. Where several
	// land at one position, the text must read: closings of inner nodes first,
	// then outer closings, then openings of outer nodes, then inner openings.
	// An edit applied later lands before the earlier ones, and nodes are
	// visited outer first.
	edits.forEach((e, i) => (e.order = i))
	edits.sort((a, b) => {
		if (a.at !== b.at) return b.at - a.at
		if (!!a.close !== !!b.close) return a.close ? 1 : -1
		return a.close ? a.order! - b.order! : b.order! - a.order!
	})
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

/**
 * CSS that cannot load another style sheet or leave its style element: imports
 * are removed until none is left, and every < is written as a CSS escape.
 */
export function sanitizeWidgetCss(css: string): string {
	let out = css
	for (let previous = ''; previous !== out; ) {
		previous = out
		out = out.replace(/@import[^;]*;?/gi, '')
	}
	return out.replace(/</g, '\\3c ')
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
		// Blocks WebRTC where the browser supports it; elsewhere the runtime removes it.
		"webrtc 'block'",
	].join('; ')
	const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{margin:0;padding:0;overflow:hidden;font-family:'Inter',system-ui,sans-serif;background:#fffdf8;color:#302f2a}${sanitizeWidgetCss(source.css)}</style>
<script nonce="${nonce}">${scriptSafe(runtimeScript(values))}</script>
</head><body>${sanitizeWidgetHtml(source.html)}
<script nonce="${nonce}">${HIDE_NONCE}${scriptSafe(guarded.code)}
</script></body></html>`
	return { doc }
}

/**
 * The runtime inside the frame: the `easel` object the widget uses, the loop
 * guard, the heartbeat the host watches, and snapshots. It talks to the host
 * only through postMessage.
 */
/**
 * The first statement of each script: it clears the script's nonce, so the
 * widget cannot read it and add a script of its own that skips the guard.
 */
const HIDE_NONCE = "document.currentScript.removeAttribute('nonce');document.currentScript.nonce='';"

function runtimeScript(values: WidgetValues): string {
	return `${HIDE_NONCE}(() => {
'use strict';
// The guard keeps its own copies, so the widget cannot change the clock it reads.
const clock = performance.now.bind(performance);
const later = setTimeout.bind(window);
const Stop = Error;
const host = window.parent;
const send = host.postMessage.bind(host);
const post = (message) => { try { send(message, '*') } catch (e) {} };
const lock = (target, name, descriptor) => { try { Object.defineProperty(target, name, { configurable: false, ...descriptor }) } catch (e) {} };
// WebRTC can reach the network past the CSP, so the widget does not get it.
for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) {
	lock(window, name, { value: undefined, writable: false });
}
// A child frame would bring fresh copies of what was removed, so frames are
// unreachable from script and are removed as soon as they are added.
for (const type of [window.HTMLIFrameElement, window.HTMLFrameElement, window.HTMLObjectElement, window.HTMLEmbedElement]) {
	if (!type) continue;
	for (const name of ['contentWindow', 'contentDocument']) lock(type.prototype, name, { get() { return null } });
	lock(type.prototype, 'getSVGDocument', { value() { return null }, writable: false });
}
new MutationObserver((records) => {
	for (const r of records) for (const node of r.addedNodes) {
		if (node.nodeType !== 1) continue;
		if (/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(node.nodeName)) node.remove();
		else for (const el of node.querySelectorAll('iframe,frame,object,embed')) el.remove();
	}
}).observe(document, { childList: true, subtree: true });
let values = ${JSON.stringify(values).replace(/</g, '\\u003c')};
const listeners = [];
let started = 0, pending = false, stopped = false;
let calls = 0;
const guard = () => {
	if (stopped) throw new Stop('This widget was stopped.');
	// The clock is read once every 256 calls, so tight loops stay fast.
	if (pending && (++calls & 255) !== 0) return;
	const now = clock();
	if (!pending) { pending = true; started = now; later(() => { pending = false }, 0) }
	if (now - started > ${LOOP_BUDGET_MS}) {
		stopped = true;
		post({ type: 'error', kind: 'loop', message: 'Its code ran for more than ${LOOP_BUDGET_MS / 1000} second without a break, so the widget was stopped.' });
		throw new Stop('This widget was stopped: its code ran too long.');
	}
};
// The guard cannot be replaced or deleted.
lock(window, '${GUARD}', { value: guard, writable: false });
const report = (e) => post({ type: 'error', kind: 'script', message: String((e && e.message) || e).slice(0, 400) });
window.addEventListener('error', (e) => report(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => report(e.reason));
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
		for (const callback of listeners) { try { callback(easel) } catch (e) { report(e) } }
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
