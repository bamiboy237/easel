#!/usr/bin/env node
/**
 * Checks Easel's controls against the Controls section of docs/design.md.
 *
 * It opens the reference board (which is never saved), adds a graph with
 * sliders, a scene with a player, and an animation on a fresh page at zoom 1,
 * and measures the controls in a real browser: computed styles, the rules in
 * paper.css, and pixels from screenshots. It also runs a stand-in animation
 * job and widget job through the app's own job records, to measure the
 * progress bar. It needs no model calls.
 *
 * Usage:
 *   npm run check:controls -- http://127.0.0.1:5192
 *   EASEL_URL=http://127.0.0.1:5192 npm run check:controls
 *
 * Set CHECK_CONTROLS_SCREENSHOT to a file path to save the test board as a PNG.
 *
 * Exits with 1 when any hard rule fails. Known gaps are printed as GAP lines
 * and do not fail the check.
 */
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** Playwright from the project, or the copy installed globally in this container. */
function loadPlaywright() {
	try {
		return require('playwright')
	} catch {
		const root = execSync('npm root -g').toString().trim()
		return require(path.join(root, 'playwright'))
	}
}

const baseUrl = (process.argv[2] || process.env.EASEL_URL || '').replace(/\/$/, '')
if (!baseUrl) {
	console.error('Give the dev server URL: npm run check:controls -- http://127.0.0.1:5192, or set EASEL_URL.')
	process.exit(2)
}

/** The spec's values, from docs/design.md (Controls). */
const SPEC = {
	tokens: {
		'--paper-ink': '#1f1e1b',
		'--paper-card': '#fffffd',
		'--paper-accent': '#344c41',
		'--paper-rule': '#e6e2d9',
		'--paper-hover': '#f2f0eb',
		'--paper-pressed': '#e7e4dc',
		'--paper-viz-grid': '#efefed',
		'--paper-viz-fill-dim': '#e0dfdd',
		'--paper-viz-fill': '#d2d2d0',
		'--paper-viz-line': '#bcbcb9',
		'--paper-viz-line-strong': '#9a9a97',
		'--paper-viz-data': '#747471',
	},
	/** The only translucent paints: ink at these alphas. */
	borders: { '--paper-viz-border': 0.12, '--paper-viz-border-hover': 0.2, '--paper-viz-border-focus': 0.3 },
	slider: { hit: 18, minWidth: 40, track: 1, thumb: 9, thumbRadius: 2, hoverScale: 1.4, scaleMs: 200, colorMs: 150 },
	button: { w: 24, h: 22 },
	focus: { width: 2, offset: 2, minContrast: 3 },
	disabledOpacity: 0.35,
	progress: { minHeight: 1, maxHeight: 3, track: ['--paper-viz-fill-dim', '--paper-viz-line'], fill: ['--paper-viz-data', '--paper-ink'] },
}

const results = []
const pass = (name, detail = '') => results.push({ status: 'PASS', name, detail })
const fail = (name, detail = '') => results.push({ status: 'FAIL', name, detail })
const gap = (name, detail = '') => results.push({ status: 'GAP', name, detail })
const check = (ok, name, detail) => (ok ? pass(name, detail) : fail(name, detail))
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance

const IDS = { graph: 'shape:cc-graph', scene: 'shape:cc-scene', video: 'shape:cc-video' }

