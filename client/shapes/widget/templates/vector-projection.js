// Vector norms and projections: a hand-written widget template, built from the
// paper kit. Two draggable vectors a and b. The plot shows the angle, the line
// of b, the line perpendicular to b where a·b = 0, and the projection of a onto
// b with the dropped perpendicular and its right-angle mark. The side column
// gives each result with its exact working.
const { fmt, eq } = paper
// Working shows every digit the values have (up to eight), so a substitution is never rounded.
const num = (x) => paper.num(x, 8)
const vec = (v, d = 8) => paper.vec(v, d)
const exactText = (x) => fmt(x, 8)

const PRESETS = {
	Reset: [2, 3, 4, 1],
	Parallel: [2, 1, 4, 2],
	Perpendicular: [1, 3, 3, -1],
	Obtuse: [-2, 3, 4, 1],
	Opposite: [-2, -1, 4, 2],
}

// Inks: a in full ink, b in the data grey, and the projection, the result, in the accent.
const A = 0
const B = '#747471'
const PROJ = '#344c41'
const QUIET = '#9a9a97'
// Text that changes, such as the angle, is darker than the construction lines.
const ANGLE = '#5c5c59'

const view = { xMin: -6, xMax: 6, yMin: -4.5, yMax: 4.5 }
const plot = paper.plot('#plot', { ...view, label: 'Vectors a and b on a grid', xLabel: 'x', yLabel: 'y' })

const get = () => {
	const s = easel.state
	const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
	return { ax: n(s.ax, 2), ay: n(s.ay, 3), bx: n(s.bx, 4), by: n(s.by, 1) }
}

// Exact text for a square root: √13, or 5 when it is a whole square.
const root = (s) => {
	const r = Math.sqrt(s)
	return paper.isExact(r, 2) ? fmt(r) : `√${exactText(s)}`
}

function compute(v) {
	const { ax, ay, bx, by } = v
	const na = Math.hypot(ax, ay)
	const nb = Math.hypot(bx, by)
	const dot = ax * bx + ay * by
	const cross = ax * by - ay * bx
	const sa = ax * ax + ay * ay
	const sb = bx * bx + by * by
	const zeroA = na < 1e-9
	const zeroB = nb < 1e-9
	let theta = null
	if (!zeroA && !zeroB) {
		// Exact cases first, so 90°, 0°, and 180° read as exact.
		if (Math.abs(dot) < 1e-9) theta = Math.PI / 2
		else if (Math.abs(cross) < 1e-9) theta = dot > 0 ? 0 : Math.PI
		else theta = Math.acos(Math.max(-1, Math.min(1, dot / (na * nb))))
	}
	const proj = zeroB ? null : [(dot / sb) * bx, (dot / sb) * by]
	return { ...v, na, nb, dot, cross, sa, sb, theta, proj, comp: zeroB ? null : dot / nb, zeroA, zeroB }
}

const presets = paper.presets('#presets', Object.keys(PRESETS), (name) => {
	const [ax, ay, bx, by] = PRESETS[name]
	plot.view(view)
	easel.setState('ax', ax)
	easel.setState('ay', ay)
	easel.setState('bx', bx)
	easel.setState('by', by)
})
const readout = paper.readout('#readout', [])
// Stretch b along its own line, so the learner can see the projection does not
// depend on b's length. It lengthens b by 1.5, or halves it when longer would
// leave the view, and never turns it. The projection before the stretch stays
// as a faint outline for comparison, until the next change.
const stretch = document.getElementById('stretch')
let before = null
const stretchFactor = () => {
	const { bx, by } = get()
	const v = plot.visible()
	const fits = (k) => Math.abs(bx * k) < Math.min(-v.xMin, v.xMax) - 0.3 && Math.abs(by * k) < Math.min(-v.yMin, v.yMax) - 0.3
	return fits(1.5) ? 1.5 : 0.5
}
stretch.addEventListener('click', () => {
	const c = compute(get())
	if (c.zeroB) return
	const k = stretchFactor()
	before = { proj: c.proj, a: [c.ax, c.ay], b: [c.bx, c.by] }
	easel.setState('bx', c.bx * k)
	easel.setState('by', c.by * k)
})
const legs = document.getElementById('legs')
legs.addEventListener('change', () => render())
const meaning = document.getElementById('meaning')

plot.handle({
	name: 'a',
	label: 'tip of a',
	color: A,
	get: () => [get().ax, get().ay],
	set: (x, y) => {
		easel.setState('ax', x)
		easel.setState('ay', y)
	},
})
plot.handle({
	name: 'b',
	label: 'tip of b',
	color: B,
	get: () => [get().bx, get().by],
	set: (x, y) => {
		easel.setState('bx', x)
		easel.setState('by', y)
	},
})

