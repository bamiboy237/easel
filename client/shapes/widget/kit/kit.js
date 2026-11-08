// The paper kit: building blocks every generated widget gets as the global
// `paper`, so widgets share the board's look and get the hard parts right:
// a plot whose scale never changes under a drag, handles that stay in view,
// arrowheads sized in screen pixels, labels that avoid each other, and
// numbers written with a true minus sign.
//
// It runs in the widget's sandboxed frame before the widget's own script.
;(() => {
	'use strict'
	const SVG = 'http://www.w3.org/2000/svg'
	const MINUS = '−'
	const INKS = ['#302f2a', '#ae3b2c', '#2f5d8c', '#344c41']
	const ACCENT = '#344c41'

	const el = (tag, attrs, parent) => {
		const node = document.createElementNS(SVG, tag)
		for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) node.setAttribute(k, String(v))
		if (parent) parent.appendChild(node)
		return node
	}
	const html = (tag, cls, parent, text) => {
		const node = document.createElement(tag)
		if (cls) node.className = cls
		if (text !== undefined) node.textContent = text
		if (parent) parent.appendChild(node)
		return node
	}
	const resolve = (target) => (typeof target === 'string' ? document.querySelector(target) : target)
	// What the kit already made in an element: a widget that builds its plot,
	// sliders, readout, or presets inside its render function gets the same ones
	// back, updated, instead of a new copy stacked under the old one.
	const made = new WeakMap()
	const madeIn = (host, kind) => {
		let m = made.get(host)
		if (!m) made.set(host, (m = {}))
		return m[kind] || (m[kind] = new Map())
	}
	/** The part made before in this element, if the widget has not removed it since. */
	const madeBefore = (host, kind, key, node) => {
		const part = madeIn(host, kind).get(key)
		if (part && !host.contains(node(part))) {
			madeIn(host, kind).delete(key)
			return null
		}
		return part || null
	}
	const ink = (c) => (typeof c === 'number' ? INKS[c] || INKS[0] : c || INKS[0])

	// Numbers ---------------------------------------------------------------

	/** Round to d decimals and drop trailing zeros, with a true minus sign: fmt(-2.5) is "−2.5". */
	function fmt(x, d = 2, opts = {}) {
		if (!Number.isFinite(x)) return x > 0 ? '∞' : x < 0 ? MINUS + '∞' : 'undefined'
		const f = 10 ** d
		let r = Math.round(x * f) / f
		if (Object.is(r, -0) || r === 0) r = 0
		let s = opts.fixed ? Math.abs(r).toFixed(d) : String(Math.abs(r))
		if (!opts.fixed && s.includes('e')) s = Math.abs(r).toFixed(d)
		return (r < 0 ? MINUS : '') + s
	}
	/** True when x is exactly what fmt(x, d) shows. */
	function isExact(x, d = 2) {
		const f = 10 ** d
		// Floating-point noise is far below 1e-9 plus a millionth of a millionth of x;
		// a value rounded at d decimals is off by much more, even when x is large.
		return Math.abs(Math.round(x * f) / f - x) <= 1e-9 + 1e-12 * Math.abs(x)
	}
	/** A number to put inside working: negatives in parentheses, "(−3.2)". */
	function num(x, d = 2) {
		const s = fmt(x, d)
		return s.startsWith(MINUS) ? `(${s})` : s
	}
	/** "= 3" when the shown value is exact, "≈ 3.58" when it is rounded. Always from the unrounded value. */
	function eq(x, d = 2) {
		return (isExact(x, d) ? '= ' : '≈ ') + fmt(x, d)
	}
	/** A vector or point, "(3, −2)". */
	function vec(v, d = 2) {
		return `(${v.map((c) => fmt(c, d)).join(', ')})`
	}
	/** Degrees of an angle in radians, "63.4°". */
	function deg(rad, d = 1) {
		return fmt((rad * 180) / Math.PI, d) + '°'
	}
	/** Replace hyphen-minus signs before digits with true minus signs. */
	function minus(text) {
		return String(text).replace(/(^|[\s(=,[{])-(?=[\d.∞])/g, `$1${MINUS}`)
	}

	// Plot ------------------------------------------------------------------

	/**
	 * A plot with a fixed scale: x and y have the same scale, and the view only
	 * changes when the widget calls plot.view(...) or plot.ensure(...), never
	 * during a drag.
	 */
	function plot(target, opts = {}) {
		const host = resolve(target)
		if (!host) throw new Error('paper.plot: no element ' + target)
		const existing = madeBefore(host, 'plot', 'plot', (p) => p.svg)
		if (existing) {
			existing.reconfigure(opts)
			return existing
		}
		host.classList.add('paper-plot')
		const svg = el('svg', { role: 'img', 'aria-label': opts.label || 'plot' }, host)
		const gridLayer = el('g', {}, svg)
		const drawLayer = el('g', {}, svg)
		const labelLayer = el('g', {}, svg)
		const handleLayer = el('g', {}, svg)
		let view = { xMin: opts.xMin ?? -5, xMax: opts.xMax ?? 5, yMin: opts.yMin ?? -5, yMax: opts.yMax ?? 5 }
		const pad = opts.pad ?? 14
		let W = 0, H = 0, scale = 1, ox = 0, oy = 0
		let dragging = 0
		let pendingEnsure = null
		const handles = []
		let painter = null
		let placed = []

		const measure = () => {
			const r = host.getBoundingClientRect()
			W = Math.max(40, r.width || opts.width || 400)
			H = Math.max(40, r.height || opts.height || 300)
			svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
			// Equal scale on both axes, centred, for geometry. A graph of a function
			// (equal: false) fills the box, with its own scale on each axis.
			const sx = (W - 2 * pad) / (view.xMax - view.xMin)
			const sy = (H - 2 * pad) / (view.yMax - view.yMin)
			scale = Math.min(sx, sy)
			scaleX = opts.equal === false ? sx : scale
			scaleY = opts.equal === false ? sy : scale
			ox = (W - scaleX * (view.xMax - view.xMin)) / 2 - scaleX * view.xMin
			oy = (H + scaleY * (view.yMax - view.yMin)) / 2 + scaleY * view.yMin
		}
		let scaleX = 1, scaleY = 1
		const X = (x) => ox + scaleX * x
		const Y = (y) => oy - scaleY * y
		const P = (p) => [X(p[0]), Y(p[1])]
		/** The visible math region, a little wider than the view when the box is wider. */
		const visible = () => ({ xMin: (0 - ox) / scaleX, xMax: (W - ox) / scaleX, yMin: (oy - H) / scaleY, yMax: oy / scaleY })

		const drawGrid = () => {
			gridLayer.textContent = ''
			if (opts.grid === false && opts.axes === false) return
			const v = visible()
			const step = opts.gridStep || niceStep((v.xMax - v.xMin) / 10)
			const stepY = opts.gridStepY || (opts.equal === false ? niceStep((v.yMax - v.yMin) / 8) : step)
			if (opts.grid !== false) {
				for (let x = Math.ceil(v.xMin / step) * step; x <= v.xMax; x += step)
					el('line', { x1: X(x), y1: 0, x2: X(x), y2: H, stroke: 'var(--paper-viz-grid)', 'stroke-width': 1 }, gridLayer)
				for (let y = Math.ceil(v.yMin / stepY) * stepY; y <= v.yMax; y += stepY)
					el('line', { x1: 0, y1: Y(y), x2: W, y2: Y(y), stroke: 'var(--paper-viz-grid)', 'stroke-width': 1 }, gridLayer)
			}
			if (opts.axes !== false) {
				el('line', { x1: 0, y1: Y(0), x2: W, y2: Y(0), stroke: 'var(--paper-viz-line-strong)', 'stroke-width': 1 }, gridLayer)
				el('line', { x1: X(0), y1: 0, x2: X(0), y2: H, stroke: 'var(--paper-viz-line-strong)', 'stroke-width': 1 }, gridLayer)
				const every = opts.tickEvery || step * (scaleX * step < 28 ? 2 : 1)
				const everyY = opts.tickEveryY || (opts.equal === false ? stepY * (scaleY * stepY < 22 ? 2 : 1) : every)
				// Ticks: every grid step, or the widget's own list of values or {value, label}, such as π.
				const list = (custom, lo, hi, e) => {
					if (custom) return custom.map((t) => (typeof t === 'number' ? { value: t, label: fmt(t, 2) } : t)).filter((t) => t.value !== 0)
					const out = []
					for (let k = Math.ceil(lo / e) * e; k <= hi - e / 2; k += e) if (Math.abs(k) >= e / 2) out.push({ value: k, label: fmt(k, 2) })
					return out
				}
				// Tick labels stay clear of the edges, and other labels keep clear of them.
				for (const { value: x, label: text } of list(opts.xTicks, v.xMin, v.xMax, every)) {
					if (X(x) < 12 || X(x) > W - 12) continue
					const node = el('text', { x: X(x), y: Y(0) + 15, 'text-anchor': 'middle', class: 'paper-tick' }, gridLayer)
					node.textContent = text
					ticks.push({ x: X(x) - text.length * 3.5, y: Y(0) + 4, w: text.length * 7, h: 13, node })
				}
				for (const { value: y, label: text } of list(opts.yTicks, v.yMin, v.yMax, everyY)) {
					if (Y(y) < 12 || Y(y) > H - 12) continue
					const node = el('text', { x: X(0) - 6, y: Y(y) + 4, 'text-anchor': 'end', class: 'paper-tick' }, gridLayer)
					node.textContent = text
					ticks.push({ x: X(0) - 6 - text.length * 7, y: Y(y) - 7, w: text.length * 7, h: 13, node })
				}
				if (opts.xLabel) el('text', { x: W - 6, y: Y(0) - 6, 'text-anchor': 'end', class: 'paper-tick', 'font-style': 'italic' }, gridLayer).textContent = opts.xLabel
				if (opts.yLabel) el('text', { x: X(0) + 6, y: 14, class: 'paper-tick', 'font-style': 'italic' }, gridLayer).textContent = opts.yLabel
			}
		}

		// Labels avoid each other: each tries a few spots around its anchor.
		const overlaps = (b) => placed.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y)
		const inside = (b) => b.x >= 2 && b.y >= 2 && b.x + b.w <= W - 2 && b.y + b.h <= H - 2
		// Lines drawn this render, in screen pixels, so labels keep off them too.
		let segs = []
		let queue = []
		// Tick labels: other labels keep off them when they can.
		let ticks = []
		const hitsSegment = (b) => {
			const x0 = b.x - 1, y0 = b.y - 1, x1 = b.x + b.w + 1, y1 = b.y + b.h + 1
			for (const [ax, ay, bx, by] of segs) {
				// Liang-Barsky: does the segment enter the box?
				let t0 = 0, t1 = 1
				const dx = bx - ax, dy = by - ay
				let ok = true
				for (const [pp, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
					if (pp === 0) { if (q < 0) { ok = false; break } continue }
					const r = q / pp
					if (pp < 0) { if (r > t1) { ok = false; break } if (r > t0) t0 = r }
					else { if (r < t0) { ok = false; break } if (r < t1) t1 = r }
				}
				if (ok) return true
			}
			return false
		}
		// Labels are placed after the whole drawing, so each one can keep clear of
		// every line and every label placed before it.
		function placeLabel(px, py, text, o = {}) {
			queue.push([px, py, text, o])
		}
		function flushLabels() {
			const jobs = queue
			queue = []
			for (const [px, py, text, o] of jobs) layoutLabel(px, py, text, o)
			// A tick number crowding a label would read as part of it, so it goes.
			for (const t of ticks) {
				if (placed.some((b) => t.x < b.x + b.w + 6 && t.x + t.w > b.x - 6 && t.y < b.y + b.h + 3 && t.y + t.h > b.y - 3)) t.node.remove()
			}
		}
		function layoutLabel(px, py, text, o) {
			const size = o.size || 15
			// Each label sits on a small patch of paper, so a grid line or tick under it never cuts through the text.
			const patch = el('rect', { fill: 'var(--paper-card)', rx: 2 }, labelLayer)
			const t = el('text', { 'font-size': size, fill: ink(o.color), 'font-style': o.italic === false ? 'normal' : 'italic', 'font-weight': o.bold ? 600 : 400 }, labelLayer)
			// "proj_b a" writes b as a subscript.
			const parts = minus(text).split(/_([A-Za-z0-9])/)
			parts.forEach((part, i) => {
				if (!part) return
				const span = el('tspan', i % 2 ? { 'baseline-shift': 'sub', 'font-size': size * 0.72 } : {}, t)
				span.textContent = part
			})
			const bb = t.getBBox()
			const w = bb.width || text.length * size * 0.5, h = bb.height || size * 1.2
			const gap = o.gap ?? 6
			const spots = []
			if (o.away) {
				// away: a screen direction; the label moves that way until it clears its anchor, then further if it must.
				const [nx, ny] = o.away
				const d = gap + Math.abs(nx) * w / 2 + Math.abs(ny) * h / 2
				for (const extra of [0, 8, 16, 26]) spots.push([nx * (d + extra) - w / 2, ny * (d + extra) + h * 0.35])
				for (const along of [-24, 24, -48, 48]) spots.push([nx * d + ny * along - w / 2, ny * d - nx * along + h * 0.35])
			} else if (o.center) {
				spots.push([-w / 2, h * 0.35])
				for (const r of [12, 22, 34]) for (const [cx, cy] of [[0, -1], [1, 0], [0, 1], [-1, 0], [0.7, -0.7], [-0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]]) spots.push([cx * (r + w / 2) - w / 2, cy * (r + h / 2) + h * 0.35])
			} else if (o.dx !== undefined || o.dy !== undefined) spots.push([o.dx || 0, o.dy || 0])
			for (const k of o.away ? [] : [1, 2, 3]) {
				const g2 = gap * k
				spots.push([g2, -g2], [g2, g2 + h * 0.7], [-g2 - w, -g2], [-g2 - w, g2 + h * 0.7], [-w / 2, -g2 - 2], [-w / 2, h + g2])
			}
			const boxAt = ([dx, dy]) => ({ x: px + dx, y: py + dy - h * 0.78, w, h })
			let chosen = null
			// First clear of labels, ticks, and lines; then of labels and lines; then of labels only.
			// A label tied to a line (away) ignores ticks: its paper patch covers them.
			const tickHit = (b) => ticks.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y)
			for (const level of o.away ? [1, 0] : [2, 1, 0]) {
				for (const spot of spots) {
					const box = boxAt(spot)
					if (!inside(box) || overlaps(box)) continue
					if (level >= 1 && hitsSegment(box)) continue
					if (level >= 2 && tickHit(box)) continue
					chosen = [spot[0], spot[1], box]
					break
				}
				if (chosen) break
			}
			// Still nothing: search outward in a spiral for any spot clear of other labels.
			if (!chosen) {
				search: for (let r = 18; r <= 140; r += 14) {
					for (let k = 0; k < 12; k++) {
						const ang = (k / 12) * Math.PI * 2
						const spot = [Math.cos(ang) * (r + w / 2) - w / 2, Math.sin(ang) * (r + h / 2) + h * 0.35]
						const box = boxAt(spot)
						if (inside(box) && !overlaps(box) && !tickHit(box)) { chosen = [spot[0], spot[1], box]; break search }
					}
				}
			}
			if (!chosen) {
				const [dx, dy] = spots[0]
				const box = { x: Math.min(Math.max(2, px + dx), W - w - 2), y: Math.min(Math.max(2, py + dy - h * 0.78), H - h - 2), w, h }
				chosen = [box.x - px, box.y - py + h * 0.78, box]
			}
			t.setAttribute('x', px + chosen[0])
			t.setAttribute('y', py + chosen[1])
			const tb = t.getBBox()
			patch.setAttribute('x', tb.x - 2)
			patch.setAttribute('y', tb.y)
			patch.setAttribute('width', tb.width + 4)
			patch.setAttribute('height', tb.height)
			placed.push(chosen[2])
			return t
		}

		// Drawing primitives, in math coordinates. Later calls draw on top.
		const g = {
			/** A segment from p to q. */
			line(p, q, o = {}) {
				const [x1, y1] = P(p), [x2, y2] = P(q)
				segs.push([x1, y1, x2, y2])
				return el('line', { x1, y1, x2, y2, stroke: ink(o.color), 'stroke-width': o.width || 1.5, 'stroke-dasharray': o.dash ? (o.dash === true ? '5 4' : o.dash) : undefined, 'stroke-linecap': 'round', opacity: o.opacity }, drawLayer)
			},
			/** The whole line through p in direction d, clipped to the view. */
			fullLine(p, d, o = {}) {
				const len = Math.hypot(d[0], d[1])
				if (!len) return null
				const v = visible(), far = 2 * Math.hypot(v.xMax - v.xMin, v.yMax - v.yMin)
				const u = [d[0] / len, d[1] / len]
				const a = [p[0] - u[0] * far, p[1] - u[1] * far], b = [p[0] + u[0] * far, p[1] + u[1] * far]
				const line = g.line(a, b, { width: 1, color: o.color || 'var(--paper-viz-line)', dash: o.dash, ...o })
				if (o.label) {
					// The label sits on the line, just inside where it leaves the view.
					const m = 18 / scale
					let t = Infinity
					for (const [c, lo, hi] of [[0, v.xMin + m, v.xMax - m], [1, v.yMin + m, v.yMax - m]]) {
						if (Math.abs(u[c]) < 1e-9) continue
						const edge = u[c] > 0 ? hi : lo
						t = Math.min(t, (edge - p[c]) / u[c])
					}
					if (Number.isFinite(t) && t > 0) {
						const at = [p[0] + u[0] * t * 0.92, p[1] + u[1] * t * 0.92]
						placeLabel(X(at[0]), Y(at[1]), o.label, { color: o.labelColor || 'var(--paper-viz-data)', size: 13, away: [-u[1], -u[0]], gap: 4 })
					}
				}
				return line
			},
			/**
			 * An arrow from p to q. The head is a fixed size in screen pixels, and
			 * shrinks for a short arrow so it never covers the shaft.
			 */
			arrow(p, q, o = {}) {
				const [x1, y1] = P(p), [x2, y2] = P(q)
				const len = Math.hypot(x2 - x1, y2 - y1)
				const color = ink(o.color)
				const grp = el('g', { opacity: o.opacity }, drawLayer)
				if (len < 0.5) {
					el('circle', { cx: x1, cy: y1, r: 3, fill: color }, grp)
					return grp
				}
				const width = o.width || 2
				const head = Math.min(o.head || 11, len * 0.45)
				const ux = (x2 - x1) / len, uy = (y2 - y1) / len
				const bx = x2 - ux * head, by = y2 - uy * head
				const half = head * 0.42
				segs.push([x1, y1, x2, y2])
				el('line', { x1, y1, x2: bx + ux, y2: by + uy, stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-dasharray': o.dash ? (o.dash === true ? '6 4' : o.dash) : undefined }, grp)
				el('path', { d: `M${x2},${y2} L${bx - uy * half},${by + ux * half} L${bx + uy * half},${by - ux * half} Z`, fill: color, 'stroke-linejoin': 'round' }, grp)
				if (o.label) {
					// By default the label sits just past the tip, centred on the line of the arrow;
					// labelAt below 1 puts it beside the shaft instead.
					const at = o.labelAt ?? 1
					if (at >= 1) {
						const ahead = 12 + (o.labelSize || 15) * 0.5
						placeLabel(x2 + ux * ahead, y2 + uy * ahead, o.label, { color, bold: o.bold, italic: o.italic, size: o.labelSize, center: true })
					} else {
						const side = o.labelSide === 'right' ? -1 : 1
						const lx = x1 + (x2 - x1) * at, ly = y1 + (y2 - y1) * at
						placeLabel(lx + uy * 12 * side, ly - ux * 12 * side, o.label, { color, bold: o.bold, italic: o.italic, size: o.labelSize, center: true })
					}
				}
				return grp
			},
			/**
			 * A label beside the segment from p to q, at fraction `at` along it (default 0.5),
			 * on its left (side 1, the default) or right (side -1), clear of the line.
			 */
			tag(p, q, text, o = {}) {
				const [x1, y1] = P(p), [x2, y2] = P(q)
				const len = Math.hypot(x2 - x1, y2 - y1) || 1
				const side = o.side ?? 1
				const at = o.at ?? 0.5
				return placeLabel(x1 + (x2 - x1) * at, y1 + (y2 - y1) * at, text, { ...o, away: [((y2 - y1) / len) * side, (-(x2 - x1) / len) * side] })
			},
			/** A dot. */
			point(p, o = {}) {
				const [x, y] = P(p)
				const c = el('circle', { cx: x, cy: y, r: o.r || 3.5, fill: o.hollow ? 'var(--paper-card)' : ink(o.color), stroke: ink(o.color), 'stroke-width': 1.5 }, drawLayer)
				if (o.label) placeLabel(x, y, o.label, { color: o.color, size: o.labelSize })
				return c
			},
			/** Text at p: centred on it with center: true, offset (dx, dy) pixels, or placed clear of other labels. */
			label(p, text, o = {}) {
				const [x, y] = P(p)
				return placeLabel(x, y, text, o)
			},
			/** A polyline or closed polygon through points. */
			path(points, o = {}) {
				if (!points.length) return null
				const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0])},${Y(p[1])}`).join(' ') + (o.close ? ' Z' : '')
				return el('path', { d, fill: o.fill || 'none', stroke: o.color === null ? 'none' : ink(o.color), 'stroke-width': o.width || 1.5, 'stroke-dasharray': o.dash ? (o.dash === true ? '5 4' : o.dash) : undefined, opacity: o.opacity, 'stroke-linejoin': 'round' }, drawLayer)
			},
			/** y = f(x) across the view. */
			fn(f, o = {}) {
				const v = visible()
				const pts = []
				const n = o.samples || Math.max(60, Math.round(W / 2))
				for (let i = 0; i <= n; i++) {
					const x = v.xMin + ((v.xMax - v.xMin) * i) / n
					const y = f(x)
					if (Number.isFinite(y)) pts.push([x, Math.max(v.yMin - 10, Math.min(v.yMax + 10, y))])
				}
				return g.path(pts, o)
			},
			/**
			 * The angle at `at` from direction d1 to direction d2 (the smaller one),
			 * as an arc of radius r pixels, with an optional label at its middle.
			 */
			angle(at, d1, d2, o = {}) {
				const a1 = Math.atan2(d1[1], d1[0]), a2 = Math.atan2(d2[1], d2[0])
				let sweep = a2 - a1
				while (sweep > Math.PI) sweep -= 2 * Math.PI
				while (sweep < -Math.PI) sweep += 2 * Math.PI
				if (!Math.hypot(...d1) || !Math.hypot(...d2)) return null
				const r = o.r || 26
				const [cx, cy] = P(at)
				const pt = (a) => [cx + r * Math.cos(a), cy - r * Math.sin(a)]
				const [sx, sy] = pt(a1), [ex, ey] = pt(a1 + sweep)
				const large = Math.abs(sweep) > Math.PI ? 1 : 0
				const sweepFlag = sweep > 0 ? 0 : 1
				const arc = el('path', { d: `M${sx},${sy} A${r},${r} 0 ${large} ${sweepFlag} ${ex},${ey}`, fill: 'none', stroke: ink(o.color || 'var(--paper-viz-data)'), 'stroke-width': o.width || 1.25 }, drawLayer)
				if (o.label) {
					// The label sits inside the angle, far enough out to fit between its arms.
					const mid = a1 + sweep / 2
					const width = (o.labelSize || 14) * 0.52 * String(o.label).length
					const fit = width / 2 / Math.max(0.15, Math.sin(Math.abs(sweep) / 2))
					const lr = Math.min(o.maxLabelR || 150, Math.max(r + 16, fit * 1.3 + 12))
					placeLabel(cx + lr * Math.cos(mid), cy - lr * Math.sin(mid), o.label, { color: o.labelColor || o.color || 'var(--paper-viz-data)', size: o.labelSize || 14, center: true })
				}
				return arc
			},
			/** A right-angle mark at `at` between directions d1 and d2, size s pixels. */
			rightAngle(at, d1, d2, o = {}) {
				const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2)
				if (!l1 || !l2) return null
				const s = o.size || 10
				const [cx, cy] = P(at)
				const u = [d1[0] / l1, -d1[1] / l1], w = [d2[0] / l2, -d2[1] / l2]
				const d = `M${cx + u[0] * s},${cy + u[1] * s} L${cx + (u[0] + w[0]) * s},${cy + (u[1] + w[1]) * s} L${cx + w[0] * s},${cy + w[1] * s}`
				return el('path', { d, fill: 'none', stroke: ink(o.color || 'var(--paper-viz-data)'), 'stroke-width': o.width || 1.25 }, drawLayer)
			},
		}

		const api = {
			svg,
			get scale() { return scale },
			get view() { return { ...view } },
			x: X,
			y: Y,
			px: P,
			/** Screen pixels in the plot to math coordinates. */
			toMath(px, py) { return [(px - ox) / scaleX, (oy - py) / scaleY] },
			/** The visible math region. */
			visible,
			/**
			 * Take new options from a second paper.plot call on the same element: the
			 * range becomes the view (not during a drag), the rest replace the old ones.
			 */
			reconfigure(next = {}) {
				const range = {}
				for (const k of ['xMin', 'xMax', 'yMin', 'yMax']) if (next[k] !== undefined) range[k] = next[k]
				for (const [k, v] of Object.entries(next)) if (!(k in range)) opts[k] = v
				if (!dragging && Object.keys(range).length) view = { ...view, ...range }
				return api
			},
			/** Set the view. Ignored while a handle is being dragged. */
			view(next) {
				if (dragging) return false
				view = { ...view, ...next }
				api.render()
				return true
			},
			/**
			 * Make sure every point is in view, growing the view (never shrinking it)
			 * once the user lets go. Use it for derived points, such as a projection,
			 * that the user does not drag directly.
			 */
			ensure(points, margin = 0.6) {
				const v = visible()
				let grow = 1
				for (const p of points) {
					if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue
					const cx = (view.xMin + view.xMax) / 2, cy = (view.yMin + view.yMax) / 2
					const hx = (view.xMax - view.xMin) / 2, hy = (view.yMax - view.yMin) / 2
					const need = Math.max((Math.abs(p[0] - cx) + margin) / hx, (Math.abs(p[1] - cy) + margin) / hy)
					if (need > grow && (p[0] < v.xMin + margin || p[0] > v.xMax - margin || p[1] < v.yMin + margin || p[1] > v.yMax - margin)) grow = need
				}
				if (grow <= 1) return false
				if (dragging) { pendingEnsure = points; return false }
				const cx = (view.xMin + view.xMax) / 2, cy = (view.yMin + view.yMax) / 2
				const hx = ((view.xMax - view.xMin) / 2) * grow, hy = ((view.yMax - view.yMin) / 2) * grow
				view = { xMin: cx - hx, xMax: cx + hx, yMin: cy - hy, yMax: cy + hy }
				setTimeout(() => api.render(), 0)
				return true
			},
			/**
			 * Draw the plot: clears the drawing and calls draw(g) with the drawing
			 * primitives. Call it from the widget's render function; the handles
			 * then move to their current values.
			 */
			draw(fn) {
				painter = fn
				api.render()
			},
			render() {
				measure()
				placed = []
				segs = []
				queue = []
				ticks = []
				drawGrid()
				drawLayer.textContent = ''
				labelLayer.textContent = ''
				// Handles keep their labels clear of other labels.
				for (const h of handles) {
					const [x, y] = P(h.position())
					placed.push({ x: x - 9, y: y - 9, w: 18, h: 18 })
				}
				if (painter) painter(g)
				flushLabels()
				for (const h of handles) h.place()
			},
			/**
			 * A draggable handle for a point. get() returns [x, y]; set(x, y) is
			 * called on drag and arrow keys with values clamped to the view and
			 * snapped to `snap`. The element is kept between renders, so keyboard
			 * focus and key repeat work.
			 */
			handle(options) {
				const key = options.name || options.label || 'handle'
				const again = handles.find((x) => x.key === key)
				if (again) {
					Object.assign(again.cfg, options)
					again.place()
					return again
				}
				// The options live in one object, so a second call with the same name updates them.
				const o = { ...options }
				const color = ink(o.color)
				const node = el('g', { class: 'paper-handle', tabindex: 0, role: 'slider', 'aria-label': o.label || 'handle', 'data-handle': o.name || o.label || 'handle' }, handleLayer)
				el('circle', { r: 16, fill: 'transparent' }, node)
				el('circle', { class: 'focus', r: 11 }, node)
				const ring = el('circle', { class: 'ring', r: 7 }, node)
				const dot = el('circle', { class: 'dot', r: 2.5 }, node)
				if (o.color !== undefined) { ring.style.stroke = color; dot.style.fill = color }
				const snap = o.snap ?? 0.1
				const step = o.step ?? snap ?? 0.1
				const clampTo = () => {
					const v = visible()
					const m = (o.margin ?? 12) / scale
					return { xMin: v.xMin + m, xMax: v.xMax - m, yMin: v.yMin + m, yMax: v.yMax - m }
				}
				const put = (x, y) => {
					const b = clampTo()
					x = Math.min(b.xMax, Math.max(b.xMin, x))
					y = Math.min(b.yMax, Math.max(b.yMin, y))
					if (snap) { x = Math.round(x / snap) * snap; y = Math.round(y / snap) * snap }
					x = +x.toFixed(6); y = +y.toFixed(6)
					if (Object.is(x, -0)) x = 0
					if (Object.is(y, -0)) y = 0
					o.set(x, y)
				}
				let grab = null
				node.addEventListener('pointerdown', (e) => {
					if (e.button !== 0) return
					e.preventDefault()
					node.focus({ preventScroll: true })
					try { node.setPointerCapture(e.pointerId) } catch (err) {}
					const r = svg.getBoundingClientRect()
					const sx = W / r.width, sy = H / r.height
					const [hx, hy] = P(o.get())
					grab = { id: e.pointerId, dx: hx - (e.clientX - r.left) * sx, dy: hy - (e.clientY - r.top) * sy, sx, sy, r }
					dragging++
					node.classList.add('dragging')
					o.start && o.start()
				})
				const move = (e) => {
					if (!grab || e.pointerId !== grab.id) return
					const px = (e.clientX - grab.r.left) * grab.sx + grab.dx
					const py = (e.clientY - grab.r.top) * grab.sy + grab.dy
					const [x, y] = api.toMath(px, py)
					put(x, y)
				}
				const end = (e) => {
					if (!grab || (e && e.pointerId !== undefined && e.pointerId !== grab.id)) return
					grab = null
					dragging = Math.max(0, dragging - 1)
					node.classList.remove('dragging')
					o.end && o.end()
					if (!dragging && pendingEnsure) { const p = pendingEnsure; pendingEnsure = null; api.ensure(p) }
				}
				node.addEventListener('pointermove', move)
				window.addEventListener('pointermove', move)
				node.addEventListener('pointerup', end)
				window.addEventListener('pointerup', end)
				node.addEventListener('pointercancel', end)
				node.addEventListener('keydown', (e) => {
					const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key]
					if (!k) return
					e.preventDefault()
					const s = step * (e.shiftKey ? 10 : 1)
					const [x, y] = o.get()
					put(x + k[0] * s, y + k[1] * s)
				})
				const h = {
					key,
					cfg: o,
					node,
					position: () => o.get(),
					place() {
						const [x, y] = P(o.get())
						node.setAttribute('transform', `translate(${x},${y})`)
						const [vx, vy] = o.get()
						node.setAttribute('aria-valuetext', `${o.label || ''} ${vec([vx, vy], 2)}`)
					},
				}
				handles.push(h)
				h.place()
				return h
			},
		}
		measure()
		if (typeof ResizeObserver === 'function') new ResizeObserver(() => api.render()).observe(host)
		madeIn(host, 'plot').set('plot', api)
		return api
	}

	function niceStep(raw) {
		const p = 10 ** Math.floor(Math.log10(raw || 1))
		const n = raw / p
		return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p
	}

	// Controls --------------------------------------------------------------

	/**
	 * A labelled slider row with units: name, track, value. onInput(v) gets each
	 * value while the user drags. Returns { el, input, set(v) }.
	 */
	function slider(target, options) {
		const host = resolve(target)
		const key = options.label || options.name || ''
		const again = madeBefore(host, 'slider', key, (p) => p.el)
		if (again) {
			Object.assign(again.cfg, options)
			for (const k of ['min', 'max', 'step']) if (options[k] !== undefined) again.input[k] = options[k]
			again.set(options.value !== undefined ? options.value : Number(again.input.value))
			return again
		}
		const o = { ...options }
		const row = html('label', 'paper-slider', host)
		html('span', 'paper-slider-name', row, o.label || o.name || '')
		const input = html('input', '', row)
		input.type = 'range'
		input.min = o.min ?? 0
		input.max = o.max ?? 1
		input.step = o.step ?? 0.01
		input.value = o.value ?? o.min ?? 0
		input.setAttribute('aria-label', o.label || o.name || 'value')
		const out = html('span', 'paper-slider-value', row)
		const digits = o.digits ?? Math.max(0, -Math.floor(Math.log10(Number(input.step) || 1)))
		const show = () => {
			const v = Number(input.value)
			const span = Number(input.max) - Number(input.min)
			input.style.setProperty('--fill', `${span ? ((v - Number(input.min)) / span) * 100 : 0}%`)
			out.textContent = (o.format ? o.format(v) : fmt(v, digits)) + (o.unit ? ` ${o.unit}` : '')
		}
		input.addEventListener('input', () => { show(); o.onInput && o.onInput(Number(input.value)) })
		input.addEventListener('change', () => { o.onChange && o.onChange(Number(input.value)) })
		show()
		const api = { el: row, input, cfg: o, set(v) { input.value = v; show() } }
		madeIn(host, 'slider').set(key, api)
		return api
	}

	/**
	 * A readout: rows of [name, value] (or { name, value, note }). Call set(rows)
	 * to update it in place.
	 */
	function readout(target, rows) {
		const host = resolve(target)
		const again = madeBefore(host, 'readout', 'readout', (p) => p.el)
		if (again) {
			again.set(rows)
			return again
		}
		const grid = html('div', 'paper-readout', host)
		const api = {
			el: grid,
			set(next) {
				grid.textContent = ''
				for (const r of next || []) {
					const row = Array.isArray(r) ? { name: r[0], value: r[1] } : r
					if (row.note !== undefined && row.name === undefined) { html('div', 'paper-readout-note', grid, minus(row.note)); continue }
					fill(html('div', 'paper-readout-name', grid), row.name)
					const v = fill(html('div', 'paper-readout-value', grid), row.value)
					if (row.color !== undefined) v.style.color = ink(row.color)
					if (row.note) fill(html('div', 'paper-readout-note', grid), row.note)
				}
			},
		}
		api.set(rows)
		madeIn(host, 'readout').set('readout', api)
		return api
	}

	/** Text, or { html } for markup such as a subscript, into an element. */
	function fill(node, content) {
		if (content && typeof content === 'object' && 'html' in content) node.innerHTML = content.html
		else node.textContent = minus(content ?? '')
		return node
	}

	/** A row of preset buttons; onPick(name) is called on a click. */
	function presets(target, names, onPick) {
		const host = resolve(target)
		const again = madeBefore(host, 'presets', 'presets', (p) => p.el)
		if (again && again.names.join('|') === names.join('|')) {
			again.onPick = onPick
			return again
		}
		if (again) again.el.remove()
		const row = html('div', 'paper-presets', host)
		const api = { el: row, names: [...names], onPick, buttons: [], mark(name) { for (const b of api.buttons) b.setAttribute('aria-pressed', String(b.textContent === name)) } }
		api.buttons = names.map((name) => {
			const b = html('button', 'paper-button', row, name)
			b.type = 'button'
			b.addEventListener('click', () => api.onPick(name))
			return b
		})
		madeIn(host, 'presets').set('presets', api)
		return api
	}

	const paper = Object.freeze({ fmt, num, eq, vec, deg, minus, isExact, plot, slider, readout, presets, inks: INKS, accent: ACCENT, MINUS })
	Object.defineProperty(window, 'paper', { value: paper, configurable: false, writable: false })
})()
