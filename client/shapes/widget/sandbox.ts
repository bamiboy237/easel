import { parse } from 'acorn'
import serifItalic from '@fontsource-variable/source-serif-4/files/source-serif-4-latin-standard-italic.woff2?inline'
import serif from '@fontsource-variable/source-serif-4/files/source-serif-4-latin-standard-normal.woff2?inline'
import kitCss from './kit/kit.css?raw'
import kitJs from './kit/kit.js?raw'

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
	// The script runs inside a function, so its names (such as top or name)
	// never clash with the window's own. It must parse there too: a top-level
	// return or await is not allowed in a widget.
	try {
		parse(`(() => {\n${js}\n})()`, { ecmaVersion: 'latest', sourceType: 'script' })
	} catch (error) {
		return { error: `The script does not run inside a function: ${(error as Error).message}` }
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
export interface WidgetDocumentOptions {
	/** Build the document for the smoke test: it drives every control and reports what changed nothing. */
	smoke?: boolean
	/**
	 * Hold the widget's clocks: its timers and animation frames wait for the
	 * user's first press or key in the frame. For a widget restored from a saved
	 * board, so a game or a countdown does not restart by itself after a reload.
	 */
	holdClocks?: boolean
}

/** The board's serif, embedded, since the frame cannot load fonts. */
const FONT_FACES = `@font-face{font-family:'Easel Serif';font-style:normal;font-weight:200 900;src:url(${serif}) format('woff2')}@font-face{font-family:'Easel Serif';font-style:italic;font-weight:200 900;src:url(${serifItalic}) format('woff2')}`

export function buildWidgetDocument(source: WidgetSource, values: WidgetValues, options: WidgetDocumentOptions = {}): { doc: string } | { error: string } {
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
<style>${FONT_FACES}html,body{margin:0;padding:0;overflow:hidden}${sanitizeWidgetCss(kitCss)}</style>
<style>${sanitizeWidgetCss(source.css)}</style>
<script nonce="${nonce}">${scriptSafe(runtimeScript(values, !!options.smoke, !!options.holdClocks))}</script>
<script nonce="${nonce}">${HIDE_NONCE}${scriptSafe(kitJs)}</script>
</head><body>${sanitizeWidgetHtml(source.html)}
<script nonce="${nonce}">${HIDE_NONCE}(() => {
${scriptSafe(guarded.code)}
})()
</script>${options.smoke ? `<script nonce="${nonce}">${HIDE_NONCE}${scriptSafe(SMOKE_HARNESS)}</script>` : ''}</body></html>`
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

function runtimeScript(values: WidgetValues, smoke: boolean, holdClocks: boolean): string {
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
const SMOKE = ${smoke ? 'true' : 'false'};
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
const smokeErrors = [];
const report = (e) => {
	const message = String((e && e.message) || e).slice(0, 400);
	if (SMOKE) smokeErrors.push(message);
	post({ type: 'error', kind: 'script', message });
};
window.addEventListener('error', (e) => report(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => report(e.reason));
const copy = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Only real input makes a durable change: a change asked for while the browser
// dispatches a trusted input event is the user's, and goes to the board as a
// command. Everything else, such as a timer, an animation frame, or code
// running at start, changes the frame's own copy and never leaves it.
const INPUT = new Set(['pointerdown', 'pointerup', 'pointermove', 'click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'keydown', 'keyup', 'input', 'change', 'wheel', 'touchstart', 'touchmove', 'touchend', 'contextmenu']);
const fromUser = () => {
	const ev = window.event;
	if (!ev || !INPUT.has(ev.type)) return false;
	if ((ev.type === 'pointermove' || ev.type === 'mousemove') && !ev.buttons) return false;
	return SMOKE || ev.isTrusted === true;
};
// The frame's own changes, over the board's values, so a widget reads back
// what it just set. A durable change stays until the board confirms it; a
// transient one until the board's value for that key changes.
const overlay = { params: {}, state: {} };
let notifyQueued = false, notifyDepth = 0;
const notify = () => {
	if (notifyQueued) return;
	notifyQueued = true;
	queueMicrotask(() => {
		notifyQueued = false;
		// A render that keeps setting new values does not spin forever.
		if (++notifyDepth > 8) { later(() => { notifyDepth = 0 }, 0); return }
		later(() => { notifyDepth = 0 }, 0);
		for (const callback of listeners) { try { callback(easel) } catch (e) { report(e) } }
	});
};
const effective = (kind) => {
	const out = copy(values[kind] || {});
	for (const [k, e] of Object.entries(overlay[kind])) out[k] = copy(e.value);
	return out;
};
const setLocal = (kind, key, value) => {
	const user = fromUser();
	const current = Object.hasOwn(overlay[kind], key) ? overlay[kind][key].value : (values[kind] || {})[key];
	const changed = !same(current, value);
	overlay[kind][key] = { value, durable: user, at: clock() };
	if (user) post(kind === 'params' ? { type: 'set-param', name: key, value, user: true } : { type: 'set-state', key, value, user: true });
	if (changed) notify();
};
const receive = (next) => {
	const prev = values;
	values = next;
	const now = clock();
	for (const kind of ['params', 'state']) {
		for (const [k, e] of Object.entries(overlay[kind])) {
			const hostNow = (values[kind] || {})[k], hostBefore = (prev[kind] || {})[k];
			if (e.durable ? same(hostNow, e.value) || now - e.at > 1500 : !same(hostNow, hostBefore)) delete overlay[kind][k];
		}
	}
	for (const callback of listeners) { try { callback(easel) } catch (e) { report(e) } }
};
const easel = {
	get params() { return effective('params') },
	get state() { return effective('state') },
	onChange(callback) { if (typeof callback === 'function') listeners.push(callback) },
	setParam(name, value) { const v = Number(value); if (Number.isFinite(v)) setLocal('params', String(name), v) },
	setState(key, value) { setLocal('state', String(key), copy(value === undefined ? null : value)) },
	/** True while the code runs because of the user's own input. */
	get userInput() { return fromUser() },
	snapshot: null,
};
Object.defineProperty(window, 'easel', { value: easel, configurable: false, writable: false });
// Board keys work from inside the frame: undo, redo, Escape, and Delete go to
// the board unless the widget handled them or a text field has focus.
const editable = (t) => !!t && (t.isContentEditable || (t.tagName === 'INPUT' && !/^(range|button|checkbox|radio|submit|reset|color)$/i.test(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
window.addEventListener('keydown', (e) => {
	if (e.defaultPrevented || !e.isTrusted) return;
	const mod = e.ctrlKey || e.metaKey;
	const key = e.key;
	const boardKey = key === 'Escape' || (!editable(e.target) && ((mod && /^[zyZY]$/.test(key)) || key === 'Delete' || key === 'Backspace'));
	if (!boardKey) return;
	e.preventDefault();
	post({ type: 'key', key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey });
});
// A wheel the widget does not use pans and zooms the board, as anywhere else.
window.addEventListener('wheel', (e) => {
	if (e.defaultPrevented || !e.isTrusted) return;
	e.preventDefault();
	const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
	post({ type: 'wheel', dx: e.deltaX * k, dy: e.deltaY * k, x: e.clientX, y: e.clientY, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey });
}, { passive: false });
// The board learns of a press, so it can select the widget, as a press on any shape does.
window.addEventListener('pointerdown', (e) => { if (e.isTrusted) post({ type: 'press' }) }, true);
if (SMOKE) {
	// The smoke test's events are not trusted, and have no real pointer to capture.
	const capture = Element.prototype.setPointerCapture;
	Element.prototype.setPointerCapture = function (id) { try { capture.call(this, id) } catch (e) {} };
	Object.defineProperty(window, '__easelSmoke', { value: { values: () => ({ params: effective('params'), state: effective('state') }), errors: smokeErrors, post }, configurable: false, writable: false });
}
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
		receive({ params: data.params || {}, state: data.state || {} });
	} else if (data.type === 'snapshot-request') {
		let dataUrl = null;
		try { dataUrl = typeof easel.snapshot === 'function' ? await easel.snapshot() : await defaultSnapshot() } catch (e) {}
		if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) { try { dataUrl = await defaultSnapshot() } catch (e) { dataUrl = null } }
		post({ type: 'snapshot', id: String(data.id), dataUrl });
	}
});
setInterval(() => post({ type: 'heartbeat' }), 500);
window.addEventListener('DOMContentLoaded', () => post({ type: 'ready' }));
// After a reload, the widget's clocks wait for the user: its timers and
// animation frames are queued until the first press or key in the frame, or
// until the widget calls easel.resume() because it should run at once.
const HOLD = ${holdClocks ? 'true' : 'false'};
let holding = HOLD, toldHeld = false, nextFake = 1;
const real = { st: setTimeout.bind(window), si: setInterval.bind(window), raf: requestAnimationFrame.bind(window), ct: clearTimeout.bind(window), ci: clearInterval.bind(window), caf: cancelAnimationFrame.bind(window) };
const queued = new Map();
const ids = new Map();
const hold = (kind, fn, delay, args) => {
	if (!holding) return null;
	if (!toldHeld) { toldHeld = true; post({ type: 'held' }) }
	const id = 1e9 + nextFake++;
	queued.set(id, { kind, fn, delay, args });
	return id;
};
const release = () => {
	if (!holding) return;
	holding = false;
	post({ type: 'resumed' });
	for (const [id, q] of queued) {
		if (q.kind === 'raf') ids.set(id, real.raf(q.fn));
		else if (q.kind === 'interval') ids.set(id, real.si(q.fn, q.delay, ...q.args));
		else ids.set(id, real.st(q.fn, q.delay, ...q.args));
	}
	queued.clear();
};
if (HOLD) {
	window.setTimeout = (fn, delay, ...args) => hold('timeout', fn, delay, args) ?? real.st(fn, delay, ...args);
	window.setInterval = (fn, delay, ...args) => hold('interval', fn, delay, args) ?? real.si(fn, delay, ...args);
	window.requestAnimationFrame = (fn) => hold('raf', fn, 0, []) ?? real.raf(fn);
	const clear = (fallback) => (id) => { if (queued.delete(id)) return; if (ids.has(id)) { const r = ids.get(id); ids.delete(id); real.ct(r); real.ci(r); real.caf(r); return } fallback(id) };
	window.clearTimeout = clear(real.ct);
	window.clearInterval = clear(real.ci);
	window.cancelAnimationFrame = clear(real.caf);
	for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, (e) => { if (e.isTrusted) release() }, true);
}
lock(easel, 'resume', { value: release, writable: false });
})();`
}

/**
 * The smoke test, run in a hidden copy of a new widget before it is shown:
 * it waits for the widget to start, then drives every visible button, slider,
 * number field, and drag handle, and reports each one that changed nothing:
 * no state, no text, and no drawing. Its events are synthetic, so the runtime
 * treats every input event as the user's while it runs.
 */
const SMOKE_HARNESS = `(() => {
const hook = window.__easelSmoke;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 };
const fingerprint = () => {
	let s = JSON.stringify(hook.values()) + '|' + document.body.innerHTML;
	for (const c of document.querySelectorAll('canvas')) { try { s += '|' + hash(c.toDataURL()) } catch (e) {} }
	for (const i of document.querySelectorAll('input, select, textarea')) s += '|' + i.value + (i.checked ? '1' : '0');
	return hash(s);
};
const shown = (el) => {
	const r = el.getBoundingClientRect();
	if (r.width <= 0 || r.height <= 0) return false;
	const cs = getComputedStyle(el);
	return cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]');
};
const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('data-handle') || el.textContent || el.id || el.getAttribute('title') || el.tagName.toLowerCase()).trim().replace(/\\s+/g, ' ').slice(0, 40);
const center = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] };
const fire = (el, type, x, y, extra) => {
	const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: /down|move/.test(type) ? 1 : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window, ...extra };
	const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
	el.dispatchEvent(new Ctor(type, init));
};
const press = async (el, holdMs) => {
	const [x, y] = center(el);
	fire(el, 'pointerdown', x, y); fire(el, 'mousedown', x, y);
	await wait(holdMs);
	fire(el, 'pointerup', x, y); fire(el, 'mouseup', x, y); fire(el, 'click', x, y);
};
const drag = async (el) => {
	const [x, y] = center(el);
	const box = (el.ownerSVGElement || el.parentElement || document.body).getBoundingClientRect();
	let tx = box.left + box.width / 2, ty = box.top + box.height / 2;
	if (Math.hypot(tx - x, ty - y) < 30) { tx = x + 40; ty = y - 30 }
	else { const d = Math.hypot(tx - x, ty - y); tx = x + (tx - x) / d * Math.min(60, d); ty = y + (ty - y) / d * Math.min(60, d) }
	fire(el, 'pointerdown', x, y); fire(el, 'mousedown', x, y);
	for (let i = 1; i <= 6; i++) {
		const px = x + (tx - x) * i / 6, py = y + (ty - y) * i / 6;
		fire(el, 'pointermove', px, py); fire(el, 'mousemove', px, py);
		await wait(16);
	}
	fire(el, 'pointerup', tx, ty); fire(el, 'mouseup', tx, ty);
};
const setValue = (input, value) => {
	input.value = String(value);
	input.dispatchEvent(new Event('input', { bubbles: true }));
	input.dispatchEvent(new Event('change', { bubbles: true }));
};
const run = async () => {
	await wait(500);
	await frames();
	const problems = [];
	const startErrors = hook.errors.length;
	if (startErrors) problems.push('The script threw an error as it started: ' + hook.errors[0]);
	// Everything must fit the frame: text cut off at an edge cannot be read.
	const fits = () => {
		const W = innerWidth, H = innerHeight;
		const cut = [];
		for (const el of document.body.querySelectorAll('p, span, div, label, li, button, h2, h3, td, th, svg, canvas')) {
			if (!shown(el)) continue;
			if (el.tagName !== 'svg' && el.tagName !== 'CANVAS' && !el.childNodes.length) continue;
			if ([...el.childNodes].some((n) => n.nodeType === 1 && n.tagName !== 'BR' && n.tagName !== 'SUB' && n.tagName !== 'SUP' && n.tagName !== 'VAR' && n.tagName !== 'B' && n.tagName !== 'I' && n.tagName !== 'STRONG' && n.tagName !== 'EM')) continue;
			const r = el.getBoundingClientRect();
			if (r.bottom > H + 2 || r.right > W + 2) cut.push(Math.round(Math.max(r.bottom - H, r.right - W)) + ' px: "' + (el.textContent || el.tagName).trim().slice(0, 40) + '"');
		}
		return cut;
	};
	const cut = fits();
	if (cut.length) problems.push('Content runs past the edge of the frame and is cut off, so make the layout fit the given size: ' + cut.slice(0, 3).join('; ') + '.');
	const buttons = [...document.querySelectorAll('button, [role=button], input[type=button], input[type=submit], input[type=checkbox], input[type=radio]')].filter((b) => shown(b) && !b.disabled);
	const ranges = [...document.querySelectorAll('input[type=range]')].filter((r) => shown(r) && !r.disabled);
	const numbers = [...document.querySelectorAll('input[type=number]')].filter((r) => shown(r) && !r.disabled);
	const marked = [...document.querySelectorAll('[data-handle]')].filter(shown);
	const grabbable = [];
	const all = document.body.querySelectorAll('*');
	for (let i = 0; i < all.length && i < 3000; i++) {
		const el = all[i];
		if (el.closest('button, input, [data-handle], label, a') || marked.some((m) => m.contains(el))) continue;
		const isCanvas = el.tagName === 'CANVAS';
		const cursor = getComputedStyle(el).cursor;
		if (!isCanvas && !/^(grab|grabbing|move|crosshair|pointer|ew-resize|ns-resize|col-resize|row-resize)$/.test(cursor)) continue;
		if (!shown(el)) continue;
		if (grabbable.some((g) => g.contains(el))) continue;
		grabbable.push(el);
	}
	const handles = marked.concat(grabbable.filter((g) => !marked.some((m) => g.contains(m)))).slice(0, 12);
	const controls = [];
	for (const b of buttons.slice(0, 24)) controls.push({ kind: 'button', el: b, act: () => press(b, 260) });
	for (const r of ranges.slice(0, 12)) controls.push({ kind: 'slider', el: r, act: () => { const lo = Number(r.min || 0), hi = Number(r.max || 100), v = Number(r.value); setValue(r, v > (lo + hi) / 2 ? lo + (hi - lo) * 0.2 : lo + (hi - lo) * 0.8) } });
	for (const n of numbers.slice(0, 12)) controls.push({ kind: 'number field', el: n, act: () => { setValue(n, (Number(n.value) || 0) + (Number(n.step) || 1)); n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) } });
	for (const h of handles) controls.push({ kind: 'drag handle', el: h, act: () => drag(h) });
	const dead = [];
	let stillDead = 0;
	for (const c of controls) {
		const before = fingerprint();
		try { await c.act() } catch (e) { problems.push('Using the ' + c.kind + ' "' + name(c.el) + '" threw: ' + String(e && e.message || e).slice(0, 200)); continue }
		await frames(); await wait(120);
		if (fingerprint() === before) dead.push(c);
	}
	// A control that did nothing at first, such as Reset at rest, gets a second try now that other controls have changed things.
	for (const c of dead) {
		if (!c.el.isConnected || !shown(c.el) || c.el.disabled) continue;
		const before = fingerprint();
		try { await c.act() } catch (e) {}
		await frames(); await wait(120);
		if (fingerprint() !== before) continue;
		stillDead++;
		problems.push('Using the ' + c.kind + ' "' + name(c.el) + '" changed nothing: no state, text, or drawing changed.');
	}
	for (const e of hook.errors.slice(startErrors, startErrors + 2)) problems.push('The script threw an error while its controls were used: ' + e);
	const fatal = startErrors > 0 || (controls.length > 0 && stillDead === controls.length);
	hook.post({ type: 'smoke', tested: controls.length, problems: [...new Set(problems)].slice(0, 12), fatal });
};
if (document.readyState === 'complete') run(); else window.addEventListener('load', run);
})();`
