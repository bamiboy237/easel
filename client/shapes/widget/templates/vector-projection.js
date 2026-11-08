// Vector norms and projections: a hand-written widget template, built from the
// paper kit. Two draggable vectors a and b; the plot shows the angle, the line
// of b, the line where a·b = 0, the projection of a onto b with its right-angle
// mark, and the side column shows the exact working for every number.
const { fmt, num, eq, vec, MINUS } = paper

const PRESETS = {
	Start: [2, 3, 4, 1],
	Parallel: [2, 1, 4, 2],
	Perpendicular: [1, 3, 3, -1],
	Obtuse: [-2, 3, 4, 1],
	Opposite: [-2, -1, 4, 2],
}

const view = { xMin: -6, xMax: 6, yMin: -4.5, yMax: 4.5 }
const plot = paper.plot('#plot', { ...view, label: 'Vectors a and b on a grid', xLabel: 'x', yLabel: 'y' })

const get = () => {
	const s = easel.state
	const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
	return { ax: n(s.ax, 2), ay: n(s.ay, 3), bx: n(s.bx, 4), by: n(s.by, 1) }
}

// Exact text for a square root: √13, or √25 = 5 when it is a whole square.
const rootOf = (s) => {
	const r = Math.sqrt(s)
	return { text: `√${fmt(s, 4)}`, value: r, exact: paper.isExact(r, 2) }
}
const normWorking = (x, y) => {
	const s = x * x + y * y
	const r = rootOf(s)
	return `√(${num(x)}² + ${num(y)}²) = ${r.text} ${eq(r.value)}`
}

function compute(v) {
	const { ax, ay, bx, by } = v
	const na = Math.hypot(ax, ay)
	const nb = Math.hypot(bx, by)
	const dot = ax * bx + ay * by
	const cross = ax * by - ay * bx
	const sb = bx * bx + by * by
	const zeroA = na < 1e-9
	const zeroB = nb < 1e-9
	let theta = null
	if (!zeroA && !zeroB) {
		// Exact cases first, so 90° and 0° read as exact.
		if (Math.abs(dot) < 1e-9) theta = Math.PI / 2
		else if (Math.abs(cross) < 1e-9) theta = dot > 0 ? 0 : Math.PI
		else theta = Math.acos(Math.max(-1, Math.min(1, dot / (na * nb))))
	}
	const k = zeroB ? null : dot / sb
	const proj = zeroB ? null : [k * bx, k * by]
	return { ...v, na, nb, dot, cross, sb, theta, k, proj, comp: zeroB ? null : dot / nb, zeroA, zeroB }
}

const presets = paper.presets('#presets', Object.keys(PRESETS), (name) => {
	const [ax, ay, bx, by] = PRESETS[name]
	easel.setState('ax', ax)
	easel.setState('ay', ay)
	easel.setState('bx', bx)
	easel.setState('by', by)
})
const readout = paper.readout('#readout', [])
const meaning = document.getElementById('meaning')

// The handles: a in ink, b in blue.
plot.handle({
	name: 'a',
	label: 'tip of a',
	color: 0,
	get: () => [get().ax, get().ay],
	set: (x, y) => {
		easel.setState('ax', x)
		easel.setState('ay', y)
	},
})
plot.handle({
	name: 'b',
	label: 'tip of b',
	color: 2,
	get: () => [get().bx, get().by],
	set: (x, y) => {
		easel.setState('bx', x)
		easel.setState('by', y)
	},
})

const RED = 1, BLUE = 2, INK = 0, GREEN = 3
const deg = (rad) => (rad * 180) / Math.PI