/** Helpers that run in the page. Installed once as window.__cc. */
function installHelpers() {
	const parseColor = (text) => {
		text = text.trim()
		let m = /^rgba?\(([^)]+)\)$/.exec(text)
		if (m) {
			const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
			return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
		}
		m = /^color\(srgb ([^)]+)\)$/.exec(text)
		if (m) {
			const [rgb, alpha] = m[1].split('/')
			const [r, g, b] = rgb.trim().split(/\s+/).map((v) => Number(v) * 255)
			return { r, g, b, a: alpha === undefined ? 1 : Number(alpha) }
		}
		if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
		// Other color spaces, such as oklab from color-mix: the canvas converts them.
		const alpha = /\/\s*([\d.]+)\s*\)$/.exec(text)
		const ctx = new OffscreenCanvas(1, 1).getContext('2d')
		ctx.fillStyle = '#000'
		ctx.fillStyle = text
		ctx.fillRect(0, 0, 1, 1)
		const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
		return { r, g, b, a: alpha ? Number(alpha[1]) : 1 }
	}
	const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
	const over = (top, bottom) => {
		const a = top.a + bottom.a * (1 - top.a)
		if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
		const mix = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a
		return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a }
	}
	const luminance = (c) => {
		const ch = (v) => {
			v /= 255
			return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
		}
		return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
	}
	const contrast = (a, b) => {
		const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
		return (hi + 0.05) / (lo + 0.05)
	}
	/** Resolve a CSS color expression where `context` sits, through a probe element. */
	const resolve = (expression, context) => {
		const probe = document.createElement('span')
		probe.style.color = expression
		context.appendChild(probe)
		const value = getComputedStyle(probe).color
		probe.remove()
		return parseColor(value)
	}
	/** A box-shadow written in paper.css, with its colors resolved where `context` sits. */
	const resolveShadow = (expression, context) => {
		const probe = document.createElement('span')
		probe.style.boxShadow = expression
		context.appendChild(probe)
		const value = getComputedStyle(probe).boxShadow
		probe.remove()
		return value
	}
	/** Every style rule in the page, with @media rules unwrapped. */
	const allRules = () => {
		const out = []
		const walk = (list) => {
			for (const rule of list) {
				if (rule.selectorText !== undefined) out.push(rule)
				else if (rule.cssRules) walk(rule.cssRules)
			}
		}
		for (const sheet of document.styleSheets) {
			try {
				walk(sheet.cssRules)
			} catch {
				// A cross-origin sheet; Easel's own sheets are same-origin.
			}
		}
		return out
	}
	/** The declarations for one exact selector, merged in source order, with the usual shorthands. */
	const SHORTHANDS = ['background', 'border-radius', 'box-shadow', 'outline', 'transition']
	const rule = (selector) => {
		const merged = {}
		for (const r of allRules()) {
			const selectors = r.selectorText.split(',').map((s) => s.trim())
			if (!selectors.includes(selector)) continue
			const names = [...Array.from({ length: r.style.length }, (_, i) => r.style[i]), ...SHORTHANDS]
			for (const name of names) {
				const value = r.style.getPropertyValue(name).trim()
				if (value) merged[name] = value
			}
		}
		return merged
	}
	const canvasBackground = () => {
		const el = document.querySelector('.tl-background') || document.body
		return parseColor(getComputedStyle(el).backgroundColor)
	}
	/** Paint layers from an element up to the first opaque background. */
	const layers = (el) => {
		const translucent = []
		const faded = []
		let base = null
		const pseudo = (node, which) => {
			const style = getComputedStyle(node, which)
			if (style.content === 'none' || style.content === 'normal') return
			const c = parseColor(style.backgroundColor)
			if (c.a > 0 && c.a < 1) translucent.push(`${node.className}${which}`)
		}
		for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
			const style = getComputedStyle(node)
			if (Number(style.opacity) < 1) faded.push(`${node.className} (opacity ${style.opacity})`)
			if (node === el) {
				pseudo(node, '::before')
				pseudo(node, '::after')
			}
			const c = parseColor(style.backgroundColor)
			if (c.a >= 0.999) {
				base = c
				break
			}
			if (c.a > 0) translucent.push(`${String(node.className).split(' ')[0]} ${hex(c)}/${c.a.toFixed(2)}`)
		}
		return { translucent, faded, base: base ?? canvasBackground() }
	}
	/** What a control paints over its nearest opaque background. */
	const surroundings = (el) => {
		const { base } = layers(el.parentElement)
		const own = parseColor(getComputedStyle(el).backgroundColor)
		return { outside: base, inside: own.a > 0 ? over(own, base) : base }
	}
	/** Pixel facts from a PNG screenshot, given as base64. */
	const pixels = async (b64, options) => {
		const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
		const bitmap = await createImageBitmap(blob)
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
		const ctx = canvas.getContext('2d')
		ctx.drawImage(bitmap, 0, 0)
		const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
		const at = (x, y) => {
			const i = (y * width + x) * 4
			return { r: data[i], g: data[i + 1], b: data[i + 2], a: 1 }
		}
		const near = (c, t, tol) => Math.abs(c.r - t.r) <= tol && Math.abs(c.g - t.g) <= tol && Math.abs(c.b - t.b) <= tol
		// The box of pixels close to a target color, such as the ink of a thumb.
		let box = null
		if (options.target) {
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					if (!near(at(x, y), options.target, options.tolerance ?? 24)) continue
					box = box
						? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) }
						: { x0: x, y0: y, x1: x, y1: y }
				}
			}
		}
		// Rows that differ from the background across most of the width: the track.
		const bg = at(0, 0)
		const rows = []
		for (let y = 0; y < height; y++) {
			let differ = 0
			for (let x = 0; x < width; x++) if (!near(at(x, y), bg, 12)) differ++
			if (differ > width * 0.6) rows.push(y)
		}
		const samples = (options.samples || []).map(([x, y]) => hex(at(x, y)))
		return { box: box && { ...box, w: box.x1 - box.x0 + 1, h: box.y1 - box.y0 + 1 }, rows, samples }
	}
	window.__cc = { parseColor, hex, over, contrast, resolve, resolveShadow, rule, layers, surroundings, pixels, canvasBackground }
}