const deg = (rad) => (rad * 180) / Math.PI

function render() {
	const c = compute(get())
	const a = [c.ax, c.ay], b = [c.bx, c.by], o = [0, 0]
	const name = Object.keys(PRESETS).find((n) => PRESETS[n].every((v, i) => Math.abs(v - [c.ax, c.ay, c.bx, c.by][i]) < 1e-9))
	presets.mark(name || '')
	// The stretch comparison holds only while b keeps its direction and a stays put.
	const stretched = before && c.proj && before.a[0] === c.ax && before.a[1] === c.ay && before.b[0] * c.bx + before.b[1] * c.by > 0 && Math.abs(before.b[0] * c.by - before.b[1] * c.bx) < 1e-9 && Math.abs(c.proj[0] - before.proj[0]) < 1e-9 && Math.abs(c.proj[1] - before.proj[1]) < 1e-9 && Math.hypot(c.bx - before.b[0], c.by - before.b[1]) > 1e-9
	if (!stretched) before = null
	const k = c.zeroB ? 1 : stretchFactor()
	stretch.innerHTML = k > 1 ? 'Lengthen <var>b</var> ×1.5' : 'Halve <var>b</var>'
	stretch.disabled = c.zeroB

	plot.draw((g) => {
		if (!c.zeroB) {
			// The line of b, and the line through the origin perpendicular to b, where a·b = 0.
			g.fullLine(o, b, { color: 'var(--paper-viz-line)', label: 'line of b' })
			g.fullLine(o, [-c.by, c.bx], { color: 'var(--paper-viz-line)', dash: '2 4', label: 'a·b = 0 on this line' })
		}
		if (legs.checked && !c.zeroA) {
			// The right triangle behind ‖a‖: legs along the axes, hypotenuse a.
			g.line(o, [c.ax, 0], { color: QUIET, dash: '2 3', width: 1.25 })
			g.line([c.ax, 0], a, { color: QUIET, dash: '2 3', width: 1.25 })
			if (Math.abs(c.ax) > 1e-9 && Math.abs(c.ay) > 1e-9) g.rightAngle([c.ax, 0], [-c.ax, 0], [0, c.ay], { size: 9, color: QUIET })
			if (Math.abs(c.ax) > 1e-9) g.tag(o, [c.ax, 0], `${fmt(Math.abs(c.ax))}`, { color: ANGLE, size: 13, italic: false, side: (c.ax > 0) === (c.ay > 0) ? -1 : 1 })
			if (Math.abs(c.ay) > 1e-9) g.tag([c.ax, 0], a, `${fmt(Math.abs(c.ay))}`, { color: ANGLE, size: 13, italic: false, side: (c.ax > 0) === (c.ay > 0) ? -1 : 1 })
		}
		const special = c.theta === null || c.theta < 1e-6 || Math.abs(c.theta - Math.PI) < 1e-6 || Math.abs(c.theta - Math.PI / 2) < 1e-9
		if (!special) g.angle(o, b, a, { color: QUIET, labelColor: ANGLE, r: 40, label: `θ ${eq(deg(c.theta), 1)}°` })
		else if (c.theta !== null) g.label(o, `θ = ${fmt(deg(c.theta), 1)}°`, { color: ANGLE, size: 14, dx: 10, dy: 22 })
		const p = c.proj
		const hasProj = p && Math.hypot(...p) > 1e-6
		if (p) {
			const perp = [c.ax - p[0], c.ay - p[1]]
			// The perpendicular dropped from the tip of a to the line of b, meeting it at p.
			if (Math.hypot(...perp) > 1e-6) {
				g.line(a, p, { color: QUIET, dash: '5 4', width: 1.25 })
				g.rightAngle(p, hasProj ? [-p[0], -p[1]] : b, perp, { size: 11, color: QUIET })
			}
		}
		// Where the tip of b was before the stretch, to compare with.
		if (stretched) g.point(before.b, { color: QUIET, r: 5, hollow: true, label: 'b before', labelSize: 13 })
		// The projection, the result, is a broad band with a and b drawn thin over it, so all
		// three stay visible when they share a line.
		if (hasProj) g.arrow(o, p, { color: PROJ, width: 7, head: 17 })
		if (!c.zeroB) g.arrow(o, b, { color: B, width: 2, label: `b ${vec(b)}`, bold: true, labelSize: 16 })
		else g.point(o, { color: B, r: 4, label: 'b = 0' })
		if (!c.zeroA) g.arrow(o, a, { color: A, width: 2, label: `a ${vec(a)}`, bold: true, labelSize: 16 })
		if (hasProj) {
			// Its label goes on the side away from a, clear of the angle.
			const same = !c.zeroA && Math.abs(c.cross) < 1e-9
			g.tag(o, p, `${same ? 'proj_b a = a' : 'proj_b a'}, comp_b a ${eq(c.comp)}`, { color: PROJ, size: 16, side: p[0] * c.ay - p[1] * c.ax > 0 ? -1 : 1, gap: 8, at: 0.5 })
		}
		if (p) g.point(p, { color: PROJ, r: 3.5 })
		if (p && !c.zeroA) g.label(p, 'p', { color: PROJ, size: 15, center: true })
		// Lengths sit beside each vector, outside the angle between them.
		if (!c.zeroA) g.tag(o, a, `‖a‖ ${eq(c.na)}`, { color: A, size: 14, italic: false, side: c.cross < 0 ? 1 : -1 })
		if (!c.zeroB) g.tag(o, b, `‖b‖ ${eq(c.nb)}`, { color: B, size: 14, italic: false, side: c.cross < 0 ? -1 : 1, at: 0.8 })
	})
	// A projection outside the view widens it once the user lets go.
	if (c.proj) plot.ensure([c.proj], 0.3)

	const rows = [
		{ name: '‖a‖', value: eq(c.na), note: `length of a: √(${num(c.ax)}² + ${num(c.ay)}²) = ${root(c.sa)}` },
		{ name: '‖b‖', value: eq(c.nb), note: `length of b: √(${num(c.bx)}² + ${num(c.by)}²) = ${root(c.sb)}` },
		{ name: 'a·b', value: eq(c.dot), note: `${num(c.ax)}·${num(c.bx)} + ${num(c.ay)}·${num(c.by)}` },
	]
	if (c.theta === null) rows.push({ name: 'θ', value: 'undefined', note: 'a zero vector has no direction' })
	else rows.push({ name: 'θ', value: `${eq(deg(c.theta), 1)}°`, note: `cos θ = a·b / (‖a‖ ‖b‖) = ${exactText(c.dot)} / (${root(c.sa)} · ${root(c.sb)})` })
	if (c.zeroB) {
		rows.push({ name: { html: 'comp<sub>b</sub> a' }, value: 'undefined', note: 'b is the zero vector, so it has no direction' })
		rows.push({ name: { html: 'proj<sub>b</sub> a' }, value: 'undefined' })
	} else {
		rows.push({
			name: { html: 'comp<sub>b</sub> a' },
			value: eq(c.comp),
			color: PROJ,
			note: `a·b / ‖b‖ = ${exactText(c.dot)} / ${root(c.sb)}${c.zeroA ? '' : ' = ‖a‖ cos θ'}`,
		})
		const exact = paper.isExact(c.proj[0]) && paper.isExact(c.proj[1])
		rows.push({
			name: { html: 'proj<sub>b</sub> a' },
			value: `${exact ? '=' : '≈'} ${vec(c.proj, 2)}`,
			color: PROJ,
			note: { html: paper.minus(`comp<sub>b</sub> a times b / ‖b‖ = (${exactText(c.dot)} / ${exactText(c.sb)}) ${vec(b)}`) },
		})
	}
	readout.set(rows)

	let text
	if (c.zeroB) text = 'b is the zero vector, so it has no direction: the angle and the projection onto b are undefined.'
	else if (c.zeroA) text = 'a is the zero vector, so its projection onto b is the zero vector too.'
	else if (Math.abs(c.dot) < 1e-9) text = 'Now a·b = 0: a lies on the perpendicular to b, so the perpendicular from its tip lands at the origin. p is the origin, and the projection is the zero vector.'
	else if (Math.abs(c.cross) < 1e-9) text = c.dot > 0 ? 'Now a lies along b, so p is the tip of a: the projection is a itself, and θ = 0°.' : 'Now a points against b, so p is the tip of a: the projection is a itself, its signed length is negative, and θ = 180°.'
	else if (c.dot > 0) text = 'Now a·b > 0: θ is under 90°, a is on the same side of the dotted line as b, and the projection points along b.'
	else text = 'Now a·b < 0: θ is over 90°, the tip of a is on the other side of the dotted line from b, and the projection points against b, so its signed length is negative.'
	if (stretched) text = `b changed length, not direction (the hollow dot marks its old tip). With a fixed, proj_b a is still ${paper.isExact(c.proj[0]) && paper.isExact(c.proj[1]) ? '' : 'about '}${vec(c.proj, 2)}: only the direction of b matters.`
	meaning.innerHTML = paper.minus(text).replace(/(proj|comp)_b a/g, '$1<sub>b</sub> a')
}

easel.onChange(render)
render()