function render() {
	const c = compute(get())
	const a = [c.ax, c.ay], b = [c.bx, c.by], o = [0, 0]
	const name = Object.keys(PRESETS).find((n) => PRESETS[n].every((v, i) => Math.abs(v - [c.ax, c.ay, c.bx, c.by][i]) < 1e-9))
	presets.mark(name || '')

	plot.draw((g) => {
		if (!c.zeroB) {
			// The line of b, and the line through the origin where a·b = 0.
			g.fullLine(o, b, { color: 'var(--paper-viz-line)', label: 'line of b' })
			g.fullLine(o, [-c.by, c.bx], { color: 'var(--paper-viz-line)', dash: '2 4', label: `a·b = 0` })
		}
		if (c.theta !== null && c.theta > 1e-6 && Math.abs(c.theta - Math.PI) > 1e-6 && Math.abs(c.theta - Math.PI / 2) > 1e-9) {
			g.angle(o, b, a, { color: GREEN, r: 44, label: `θ ${eq(deg(c.theta), 1)}°` })
		}
		if (c.proj) {
			const p = c.proj
			const perp = [c.ax - p[0], c.ay - p[1]]
			const hasPerp = Math.hypot(...perp) > 1e-6
			// a − proj, from the tip of a to the foot on the line of b.
			if (hasPerp) {
				g.line(a, p, { color: 'var(--paper-viz-data)', dash: '5 4', width: 1.25 })
				const along = Math.hypot(...p) > 1e-6 ? [-p[0], -p[1]] : [c.bx, c.by]
				g.rightAngle(p, along, perp, { size: 11 })
			}
			// The projection, the most important mark, drawn as a wide band under b, so both read.
			if (Math.hypot(...p) > 1e-6) {
				g.arrow(o, p, { color: RED, width: 6, head: 15 })
				const mid = [p[0] / 2, p[1] / 2]
				const len = Math.hypot(...p)
				// Its label sits on the side away from a, so it does not sit on the angle.
				const side = c.cross > 0 ? 1 : -1
				const nx = (p[1] / len) * side, ny = (-p[0] / len) * side
				g.label([mid[0] + nx * 0.55, mid[1] + ny * 0.55], `proj_b a`, { color: RED, dx: -24, dy: 5 })
			} else {
				g.point(o, { color: RED, r: 4.5 })
			}
		}
		if (!c.zeroB) g.arrow(o, b, { color: BLUE, width: 2, label: 'b', bold: true, labelSize: 17 })
		else g.point(o, { color: BLUE, r: 4, label: 'b = 0' })
		if (!c.zeroA) g.arrow(o, a, { color: INK, width: 2.25, label: 'a', bold: true, labelSize: 17 })
		if (!c.zeroA) g.label([c.ax / 2, c.ay / 2], `‖a‖ ${eq(c.na)}`, { color: INK, size: 13, italic: false })
		if (!c.zeroB) g.label([c.bx / 2, c.by / 2], `‖b‖ ${eq(c.nb)}`, { color: BLUE, size: 13, italic: false })
	})
	// A projection outside the view widens it once the user lets go.
	if (c.proj) plot.ensure([c.proj, a, b])

	const rows = [
		{ name: 'a', value: vec(a) },
		{ name: 'b', value: vec(b) },
		{ name: '‖a‖', value: normWorking(c.ax, c.ay) },
		{ name: '‖b‖', value: normWorking(c.bx, c.by) },
		{ name: 'a·b', value: `${num(c.ax)}·${num(c.bx)} + ${num(c.ay)}·${num(c.by)} ${eq(c.dot)}` },
	]
	if (c.theta === null) {
		rows.push({ name: 'θ', value: 'undefined: a zero vector has no direction' })
	} else {
		const ra = rootOf(c.na * c.na), rb = rootOf(c.sb)
		rows.push({ name: 'θ', value: `cos θ = ${fmt(c.dot, 4)} / (${ra.text} · ${rb.text}), so θ ${eq(deg(c.theta), 1)}°`, color: GREEN })
	}
	if (c.zeroB) {
		rows.push({ name: { html: 'comp<sub>b</sub> a' }, value: 'undefined: b is the zero vector' })
		rows.push({ name: { html: 'proj<sub>b</sub> a' }, value: 'undefined' })
	} else {
		const rb = rootOf(c.sb)
		rows.push({ name: { html: 'comp<sub>b</sub> a' }, value: `a·b / ‖b‖ = ${fmt(c.dot, 4)} / ${rb.text} ${eq(c.comp)}`, note: `the signed length of the projection, also ‖a‖ cos θ` })
		const exact = paper.isExact(c.proj[0]) && paper.isExact(c.proj[1])
		rows.push({
			name: { html: 'proj<sub>b</sub> a' },
			value: `(a·b / ‖b‖²) b = (${fmt(c.dot, 4)} / ${fmt(c.sb, 4)})${vec(b)} ${exact ? '=' : '≈'} ${vec(c.proj)}`,
			color: RED,
		})
	}
	readout.set(rows)

	let text
	if (c.zeroB) text = 'b is the zero vector, so it has no direction: the angle and the projection onto b are undefined.'
	else if (c.zeroA) text = 'a is the zero vector, so its projection onto b is the zero vector too.'
	else if (Math.abs(c.dot) < 1e-9) text = 'a·b = 0, so a is perpendicular to b. Its shadow on the line of b is a single point: the projection is the zero vector.'
	else if (Math.abs(c.cross) < 1e-9) text = c.dot > 0 ? 'a lies along b, so the projection of a onto b is a itself, and θ = 0°.' : 'a points against b, so the projection is a itself, the scalar projection is negative, and θ = 180°.'
	else if (c.dot > 0) text = `a·b > 0, so θ is under 90° and the projection points along b. It is the point on the line of b closest to the tip of a, where the dashed line meets it at a right angle.`
	else text = `a·b < 0, so θ is over 90°: the tip of a is past the line a·b = 0, and the projection points against b, so the scalar projection is negative.`
	meaning.textContent = paper.minus(text)
}

easel.onChange(render)
render()