async function main() {
	const { chromium } = loadPlaywright()
	const browser = await chromium.launch()
	const page = await browser.newPage({ viewport: { width: 1900, height: 1100 }, deviceScaleFactor: 1 })
	const errors = []
	page.on('pageerror', (e) => errors.push(e.message))

	try {
		await page.goto(`${baseUrl}/?board=reference`, { waitUntil: 'load' })
		await page.waitForFunction(() => window.editor && window.editor.getCurrentPageShapeIds().size > 0, null, { timeout: 30000 })
		await page.evaluate(installHelpers)
		await setUpBoard(page)
		if (process.env.CHECK_CONTROLS_SCREENSHOT) await page.screenshot({ path: process.env.CHECK_CONTROLS_SCREENSHOT })

		await checkTokens(page)
		await checkSliders(page)
		await checkInkBudget(page)
		await checkFocus(page)
		await checkStateLayers(page)
		await checkTransport(page)
		await checkDisabledAndSurfaces(page)
		await checkProgress(page)
		await probePanAndZoom(page)
	} catch (error) {
		fail('the check ran to the end', String(error?.stack || error))
	} finally {
		await browser.close()
	}

	for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`)
	const failed = results.filter((r) => r.status === 'FAIL').length
	const passed = results.filter((r) => r.status === 'PASS').length
	const gaps = results.filter((r) => r.status === 'GAP').length
	console.log(`\n${passed} passed, ${failed} failed, ${gaps} known gaps.`)
	process.exit(failed ? 1 : 0)
}

/** A clean page at zoom 1 with one graph, one scene with a clock, and one finished animation. */
async function setUpBoard(page) {
	await page.evaluate((ids) => {
		const editor = window.editor
		editor.createPage({ name: 'Controls check' })
		const pages = editor.getPages()
		editor.setCurrentPage(pages[pages.length - 1].id)
		const objects = {
			vx: { type: 'let', expr: 'v0*cos(deg(theta))' },
			vy: { type: 'let', expr: 'v0*sin(deg(theta))' },
			T: { type: 'let', expr: '2*vy/g' },
			tt: { type: 'let', expr: 'min(t, T)' },
			ground: { type: 'segment', from: ['-2', '0'], to: ['45', '0'] },
			path: { type: 'curve', x: 'vx*s', y: 'vy*s - g*s^2/2', from: '0', to: 'T', ink: 1 },
			ball: { type: 'point', x: 'vx*tt', y: 'max(0, vy*tt - g*tt^2/2)', label: 'ball' },
		}
		for (const [id, o] of Object.entries(objects)) o.id = id
		const param = (name, value, min, max, step) => ({ name, value, min, max, step })
		editor.createShapes([
			{
				id: ids.graph,
				type: 'graph',
				x: 40,
				y: 80,
				props: {
					w: 420,
					h: 360,
					functions: [{ expression: 'a*sin(b*x)' }],
					parameters: [param('a', 1, 0, 3, 0.1), param('b', 2, 0.5, 4, 0.1)],
					xMin: -5,
					xMax: 5,
					yMin: -3,
					yMax: 3,
				},
			},
			{
				id: ids.scene,
				type: 'scene',
				x: 500,
				y: 80,
				props: {
					w: 460,
					h: 418,
					title: 'Projectile',
					xMin: -2,
					xMax: 45,
					yMin: -2,
					yMax: 16,
					duration: 3.5,
					axes: true,
					params: { v0: param('v0', 20, 5, 30, 0.5), theta: param('theta', 45, 5, 85, 1), g: param('g', 9.8, 1, 20, 0.1) },
					objects,
				},
			},
			{
				id: ids.video,
				type: 'animation',
				x: 1000,
				y: 80,
				props: { title: 'Controls check', status: 'ready', renderKey: 'controls-check', duration: 4 },
			},
		])
		editor.selectNone()
		editor.setCamera({ x: 0, y: 0, z: 1 })
	}, IDS)
	for (const id of Object.values(IDS)) await page.waitForSelector(`[data-shape-id="${id}"] .paper-range`, { timeout: 15000 })
	// Let fonts and Mafs settle before measuring pixels.
	await page.evaluate(() => document.fonts.ready)
	await page.waitForTimeout(500)
}

async function checkTokens(page) {
	const resolved = await page.evaluate(
		({ id, tokens, borders }) => {
			const context = document.querySelector(`[data-shape-id="${id}"] .graph-sheet`)
			const out = {}
			for (const name of Object.keys(tokens)) out[name] = __cc.hex(__cc.resolve(`var(${name})`, context))
			for (const name of Object.keys(borders)) {
				const c = __cc.resolve(`var(${name})`, context)
				out[name] = { hex: __cc.hex(c), a: c.a }
			}
			out.sheet = __cc.hex(__cc.parseColor(getComputedStyle(context).backgroundColor))
			return out
		},
		{ id: IDS.graph, tokens: SPEC.tokens, borders: SPEC.borders }
	)
	for (const [name, want] of Object.entries(SPEC.tokens)) {
		check(sameHex(resolved[name], want, 1), `token ${name} resolves to ${want}`, `got ${resolved[name]}`)
	}
	for (const [name, alpha] of Object.entries(SPEC.borders)) {
		const got = resolved[name]
		check(sameHex(got.hex, SPEC.tokens['--paper-ink'], 1) && near(got.a, alpha, 0.005), `token ${name} is ink at ${alpha * 100}%`, `got ${got.hex} at ${got.a}`)
	}
	check(resolved.sheet === SPEC.tokens['--paper-card'], 'a shape sheet is the card', `got ${resolved.sheet}`)
}

function sameHex(a, b, tolerance) {
	const ch = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
	return ch(a).every((v, i) => Math.abs(v - ch(b)[i]) <= tolerance)
}

/** One slider per kind: a graph parameter, scene time, and the animation's position. */
const SLIDERS = [
	['graph parameter', `[data-shape-id="${IDS.graph}"] .shape-parameter .paper-range`],
	['scene time', `[data-shape-id="${IDS.scene}"] .simulation-controls .paper-range`],
	['animation position', `[data-shape-id="${IDS.video}"] .video-controls .paper-range`],
]

async function sliderPixels(page, locator, extra = {}) {
	const box = await locator.boundingBox()
	const clip = { x: Math.floor(box.x), y: Math.floor(box.y) - 6, width: Math.ceil(box.width), height: Math.ceil(box.height) + 12 }
	const png = await page.screenshot({ clip })
	const facts = await page.evaluate(({ b64, options }) => __cc.pixels(b64, options), { b64: png.toString('base64'), options: extra })
	return { ...facts, clip }
}

const rgb = (hex) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) })

async function checkSliders(page) {
	const s = SPEC.slider
	const css = await page.evaluate(() => ({
		thumb: __cc.rule('.paper-range::-webkit-slider-thumb'),
		track: __cc.rule('.paper-range::-webkit-slider-runnable-track'),
		hover: __cc.rule('.paper-range:hover::-webkit-slider-thumb'),
		active: __cc.rule('.paper-range:active::-webkit-slider-thumb'),
		range: __cc.rule('.paper-range'),
	}))
	check(css.thumb.width === `${s.thumb}px` && css.thumb.height === `${s.thumb}px`, `slider thumb is ${s.thumb} px square`, `${css.thumb.width} x ${css.thumb.height}`)
	check(css.thumb['border-radius'] === `${s.thumbRadius}px`, `slider thumb radius is ${s.thumbRadius} px`, css.thumb['border-radius'])
	check(css.track.height === `${s.track}px`, `slider track is ${s.track} px`, css.track.height)
	check(css.range.height === `${s.hit}px`, `slider hit area is ${s.hit} px tall in paper.css`, css.range.height)
	check(css.hover.transform === `scale(${s.hoverScale})` && css.active.transform === `scale(${s.hoverScale})`, `thumb grows by ${s.hoverScale} on hover and drag`, css.hover.transform)
	check(/transform 200ms/.test(css.thumb.transition) && /background-color 150ms/.test(css.thumb.transition) && /var\(--ease-out\)/.test(css.thumb.transition), 'thumb timing is transform 200 ms and color 150 ms, ease-out', css.thumb.transition)
	check(/var\(--paper-accent\)/.test(css.active.background || ''), 'a dragged thumb takes the accent', css.active.background)

	const ink = rgb(SPEC.tokens['--paper-ink'])
	const clipped = []
	for (const [label, selector] of SLIDERS) {
		const input = page.locator(selector).first()
		const box = await input.boundingBox()
		check(near(box.height, s.hit, 0.5) && box.width >= s.minWidth, `${label}: hit area is ${s.hit} px tall and at least ${s.minWidth} px wide`, `${box.width.toFixed(1)} x ${box.height.toFixed(1)}`)

		await page.mouse.move(5, 5)
		await page.waitForTimeout(300)
		const rest = await sliderPixels(page, input, { target: ink, tolerance: 20 })
		check(rest.box && near(rest.box.w, s.thumb, 1) && near(rest.box.h, s.thumb, 1), `${label}: thumb renders ${s.thumb} px in ink`, rest.box ? `${rest.box.w} x ${rest.box.h}` : 'no ink thumb found')
		check(rest.rows.length === s.track, `${label}: track renders ${s.track} px`, `${rest.rows.length} rows`)

		// The hit area: both edges of the 18 px box reach the slider, well outside the 9 px thumb.
		const thumbX = box.x + (rest.box ? (rest.box.x0 + rest.box.x1) / 2 : box.width / 2)
		const edges = await page.evaluate(
			({ selector, x, top, bottom }) => {
				const el = document.querySelector(selector)
				return [document.elementFromPoint(x, top) === el, document.elementFromPoint(x, bottom) === el]
			},
			{ selector, x: thumbX, top: box.y + 1, bottom: box.y + box.height - 1 }
		)
		check(edges[0] && edges[1], `${label}: the whole hit area takes the pointer`, `top ${edges[0]}, bottom ${edges[1]}`)

		await page.mouse.move(thumbX, box.y + box.height / 2)
		await page.waitForTimeout(350)
		// A looser match takes in the scaled thumb's soft edges.
		const hover = await sliderPixels(page, input, { target: ink, tolerance: 60 })
		// Measured up and down: at either end of the track the input clips the thumb's sides.
		const grown = s.thumb * s.hoverScale
		check(hover.box && near(hover.box.h, grown, 1.5), `${label}: hovered thumb grows to about ${Math.round(grown)} px`, hover.box ? `${hover.box.h} px` : 'no ink thumb found')
		if (hover.box && hover.box.w < hover.box.h - 1) clipped.push(`${label} (${hover.box.w} of ${hover.box.h} px wide on hover)`)
	}

	if (clipped.length) gap('a grown thumb is clipped at the ends of the track', clipped.join('; '))

	// Under reduced motion the thumb should not animate. Chromium drops a rule whose
	// selector list names another engine's pseudo-element, so look for a rule it kept.
	const reduced = await page.evaluate(() => {
		const found = []
		const walk = (list, inReduce) => {
			for (const r of list) {
				const reduce = inReduce || (r.media && /prefers-reduced-motion:\s*reduce/.test(r.media.mediaText))
				if (r.selectorText && reduce && /paper-range/.test(r.selectorText) && /webkit-slider-thumb/.test(r.selectorText)) found.push(r.style.transition || r.style.transitionDuration)
				else if (r.cssRules) walk(r.cssRules, reduce)
			}
		}
		for (const sheet of document.styleSheets) walk(sheet.cssRules, false)
		return found
	})
	if (reduced.length) pass('the thumb holds still under reduced motion', reduced.join(', '))
	else gap('the thumb holds still under reduced motion', 'no reduced-motion rule for the WebKit thumb reaches Chromium')

	// A press near the top edge of the hit area moves a graph parameter.
	const first = page.locator(SLIDERS[0][1]).first()
	const box = await first.boundingBox()
	const before = await first.inputValue()
	await page.mouse.move(box.x + box.width * 0.9, box.y + 2)
	await page.mouse.down()
	await page.mouse.move(box.x + box.width * 0.85, box.y + 2, { steps: 4 })
	await page.waitForTimeout(250)
	const accent = rgb(SPEC.tokens['--paper-accent'])
	const drag = await sliderPixels(page, first, { target: accent, tolerance: 14 })
	const dragFacts = await page.evaluate((selector) => __cc.layers(document.querySelector(selector)), SLIDERS[0][1])
	await page.mouse.up()
	const after = await first.inputValue()
	check(after !== before, 'a press at the edge of the hit area drags the slider', `${before} -> ${after}`)
	check(drag.box && drag.box.w >= s.thumb, 'a dragged thumb paints the accent, opaque', drag.box ? `${drag.box.w} px of accent` : 'no accent thumb found')
	check(dragFacts.translucent.length <= 1 && dragFacts.faded.length === 0, 'a dragged slider stacks no translucent layers', dragFacts.translucent.concat(dragFacts.faded).join('; ') || 'none')
}

async function checkInkBudget(page) {
	const facts = await page.evaluate((ids) => {
		const color = (el) => __cc.hex(__cc.parseColor(getComputedStyle(el).color))
		const graph = document.querySelector(`[data-shape-id="${ids.graph}"]`)
		const scene = document.querySelector(`[data-shape-id="${ids.scene}"]`)
		return {
			names: [...graph.querySelectorAll('.shape-parameter-name')].map(color),
			values: [...graph.querySelectorAll('.shape-parameter-value')].map(color),
			time: color(scene.querySelector('.player-time')),
			value: __cc.rule('.shape-parameter-value'),
		}
	}, IDS)
	const data = SPEC.tokens['--paper-viz-data']
	const ink = SPEC.tokens['--paper-ink']
	check(facts.names.every((c) => sameHex(c, data, 1)), 'ink budget: slider names are data, not ink', facts.names.join(', '))
	check(facts.values.every((c) => sameHex(c, ink, 1)), 'ink budget: slider values are ink', facts.values.join(', '))
	check(sameHex(facts.time, data, 1), 'ink budget: player time is data', facts.time)
}

/** Every focusable control on the test board, and the voice mic. */
const FOCUSABLE = [
	['slider (graph)', SLIDERS[0][1]],
	['slider value', `[data-shape-id="${IDS.graph}"] .shape-parameter-value`],
	['scene play', `[data-shape-id="${IDS.scene}"] .simulation-play`],
	['scene time', SLIDERS[1][1]],
	['animation play', `[data-shape-id="${IDS.video}"] .video-button[aria-label="Play"], [data-shape-id="${IDS.video}"] .video-button[aria-label="Pause"]`],
	['animation position', SLIDERS[2][1]],
	['animation loop', `[data-shape-id="${IDS.video}"] .video-button[aria-label="Loop"]`],
	['voice mic', '.voice-mic'],
]

async function checkFocus(page) {
	const f = SPEC.focus
	const ink = rgb(SPEC.tokens['--paper-ink'])
	for (const [label, selector] of FOCUSABLE) {
		const el = page.locator(selector).first()
		if ((await el.count()) === 0) {
			fail(`${label}: present on the board`)
			continue
		}
		await page.mouse.move(5, 5)
		await page.keyboard.press('Shift')
		const facts = await page.evaluate((selector) => {
			const el = document.querySelector(selector)
			el.focus({ focusVisible: true })
			if (!el.matches(':focus-visible')) return { visible: false }
			const style = getComputedStyle(el)
			const around = __cc.surroundings(el)
			if (el.matches('.paper-range')) {
				const shadow = __cc.resolveShadow(__cc.rule('.paper-range:focus-visible::-webkit-slider-thumb')['box-shadow'], el.parentElement)
				const colors = [...shadow.matchAll(/(rgba?\([^)]*\)|color\([^)]*\))/g)].map((m) => __cc.parseColor(m[1]))
				const widths = [...shadow.matchAll(/0px 0px 0px (\d+)px/g)].map((m) => Number(m[1]))
				const [gapColor, ring] = colors
				return {
					visible: true,
					kind: 'thumb ring',
					ring: __cc.hex(ring),
					width: widths[1] - widths[0],
					offset: widths[0],
					contrasts: [__cc.contrast(ring, __cc.over(gapColor, around.outside)), __cc.contrast(ring, around.outside)],
				}
			}
			const ring = __cc.parseColor(style.outlineColor)
			return {
				visible: true,
				kind: 'outline',
				ring: __cc.hex(ring),
				style: style.outlineStyle,
				width: parseFloat(style.outlineWidth),
				offset: parseFloat(style.outlineOffset),
				contrasts: [__cc.contrast(ring, around.inside), __cc.contrast(ring, around.outside)],
			}
		}, selector)
		if (!facts.visible) {
			fail(`${label}: keyboard focus is visible`, 'no :focus-visible')
			continue
		}
		check(facts.width === f.width && facts.offset === f.offset, `${label}: focus ring is ${f.width} px, ${f.offset} px out`, `${facts.kind} ${facts.width} px, offset ${facts.offset} px`)
		const lowest = Math.min(...facts.contrasts)
		check(lowest >= f.minContrast, `${label}: focus ring has 3:1 against its neighbors`, `${facts.ring}, lowest ${lowest.toFixed(2)}:1`)
		if (facts.kind === 'thumb ring') {
			const px = await sliderPixels(page, el, { target: ink, tolerance: 20 })
			const ringSize = SPEC.slider.thumb + 2 * (f.width + f.offset)
			check(px.box && near(px.box.h, ringSize, 1), `${label}: the ring renders around the thumb`, px.box ? `${px.box.h} px of ink, up and down` : 'no ink found')
			if (px.box && px.box.w < px.box.h - 1) gap(`${label}: the focus ring is clipped at the end of the track`, `${px.box.w} of ${px.box.h} px wide`)
		}
		await page.evaluate(() => document.activeElement?.blur())
	}
}

/** Hover and press each control, and count the translucent paints under the pointer. */
async function checkStateLayers(page) {
	for (const [label, selector] of FOCUSABLE) {
		const el = page.locator(selector).first()
		if ((await el.count()) === 0) continue
		const box = await el.boundingBox()
		const x = box.x + box.width / 2
		const y = box.y + box.height / 2
		await page.mouse.move(x, y)
		await page.waitForTimeout(200)
		const hover = await page.evaluate((selector) => __cc.layers(document.querySelector(selector)), selector)
		await page.mouse.down()
		await page.waitForTimeout(100)
		const pressed = await page.evaluate((selector) => __cc.layers(document.querySelector(selector)), selector)
		await page.mouse.up()
		await page.keyboard.press('Escape')
		const stacked = (l) => l.translucent.length > 1 || l.faded.length > 0
		check(!stacked(hover) && !stacked(pressed), `${label}: hover and press stack no translucent layers`, [...hover.translucent, ...pressed.translucent, ...hover.faded].join('; ') || 'opaque')
		if (hover.translucent.length === 1) gap(`${label}: hover is a translucent film, not an opaque replacement`, hover.translucent[0])
	}
	// Leave the players stopped and the value field closed.
	await page.mouse.move(5, 5)
	await page.evaluate((ids) => {
		for (const id of [ids.scene, ids.video]) {
			const pause = document.querySelector(`[data-shape-id="${id}"] button[aria-label="Pause"]`)
			pause?.click()
		}
		document.activeElement?.blur()
	}, IDS)
}

/** Pause a player in one step: it may reach its end, and turn back into Play, at any moment. */
function pauseIfPlaying(page, id) {
	return page.evaluate((id) => document.querySelector(`[data-shape-id="${id}"] button[aria-label="Pause"]`)?.click(), id)
}

async function checkTransport(page) {
	const count = (id) =>
		page.evaluate((id) => {
			const shape = document.querySelector(`[data-shape-id="${id}"]`)
			return {
				play: shape.querySelectorAll('button[aria-label="Play"], button[aria-label="Pause"]').length,
				scrub: shape.querySelectorAll('input[type="range"][aria-label="Time"], input[type="range"][aria-label="Position"]').length,
			}
		}, id)
	for (const [label, id] of [
		['scene', IDS.scene],
		['animation', IDS.video],
	]) {
		const rest = await count(id)
		check(rest.play === 1 && rest.scrub === 1, `${label}: one play control and one scrubber`, `${rest.play} play, ${rest.scrub} scrubber`)
		await page.locator(`[data-shape-id="${id}"] button[aria-label="Play"]`).click()
		await page.waitForTimeout(150)
		const playing = await count(id)
		check(playing.play === 1, `${label}: still one play control while playing`, `${playing.play}`)
		await pauseIfPlaying(page, id)
	}
	const graph = await count(IDS.graph)
	check(graph.play === 0, 'graph: no transport on a shape without time', `${graph.play}`)
	const button = await page.locator(`[data-shape-id="${IDS.scene}"] .simulation-play`).boundingBox()
	check(near(button.width, SPEC.button.w, 0.5) && near(button.height, SPEC.button.h, 0.5), `play button is ${SPEC.button.w} x ${SPEC.button.h} px`, `${button.width} x ${button.height}`)
}

async function checkDisabledAndSurfaces(page) {
	const facts = await page.evaluate((id) => {
		const sheet = document.querySelector(`[data-shape-id="${id}"] .graph-sheet`)
		const input = document.createElement('input')
		input.type = 'range'
		input.className = 'paper-range'
		input.disabled = true
		sheet.appendChild(input)
		const disabled = { opacity: getComputedStyle(input).opacity, cursor: getComputedStyle(input).cursor }
		input.remove()

		// Floating surfaces, drawn as probes off screen with the same classes.
		const theme = document.querySelector('.tl-container.tl-theme__light') || document.body
		const host = document.createElement('div')
		host.style.cssText = 'position:fixed;left:-2000px;top:0'
		theme.appendChild(host)
		host.innerHTML = `
			<div class="voice-control voice-control--on"></div>
			<span class="video-making-phase">Rendering</span>
			<div class="chat-panel chat-panel--floating tl-theme__light"><div class="chat-sheet"></div></div>`
		const read = (el) => {
			const s = getComputedStyle(el)
			return { bg: __cc.parseColor(s.backgroundColor), shadow: s.boxShadow, radius: s.borderTopLeftRadius, height: s.height, border: s.borderTopWidth }
		}
		const voice = read(host.querySelector('.voice-control'))
		const status = read(host.querySelector('.video-making-phase'))
		const answer = read(host.querySelector('.chat-sheet'))
		host.remove()
		return { disabled, voice, status, answer }
	}, IDS.graph)
	check(Number(facts.disabled.opacity) === SPEC.disabledOpacity && facts.disabled.cursor === 'default', `a disabled slider fades to ${SPEC.disabledOpacity} with no pointer cursor`, `${facts.disabled.opacity}, ${facts.disabled.cursor}`)

	const hairline = /\/ 0\.12\) 0px 0px 0px 1px inset/
	const v = facts.voice
	check(v.bg.a >= 0.98 && hairline.test(v.shadow), 'voice pill: one near-opaque card with a 12 percent ink hairline', `alpha ${v.bg.a}, ${v.shadow}`)
	check(parseFloat(v.radius) * 2 >= parseFloat(v.height), 'voice pill: fully rounded', `${v.radius} on ${v.height}`)
	const st = facts.status
	check(st.bg.a === 1 && hairline.test(st.shadow) && parseFloat(st.radius) * 2 >= parseFloat(st.height), 'status pill: opaque card, ink hairline, fully rounded', `alpha ${st.bg.a}, ${st.radius} on ${st.height}`)
	const a = facts.answer
	check(a.bg.a === 1 && a.border === '1px' && a.radius === '22px', 'answer card: opaque card, 1 px rule, 22 px radius', `alpha ${a.bg.a}, ${a.border}, ${a.radius}`)
}

/**
 * Progress: the shared bar on an animation and a widget whose jobs run. The
 * jobs are stand-ins, set in the app's own job records, so no model runs.
 */
async function checkProgress(page) {
	const facts = await page.evaluate(async () => {
		// The app's own module instances, as the page loaded them.
		const load = (p) => import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p)
		const video = await load('/client/shapes/video/jobs.ts')
		const widget = await load('/client/shapes/widget/jobs.ts')
		const editor = window.editor
		const ids = { video: 'shape:cc-making', widget: 'shape:cc-writing' }
		editor.createShapes([
			{ id: ids.video, type: 'animation', x: 40, y: 560, props: { title: 'Progress check', brief: 'A stand-in job.', status: 'rendering' } },
			{ id: ids.widget, type: 'widget', x: 720, y: 560, props: { title: 'Progress check', brief: 'A stand-in job.', status: 'writing', w: 360, h: 240 } },
		])
		const now = Date.now()
		const controller = new AbortController()
		video.startVideoJob(ids.video, controller, { phase: 'writing', progress: 0, frame: null, frames: [] }, now - 30000)
		widget.runningWidgetJobs.update((jobs) => new Map(jobs).set(ids.widget, { controller: new AbortController(), startedAt: now - 10000 }))
		const wait = (ms) => new Promise((r) => setTimeout(r, ms))
		await wait(400)

		const read = (id) => {
			const bar = document.querySelector(`[data-shape-id="${id}"] .paper-progress`)
			if (!bar) return null
			const fill = bar.querySelector('.paper-progress-fill')
			let faded = []
			for (let node = bar; node && node !== document.documentElement; node = node.parentElement) {
				const o = Number(getComputedStyle(node).opacity)
				if (o < 1) faded.push(`${String(node.className).split(' ')[0]} ${o}`)
			}
			const fillOpacity = Number(getComputedStyle(fill).opacity)
			if (fillOpacity < 1) faded.push(`fill ${fillOpacity}`)
			return {
				role: bar.getAttribute('role'),
				valuenow: bar.getAttribute('aria-valuenow'),
				height: bar.getBoundingClientRect().height,
				track: __cc.parseColor(getComputedStyle(bar).backgroundColor),
				fill: __cc.parseColor(getComputedStyle(fill).backgroundColor),
				faded,
				value: Number(bar.dataset.progress),
			}
		}
		const tokens = (names) => names.map((n) => __cc.hex(__cc.resolve(`var(${n})`, document.querySelector(`[data-shape-id="${ids.video}"]`))))
		const first = { video: read(ids.video), widget: read(ids.widget) }

		// Walk the animation through its phases, with a render that starts over
		// from 0, and read the bar after each step: it may only go forward.
		const steps = [
			['checking', 0],
			['fixing', 0.6],
			['fixing', 0.1],
			['writing', 0],
			['rendering', 0.05],
			['rendering', 0.5],
		]
		const values = [first.video?.value ?? 0]
		for (const [phase, progress] of steps) {
			video.reportVideoJob(ids.video, controller, { phase, progress, frame: null, frames: [] })
			await wait(350)
			values.push(read(ids.video)?.value ?? -1)
		}
		const sheet = []
		for (const s of document.styleSheets) {
			const walk = (list, reduce) => {
				for (const r of list) {
					const inReduce = reduce || (r.media && /prefers-reduced-motion:\s*reduce/.test(r.media.mediaText))
					if (r.selectorText && inReduce && /paper-progress-fill/.test(r.selectorText)) sheet.push(r.style.transition || r.style.transitionProperty)
					else if (r.cssRules) walk(r.cssRules, inReduce)
				}
			}
			try {
				walk(s.cssRules, false)
			} catch {}
		}
		video.cancelVideoJob(ids.video)
		widget.cancelWidgetJobs()
		editor.deleteShapes([ids.video, ids.widget])
		return { first, values, reduced: sheet, track: tokens(['--paper-viz-fill-dim', '--paper-viz-line']), fill: tokens(['--paper-viz-data', '--paper-ink']) }
	})
	const p = SPEC.progress
	for (const [label, bar] of [
		['animation', facts.first.video],
		['widget', facts.first.widget],
	]) {
		if (!bar) {
			fail(`progress (${label}): a running job shows a progress bar`)
			continue
		}
		pass(`progress (${label}): a running job shows a progress bar`)
		check(bar.role === 'progressbar' && bar.valuenow !== null, `progress (${label}): the bar is a progressbar with a value`, `${bar.role}, ${bar.valuenow}`)
		check(bar.height >= p.minHeight - 0.01 && bar.height <= p.maxHeight + 0.01, `progress (${label}): the track is ${p.minHeight} to ${p.maxHeight} px`, `${bar.height} px`)
		const trackHex = hexOf(bar.track)
		const fillHex = hexOf(bar.fill)
		check(bar.track.a === 1 && facts.track.some((t) => sameHex(t, trackHex, 1)), `progress (${label}): the track is an opaque fill-dim or line`, `${trackHex}/${bar.track.a}`)
		check(bar.fill.a === 1 && facts.fill.some((t) => sameHex(t, fillHex, 1)), `progress (${label}): the fill is an opaque data or ink`, `${fillHex}/${bar.fill.a}`)
		check(bar.faded.length === 0, `progress (${label}): no film or fade over the bar`, bar.faded.join('; ') || 'none')
	}
	const backward = facts.values.findIndex((v, i) => i > 0 && v < facts.values[i - 1] - 1e-6)
	check(backward < 0 && facts.values.at(-1) > facts.values[0], 'progress: an animation\'s bar only moves forward across its phases', facts.values.map((v) => v.toFixed(3)).join(' -> '))
	check(facts.reduced.some((t) => /none|^0s/.test(t)), 'progress: the fill does not glide under reduced motion', facts.reduced.join(', ') || 'no reduced-motion rule')
}

function hexOf(c) {
	return '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}

/** Known gap: animated previews keep running while the user pans and zooms. Reported, not enforced. */
async function probePanAndZoom(page) {
	const readTime = () => page.locator(`[data-shape-id="${IDS.scene}"] .player-time`).innerText()
	await page.locator(`[data-shape-id="${IDS.scene}"] button[aria-label="Play"]`).click()
	await page.waitForTimeout(100)
	const before = await readTime()
	await page.evaluate(async () => {
		const editor = window.editor
		for (let i = 0; i < 20; i++) {
			editor.setCamera({ x: -i * 4, y: 0, z: 1 - i * 0.005 })
			await new Promise((r) => setTimeout(r, 30))
		}
		editor.setCamera({ x: 0, y: 0, z: 1 })
	})
	const after = await readTime()
	await pauseIfPlaying(page, IDS.scene)
	if (before !== after) gap('animated previews pause during pan and zoom', `scene time ran from ${before} to ${after} while the camera moved`)
	else pass('animated previews pause during pan and zoom')
}

main()
