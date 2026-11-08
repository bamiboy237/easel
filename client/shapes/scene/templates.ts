import type { Editor } from 'tldraw'

/**
 * Hand-written scenes for common physics topics. The agent places one with a
 * few parameter values instead of writing a scene from scratch, so it lands
 * within a moment and is known to be right: each carries checks, and each was
 * verified on the physics session. They are also worked examples of good
 * scenes, stepped time included.
 *
 * Users can save any scene as a template too. Saved templates live in the
 * board's document settings, so they travel with the board.
 */

export interface TemplateParameter {
	name: string
	value: number
	min: number
	max: number
	step: number
}

export interface TemplateObject {
	id: string
	type: string
	[key: string]: unknown
}

export interface SceneTemplate {
	id: string
	title: string
	/** When to reach for it, in one line the agent reads. */
	useFor: string
	/** Where it was checked by hand, so a wrong template does not spread. */
	verified: string
	width: number
	height: number
	xMin: number
	xMax: number
	yMin: number
	yMax: number
	duration: number
	axes: boolean
	params: TemplateParameter[]
	objects: TemplateObject[]
}

const VERIFIED = 'physics session, 2026-11-05'

const p = (name: string, value: number, min: number, max: number, step: number): TemplateParameter => ({
	name,
	value,
	min,
	max,
	step,
})

export const BUILT_IN_TEMPLATES: SceneTemplate[] = [
	{
		id: 'projectile',
		title: 'Projectile motion',
		useFor: 'a launched ball under gravity: range, flight time, and peak height against launch speed and angle',
		verified: VERIFIED,
		width: 460,
		height: 280,
		xMin: -2,
		xMax: 45,
		yMin: -2,
		yMax: 16,
		duration: 3.5,
		axes: true,
		params: [p('v0', 20, 5, 30, 0.5), p('theta', 45, 5, 85, 1), p('g', 9.8, 1, 20, 0.1)],
		objects: [
			{ id: 'vx', type: 'let', expr: 'v0*cos(deg(theta))' },
			{ id: 'vy', type: 'let', expr: 'v0*sin(deg(theta))' },
			{ id: 'T', type: 'let', expr: '2*vy/g' },
			{ id: 'R', type: 'let', expr: 'vx*T' },
			{ id: 'H', type: 'let', expr: 'vy^2/(2*g)' },
			{ id: 'tt', type: 'let', expr: 'min(t, T)' },
			{ id: 'ground', type: 'segment', from: ['-2', '0'], to: ['45', '0'] },
			{ id: 'path', type: 'curve', x: 'vx*s', y: 'vy*s - g*s^2/2', from: '0', to: 'T', ink: 1 },
			{ id: 'ball', type: 'point', x: 'vx*tt', y: 'max(0, vy*tt - g*tt^2/2)', label: 'ball' },
			{ id: 'launch', type: 'vector', from: ['0', '0'], dx: 'vx/4', dy: 'vy/4', label: 'v₀', ink: 2 },
			{ id: 'range', type: 'readout', text: 'range = {R} m   peak = {H} m' },
			{ id: 'flight', type: 'readout', text: 'flight time = {T} s' },
			{ id: 'rangeFormula', type: 'check', expr: 'abs(R - v0^2*sin(2*deg(theta))/g) < 1e-6', text: 'the range is v0² sin 2θ / g' },
			{ id: 'lands', type: 'check', expr: 'abs(vy*T - g*T^2/2) < 1e-6', text: 'the ball is back on the ground at the flight time' },
		],
	},
	{
		id: 'pendulum',
		title: 'Pendulum, any angle',
		useFor: 'a swinging pendulum at any release angle, including large angles where the small-angle period fails; stepped in time',
		verified: VERIFIED,
		width: 380,
		height: 360,
		xMin: -2.6,
		xMax: 2.6,
		yMin: -2.8,
		yMax: 2.6,
		duration: 15,
		axes: false,
		params: [p('L', 2, 0.5, 2.4, 0.1), p('th0', 60, 5, 170, 1), p('g', 9.8, 1, 20, 0.1)],
		objects: [
			{ id: 'theta', type: 'state', init: 'deg(th0)', rate: 'omega' },
			{ id: 'omega', type: 'state', init: '0', rate: '-(g/L)*sin(theta)' },
			{ id: 'E', type: 'let', expr: '0.5*L^2*omega^2 + g*L*(1 - cos(theta))' },
			{ id: 'T0', type: 'let', expr: '2*pi*sqrt(L/g)' },
			// The exact period at any release angle: T0 / AGM(1, cos(th0/2)), the
			// arithmetic-geometric mean in five steps, which converge to well under
			// a millisecond even at 170 degrees.
			{ id: 'b0', type: 'let', expr: 'cos(deg(th0)/2)' },
			{ id: 'a1', type: 'let', expr: '(1 + b0)/2' },
			{ id: 'b1', type: 'let', expr: 'sqrt(b0)' },
			{ id: 'a2', type: 'let', expr: '(a1 + b1)/2' },
			{ id: 'b2', type: 'let', expr: 'sqrt(a1*b1)' },
			{ id: 'a3', type: 'let', expr: '(a2 + b2)/2' },
			{ id: 'b3', type: 'let', expr: 'sqrt(a2*b2)' },
			{ id: 'a4', type: 'let', expr: '(a3 + b3)/2' },
			{ id: 'b4', type: 'let', expr: 'sqrt(a3*b3)' },
			{ id: 'a5', type: 'let', expr: '(a4 + b4)/2' },
			{ id: 'T', type: 'let', expr: 'T0/a5' },
			{ id: 'pivot', type: 'point', x: '0', y: '0' },
			{ id: 'bob', type: 'point', x: 'L*sin(theta)', y: '-L*cos(theta)', label: 'bob', ink: 2 },
			{ id: 'rod', type: 'segment', from: 'pivot', to: 'bob' },
			{ id: 'path', type: 'trace', of: 'bob', ink: 1 },
			{ id: 'angle', type: 'readout', text: 'θ = {theta*180/pi}°' },
			{ id: 'period', type: 'readout', text: 'period T = {T} s' },
			{ id: 'small', type: 'readout', text: 'small-angle 2π√(L/g) = {T0} s' },
			{ id: 'energy', type: 'check', expr: 'abs(E - g*L*(1 - cos(deg(th0)))) < 0.001*g*L', text: 'energy is conserved' },
			{ id: 'longer', type: 'check', expr: 'T >= T0', text: 'a wider swing never takes less time than the small-angle estimate' },
			// At 60 degrees the exact period is 1.0732 times the small-angle one.
			{ id: 'sixty', type: 'check', expr: 'th0 != 60 or abs(T/T0 - 1.07318) < 1e-4', text: 'the period at 60 degrees is 1.0732 times the small-angle period' },
		],
	},
	{
		id: 'spring',
		title: 'Mass on a spring, with damping',
		useFor: 'simple harmonic motion and damping: a mass on a spring with stiffness, mass, and a damping coefficient; stepped in time',
		verified: VERIFIED,
		width: 460,
		height: 260,
		xMin: -0.5,
		xMax: 12,
		yMin: -1.6,
		yMax: 1.6,
		duration: 12,
		axes: true,
		params: [p('k', 4, 0.5, 20, 0.5), p('m', 1, 0.2, 5, 0.1), p('c', 0.3, 0, 3, 0.05), p('x0', 1, 0.2, 1.4, 0.1)],
		objects: [
			{ id: 'x', type: 'state', init: 'x0', rate: 'v' },
			{ id: 'v', type: 'state', init: '0', rate: '(-k*x - c*v)/m' },
			{ id: 'w0', type: 'let', expr: 'sqrt(k/m)' },
			{ id: 'zeta', type: 'let', expr: 'c/(2*sqrt(k*m))' },
			{ id: 'mass', type: 'point', x: 't', y: 'x', ink: 2, label: 'x(t)' },
			{ id: 'history', type: 'trace', of: 'mass', ink: 2 },
			{ id: 'rest', type: 'segment', from: ['-0.5', '0'], to: ['12', '0'] },
			{ id: 'freq', type: 'readout', text: 'natural frequency ω₀ = √(k/m) = {w0} rad/s' },
			{ id: 'damping', type: 'readout', text: 'damping ratio ζ = {zeta}' },
			{ id: 'bounded', type: 'check', expr: 'abs(x) <= x0*1.001', text: 'damping never makes the swing grow' },
		],
	},
	{
		id: 'orbit',
		title: 'Orbit under gravity',
		useFor: 'a planet or satellite orbiting a star: circles and ellipses from the starting speed, Kepler motion; stepped in time',
		verified: VERIFIED,
		width: 420,
		height: 360,
		xMin: -1.8,
		xMax: 1.4,
		yMin: -1.3,
		yMax: 1.3,
		duration: 20,
		axes: false,
		params: [p('v0', 1, 0.6, 1.3, 0.02), p('GM', 1, 0.5, 2, 0.05)],
		objects: [
			{ id: 'x', type: 'state', init: '1', rate: 'vx' },
			{ id: 'y', type: 'state', init: '0', rate: 'vy' },
			{ id: 'vx', type: 'state', init: '0', rate: '-GM*x/hypot(x, y)^3' },
			{ id: 'vy', type: 'state', init: 'v0', rate: '-GM*y/hypot(x, y)^3' },
			{ id: 'E', type: 'let', expr: '0.5*(vx^2 + vy^2) - GM/hypot(x, y)' },
			{ id: 'r', type: 'let', expr: 'hypot(x, y)' },
			{ id: 'star', type: 'circle', center: ['0', '0'], r: '0.08', fill: true, ink: 1 },
			{ id: 'planet', type: 'point', x: 'x', y: 'y', label: 'planet', ink: 2 },
			{ id: 'path', type: 'trace', of: 'planet', ink: 2 },
			{ id: 'distance', type: 'readout', text: 'distance r = {r}' },
			{ id: 'energy', type: 'readout', text: 'energy = {E} (negative: bound orbit)' },
			{ id: 'conserved', type: 'check', expr: 'abs(E - (0.5*v0^2 - GM)) < 0.001', text: 'energy is conserved' },
		],
	},
	{
		id: 'incline',
		title: 'Block on an incline',
		useFor: 'forces on a block on a ramp: weight components, normal force, friction, and acceleration against the angle',
		verified: VERIFIED,
		width: 440,
		height: 320,
		xMin: -1,
		xMax: 9,
		yMin: -1.6,
		yMax: 7.6,
		duration: 0,
		axes: false,
		params: [p('theta', 30, 5, 55, 1), p('m', 2, 0.5, 5, 0.1), p('mu', 0.2, 0, 0.8, 0.05)],
		objects: [
			{ id: 'th', type: 'let', expr: 'deg(theta)' },
			{ id: 'W', type: 'let', expr: 'm*9.8' },
			{ id: 'N', type: 'let', expr: 'W*cos(th)' },
			{ id: 'down', type: 'let', expr: 'W*sin(th)' },
			{ id: 'f', type: 'let', expr: 'min(mu*N, down)' },
			{ id: 'a', type: 'let', expr: '(down - f)/m' },
			{ id: 'base', type: 'let', expr: '8' },
			{ id: 'top', type: 'let', expr: 'base*tan(th)' },
			{ id: 'ramp', type: 'polygon', points: [['0', '0'], ['base', '0'], ['0', 'top']], fill: true },
			{ id: 'cx', type: 'let', expr: 'base/2 + 0.5*sin(th)' },
			{ id: 'cy', type: 'let', expr: 'top/2 + 0.5*cos(th)' },
			{
				id: 'box',
				type: 'polygon',
				points: [
					['cx - 0.6*cos(th) - 0.5*sin(th)', 'cy + 0.6*sin(th) - 0.5*cos(th)'],
					['cx + 0.6*cos(th) - 0.5*sin(th)', 'cy - 0.6*sin(th) - 0.5*cos(th)'],
					['cx + 0.6*cos(th) + 0.5*sin(th)', 'cy - 0.6*sin(th) + 0.5*cos(th)'],
					['cx - 0.6*cos(th) + 0.5*sin(th)', 'cy + 0.6*sin(th) + 0.5*cos(th)'],
				],
				fill: true,
				ink: 2,
			},
			{ id: 'block', type: 'point', x: 'cx', y: 'cy' },
			{ id: 'weight', type: 'vector', from: 'block', dx: '0', dy: '-W/8', label: 'mg', ink: 0 },
			{ id: 'normal', type: 'vector', from: 'block', dx: 'N/8*sin(th)', dy: 'N/8*cos(th)', label: 'N', ink: 2 },
			{ id: 'friction', type: 'vector', from: 'block', dx: '-f/4*cos(th)', dy: 'f/4*sin(th)', label: 'f', ink: 1 },
			{ id: 'accel', type: 'readout', text: 'a = {a} m/s² down the ramp' },
			{ id: 'forces', type: 'readout', text: 'N = {N} N   f = {f} N' },
			{ id: 'normalRule', type: 'check', expr: 'abs(N - m*9.8*cos(deg(theta))) < 1e-9', text: 'N equals mg cos θ' },
			{ id: 'noUphill', type: 'check', expr: 'a >= 0', text: 'friction never pushes the block up the ramp' },
		],
	},
	{
		id: 'push',
		title: 'Pushed box with friction',
		useFor: "Newton's second law with friction: a box pushed across a floor, net force and acceleration against push, mass, and μ",
		verified: VERIFIED,
		width: 400,
		height: 300,
		xMin: -4,
		xMax: 4,
		yMin: -3.2,
		yMax: 3.2,
		duration: 0,
		axes: false,
		params: [p('F', 12, 0, 40, 0.5), p('m', 2, 0.5, 5, 0.1), p('mu', 0.3, 0, 1, 0.05)],
		objects: [
			{ id: 'W', type: 'let', expr: 'm*9.8' },
			{ id: 'f', type: 'let', expr: 'min(mu*W, F)' },
			{ id: 'a', type: 'let', expr: '(F - f)/m' },
			{ id: 'box', type: 'polygon', points: [['-1', '-0.7'], ['1', '-0.7'], ['1', '0.7'], ['-1', '0.7']], fill: true },
			{ id: 'ground', type: 'segment', from: ['-4', '-0.7'], to: ['4', '-0.7'] },
			{ id: 'push', type: 'vector', from: ['1', '0'], dx: 'F/12', dy: '0', label: 'push F', ink: 2 },
			{ id: 'fric', type: 'vector', from: ['-1', '-0.35'], dx: '-f/12', dy: '0', label: 'friction f', ink: 1 },
			{ id: 'weight', type: 'vector', from: ['0', '-0.7'], dx: '0', dy: '-W/20', label: 'weight mg' },
			{ id: 'normal', type: 'vector', from: ['0', '0.7'], dx: '0', dy: 'W/20', label: 'normal N', ink: 3 },
			{ id: 'accel', type: 'readout', text: 'a = (F − f)/m = {a} m/s²' },
			{ id: 'staysPut', type: 'check', expr: 'a >= 0', text: 'friction never makes the box move backwards' },
		],
	},
	{
		id: 'travelling-wave',
		title: 'Travelling wave',
		useFor: 'a wave moving along a string: amplitude, wavelength, frequency, and wave speed v = λf',
		verified: VERIFIED,
		width: 480,
		height: 240,
		xMin: 0,
		xMax: 20,
		yMin: -3.5,
		yMax: 3.5,
		duration: 10,
		axes: true,
		params: [p('A', 1.5, 0.2, 3, 0.1), p('lambda', 6, 2, 12, 0.5), p('f', 0.5, 0.1, 2, 0.05)],
		objects: [
			{ id: 'k', type: 'let', expr: '2*pi/lambda' },
			{ id: 'w', type: 'let', expr: '2*pi*f' },
			{ id: 'v', type: 'let', expr: 'lambda*f' },
			{ id: 'wave', type: 'plot', y: 'A*sin(k*x - w*t)', ink: 2 },
			{ id: 'marker', type: 'point', x: '5', y: 'A*sin(k*5 - w*t)', label: 'one point bobs', ink: 1 },
			{ id: 'speed', type: 'readout', text: 'v = λf = {v} m/s' },
			{ id: 'speedRule', type: 'check', expr: 'abs(v - w/k) < 1e-9', text: 'v = ω/k = λf' },
		],
	},
	{
		id: 'standing-wave',
		title: 'Standing wave on a string',
		useFor: 'harmonics on a string fixed at both ends: nodes, antinodes, and wavelength 2L/n',
		verified: VERIFIED,
		width: 480,
		height: 240,
		xMin: -0.5,
		xMax: 10.5,
		yMin: -2.2,
		yMax: 2.2,
		duration: 8,
		axes: false,
		params: [p('n', 2, 1, 6, 1), p('A', 1.5, 0.2, 2, 0.1)],
		objects: [
			{ id: 'L', type: 'let', expr: '10' },
			{ id: 'lambda', type: 'let', expr: '2*L/n' },
			{ id: 'envelope', type: 'plot', y: 'if(x >= 0 and x <= L, A*sin(n*pi*x/L), 0)', ink: 0 },
			{ id: 'string', type: 'curve', x: 's', y: 'A*sin(n*pi*s/L)*cos(2*pi*t/2)', from: '0', to: 'L', ink: 2 },
			{ id: 'left', type: 'point', x: '0', y: '0', label: 'fixed' },
			{ id: 'right', type: 'point', x: 'L', y: '0' },
			{ id: 'harmonic', type: 'readout', text: 'harmonic n = {n}: {n+1} nodes, {n} antinodes, λ = 2L/n = {lambda} m' },
			{ id: 'nodesFixed', type: 'check', expr: 'abs(sin(n*pi)) < 1e-9', text: 'both ends are nodes' },
		],
	},
	{
		id: 'vector-sum',
		title: 'Adding vectors head to tail',
		useFor: 'vector addition and components: drag the tips of two vectors and see their sum',
		verified: VERIFIED,
		width: 400,
		height: 340,
		xMin: -2,
		xMax: 9,
		yMin: -2,
		yMax: 8,
		duration: 0,
		axes: true,
		params: [p('ax', 3, -1, 6, 0.1), p('ay', 2, -1, 6, 0.1), p('bx', 2, -2, 4, 0.1), p('by', 3, -2, 4, 0.1)],
		objects: [
			{ id: 'aTip', type: 'point', x: 'ax', y: 'ay', drag: true, ink: 2, label: 'a' },
			{ id: 'a', type: 'vector', from: ['0', '0'], dx: 'ax', dy: 'ay', ink: 2 },
			{ id: 'b', type: 'vector', from: 'aTip', dx: 'bx', dy: 'by', ink: 3, label: 'b' },
			{ id: 'sum', type: 'vector', from: ['0', '0'], dx: 'ax + bx', dy: 'ay + by', ink: 1, label: 'a + b' },
			{ id: 'components', type: 'readout', text: 'a + b = ({ax + bx}, {ay + by})' },
			{ id: 'length', type: 'readout', text: '|a + b| = {hypot(ax + bx, ay + by)}' },
			{ id: 'triangle', type: 'check', expr: 'hypot(ax + bx, ay + by) <= hypot(ax, ay) + hypot(bx, by) + 1e-9', text: 'the triangle inequality holds' },
		],
	},
	{
		id: 'bouncing-ball',
		title: 'Bouncing ball',
		useFor: 'a ball dropped onto a floor that loses energy at each bounce: the coefficient of restitution; stepped in time with events',
		verified: VERIFIED,
		width: 420,
		height: 300,
		xMin: -0.5,
		xMax: 10,
		yMin: -0.5,
		yMax: 6,
		duration: 10,
		axes: true,
		params: [p('h0', 5, 1, 5.5, 0.1), p('e', 0.8, 0.1, 1, 0.05)],
		objects: [
			{ id: 'y', type: 'state', init: 'h0', rate: 'vy' },
			{ id: 'vy', type: 'state', init: '0', rate: '-9.8' },
			{ id: 'bounce', type: 'event', when: 'y < 0', set: { y: '0', vy: '-e*vy' }, stop: false },
			{ id: 'rest', type: 'event', when: 'y <= 0.001 and abs(vy) < 0.3', set: { y: '0', vy: '0' }, stop: true },
			{ id: 'ball', type: 'point', x: 't', y: 'y', label: 'ball', ink: 2 },
			{ id: 'path', type: 'trace', of: 'ball', ink: 2 },
			{ id: 'ground', type: 'segment', from: ['-0.5', '0'], to: ['10', '0'] },
			{ id: 'next', type: 'readout', text: 'each bounce reaches e² = {e^2} of the last height' },
			{ id: 'aboveFloor', type: 'check', expr: 'y >= -0.01', text: 'the ball never passes through the floor' },
		],
	},
	{
		id: 'collision',
		title: 'Collision of two carts',
		useFor: 'momentum in one dimension: two carts collide, elastic to perfectly inelastic by the coefficient of restitution e',
		verified: VERIFIED,
		width: 460,
		height: 200,
		xMin: -1,
		xMax: 12,
		yMin: -1,
		yMax: 2.2,
		duration: 3,
		axes: false,
		params: [p('m1', 1, 0.5, 5, 0.1), p('m2', 2, 0.5, 5, 0.1), p('v1', 3, 0, 6, 0.1), p('v2', 0, -3, 3, 0.1), p('e', 1, 0, 1, 0.05)],
		objects: [
			{ id: 'closing', type: 'let', expr: 'v1 - v2' },
			{ id: 'tc', type: 'let', expr: 'if(closing > 0, 4/closing, 1e9)' },
			{ id: 'P', type: 'let', expr: 'm1*v1 + m2*v2' },
			{ id: 'u1', type: 'let', expr: 'if(closing > 0, (P - m2*e*closing)/(m1 + m2), v1)' },
			{ id: 'u2', type: 'let', expr: 'if(closing > 0, (P + m1*e*closing)/(m1 + m2), v2)' },
			{ id: 'x1', type: 'let', expr: 'if(t < tc, 1 + v1*t, 1 + v1*tc + u1*(t - tc))' },
			{ id: 'x2', type: 'let', expr: 'if(t < tc, 6 + v2*t, 6 + v2*tc + u2*(t - tc))' },
			{ id: 'v1now', type: 'let', expr: 'if(t < tc, v1, u1)' },
			{ id: 'v2now', type: 'let', expr: 'if(t < tc, v2, u2)' },
			{ id: 'track', type: 'segment', from: ['-1', '0'], to: ['12', '0'] },
			{ id: 'cart1', type: 'polygon', points: [['x1 - 0.5', '0'], ['x1 + 0.5', '0'], ['x1 + 0.5', '0.4 + 0.12*m1'], ['x1 - 0.5', '0.4 + 0.12*m1']], fill: true, ink: 1 },
			{ id: 'cart2', type: 'polygon', points: [['x2 - 0.5', '0'], ['x2 + 0.5', '0'], ['x2 + 0.5', '0.4 + 0.12*m2'], ['x2 - 0.5', '0.4 + 0.12*m2']], fill: true, ink: 2 },
			{ id: 'name1', type: 'label', at: ['x1', '-0.5'], text: 'm₁' },
			{ id: 'name2', type: 'label', at: ['x2', '-0.5'], text: 'm₂' },
			{ id: 'vel1', type: 'vector', from: ['x1', '1.3 + 0.1*m1'], dx: 'v1now/2', dy: '0', label: 'v₁', ink: 1 },
			{ id: 'vel2', type: 'vector', from: ['x2', '1.3 + 0.1*m2'], dx: 'v2now/2', dy: '0', label: 'v₂', ink: 2 },
			{ id: 'after', type: 'readout', text: 'after: v₁ = {u1} m/s   v₂ = {u2} m/s' },
			{ id: 'momentum', type: 'readout', text: 'momentum = {m1*v1now + m2*v2now} kg·m/s' },
			{ id: 'conserved', type: 'check', expr: 'abs(m1*u1 + m2*u2 - P) < 1e-9', text: 'momentum is the same before and after' },
			{ id: 'noGain', type: 'check', expr: 'm1*u1^2 + m2*u2^2 <= m1*v1^2 + m2*v2^2 + 1e-9', text: 'the collision never adds kinetic energy' },
			{ id: 'apart', type: 'check', expr: 'x2 - x1 >= 1 - 1e-6', text: 'the carts never pass through each other' },
		],
	},
	{
		id: 'circular-motion',
		title: 'Circular motion',
		useFor: 'an object moving in a circle at constant speed: velocity along the path, centripetal acceleration v²/r toward the centre, and the period',
		verified: VERIFIED,
		width: 360,
		height: 360,
		xMin: -4,
		xMax: 4,
		yMin: -4,
		yMax: 4,
		duration: 10,
		axes: false,
		params: [p('r', 2, 0.5, 3, 0.1), p('v', 3, 0.5, 6, 0.1)],
		objects: [
			{ id: 'w', type: 'let', expr: 'v/r' },
			{ id: 'ac', type: 'let', expr: 'v^2/r' },
			{ id: 'T', type: 'let', expr: '2*pi*r/v' },
			{ id: 'px', type: 'let', expr: 'r*cos(w*t)' },
			{ id: 'py', type: 'let', expr: 'r*sin(w*t)' },
			{ id: 'vx', type: 'let', expr: '-v*sin(w*t)' },
			{ id: 'vy', type: 'let', expr: 'v*cos(w*t)' },
			{ id: 'path', type: 'circle', center: ['0', '0'], r: 'r' },
			{ id: 'centre', type: 'point', x: '0', y: '0' },
			{ id: 'radius', type: 'segment', from: 'centre', to: 'body' },
			{ id: 'body', type: 'point', x: 'px', y: 'py', label: 'object' },
			{ id: 'vel', type: 'vector', from: 'body', dx: 'vx/2', dy: 'vy/2', label: 'v', ink: 1 },
			{ id: 'acc', type: 'vector', from: 'body', dx: '-px/r*min(ac/4, r*0.8)', dy: '-py/r*min(ac/4, r*0.8)', label: 'a', ink: 2 },
			{ id: 'accel', type: 'readout', text: 'a = v²/r = {ac} m/s² toward the centre' },
			{ id: 'period', type: 'readout', text: 'period = {T} s' },
			{ id: 'tangent', type: 'check', expr: 'abs(px*vx + py*vy) < 1e-9', text: 'the velocity is at right angles to the radius' },
			{ id: 'onCircle', type: 'check', expr: 'abs(px^2 + py^2 - r^2) < 1e-9', text: 'the object stays on the circle' },
		],
	},
	{
		id: 'atwood',
		title: 'Atwood machine',
		useFor: 'two masses on a rope over a pulley: acceleration (m₂ − m₁)g/(m₁ + m₂) and rope tension',
		verified: VERIFIED,
		width: 300,
		height: 460,
		xMin: -2,
		xMax: 2,
		yMin: -0.2,
		yMax: 6.6,
		duration: 3,
		axes: false,
		params: [p('m1', 2, 0.5, 5, 0.1), p('m2', 3, 0.5, 5, 0.1)],
		objects: [
			{ id: 'g', type: 'let', expr: '9.8' },
			{ id: 'a', type: 'let', expr: '(m2 - m1)*g/(m1 + m2)' },
			{ id: 'T', type: 'let', expr: '2*m1*m2*g/(m1 + m2)' },
			{ id: 'd', type: 'let', expr: 'max(-1.6, min(1.6, a*t^2/2))' },
			{ id: 'y1', type: 'let', expr: '2.2 + d' },
			{ id: 'y2', type: 'let', expr: '2.2 - d' },
			{ id: 'pulley', type: 'circle', center: ['0', '5'], r: '0.5', fill: true },
			{ id: 'rope1', type: 'segment', from: ['-0.5', '5'], to: ['-0.5', 'y1 + 0.3'] },
			{ id: 'rope2', type: 'segment', from: ['0.5', '5'], to: ['0.5', 'y2 + 0.3'] },
			{ id: 'box1', type: 'polygon', points: [['-0.8', 'y1 - 0.3'], ['-0.2', 'y1 - 0.3'], ['-0.2', 'y1 + 0.3'], ['-0.8', 'y1 + 0.3']], fill: true, ink: 1 },
			{ id: 'box2', type: 'polygon', points: [['0.2', 'y2 - 0.3'], ['0.8', 'y2 - 0.3'], ['0.8', 'y2 + 0.3'], ['0.2', 'y2 + 0.3']], fill: true, ink: 2 },
			{ id: 'name1', type: 'label', at: ['-1.3', 'y1'], text: 'm₁' },
			{ id: 'name2', type: 'label', at: ['1.3', 'y2'], text: 'm₂' },
			{ id: 'accel', type: 'readout', text: 'a = {abs(a)} m/s²' },
			{ id: 'tension', type: 'readout', text: 'tension = {T} N' },
			{ id: 'between', type: 'check', expr: '(T - m1*g)*(T - m2*g) <= 1e-9', text: 'the tension lies between the two weights' },
			{ id: 'newton1', type: 'check', expr: 'abs(T - m1*g - m1*a) < 1e-9', text: 'T − m₁g = m₁a for the left mass' },
		],
	},
	{
		id: 'air-drag',
		title: 'Falling with air drag',
		useFor: 'a falling object with air resistance reaching terminal velocity √(mg/k), dropped beside one in free fall; stepped in time',
		verified: VERIFIED,
		width: 360,
		height: 460,
		xMin: -30,
		xMax: 30,
		yMin: -2,
		yMax: 62,
		duration: 4,
		axes: false,
		params: [p('m', 1, 0.2, 3, 0.1), p('k', 0.25, 0.05, 1, 0.01)],
		objects: [
			{ id: 'v', type: 'state', init: '0', rate: 'if(y > 0, 9.8 - (k/m)*v^2, 0)' },
			{ id: 'y', type: 'state', init: '60', rate: 'if(y > 0, -v, 0)' },
			{ id: 'vt', type: 'let', expr: 'sqrt(m*9.8/k)' },
			{ id: 'yf', type: 'let', expr: 'max(0, 60 - 4.9*t^2)' },
			{ id: 'vf', type: 'let', expr: 'if(yf > 0, 9.8*t, sqrt(2*9.8*60))' },
			{ id: 'ground', type: 'segment', from: ['-30', '0'], to: ['30', '0'] },
			{ id: 'dragBall', type: 'point', x: '-10', y: 'max(0, y)', label: 'with drag', ink: 2 },
			{ id: 'freeBall', type: 'point', x: '10', y: 'yf', label: 'no drag', ink: 1 },
			{ id: 'dragBody', type: 'circle', center: 'dragBall', r: '2.4', fill: true, ink: 2 },
			{ id: 'freeBody', type: 'circle', center: 'freeBall', r: '2.4', fill: true, ink: 1 },
			{ id: 'dragVel', type: 'vector', from: 'dragBall', dx: '0', dy: '-v/3', ink: 2 },
			{ id: 'freeVel', type: 'vector', from: 'freeBall', dx: '0', dy: '-vf/3', ink: 1 },
			{ id: 'readTerminal', type: 'readout', text: 'terminal speed {vt} m/s' },
			{ id: 'readDrag', type: 'readout', text: 'with drag {v} m/s' },
			{ id: 'readFree', type: 'readout', text: 'no drag {vf} m/s' },
			{ id: 'belowTerminal', type: 'check', expr: 'v <= vt + 1e-6', text: 'the speed never passes terminal speed' },
			{ id: 'belowFree', type: 'check', expr: 'v <= 9.8*t + 1e-6', text: 'drag keeps the object slower than free fall' },
		],
	},
	{
		id: 'beats',
		title: 'Superposition and beats',
		useFor: 'adding two waves of close frequencies: interference, the beat envelope, and beat frequency |f₁ − f₂|',
		verified: VERIFIED,
		width: 480,
		height: 400,
		xMin: -1.2,
		xMax: 10,
		yMin: -2.6,
		yMax: 6,
		duration: 0,
		axes: false,
		params: [p('f1', 5, 1, 10, 0.5), p('f2', 6, 1, 10, 0.5)],
		objects: [
			{ id: 'ts', type: 'let', expr: '0.2' },
			{ id: 'wave1', type: 'curve', x: 's', y: '4.8 + 0.7*sin(2*pi*f1*ts*s)', from: '0', to: '10', ink: 1 },
			{ id: 'wave2', type: 'curve', x: 's', y: '3 + 0.7*sin(2*pi*f2*ts*s)', from: '0', to: '10', ink: 3 },
			{ id: 'sum', type: 'curve', x: 's', y: '0.7*(sin(2*pi*f1*ts*s) + sin(2*pi*f2*ts*s))', from: '0', to: '10', ink: 2 },
			{ id: 'envelope', type: 'curve', x: 's', y: '1.4*abs(cos(pi*(f1 - f2)*ts*s))', from: '0', to: '10', ink: 0 },
			{ id: 'name1', type: 'label', at: ['-0.6', '4.8'], text: 'f₁' },
			{ id: 'name2', type: 'label', at: ['-0.6', '3'], text: 'f₂' },
			{ id: 'nameSum', type: 'label', at: ['-0.6', '0'], text: 'sum' },
			{ id: 'axis', type: 'segment', from: ['0', '-1.7'], to: ['10', '-1.7'] },
			{ id: 'span', type: 'label', at: ['5', '-2.2'], text: '2 seconds' },
			{ id: 'beat', type: 'readout', text: 'beat frequency = {abs(f1 - f2)} Hz' },
			{ id: 'identity', type: 'check', expr: 'abs(sin(2*pi*f1*0.37) + sin(2*pi*f2*0.37) - 2*sin(pi*(f1 + f2)*0.37)*cos(pi*(f1 - f2)*0.37)) < 1e-9', text: 'the sum equals 2 sin(π(f₁+f₂)t) cos(π(f₁−f₂)t)' },
		],
	},
	{
		id: 'lever',
		title: 'Lever and torque balance',
		useFor: 'torque and balance on a lever or seesaw: masses at distances from the pivot, balanced when m₁d₁ = m₂d₂',
		verified: VERIFIED,
		width: 480,
		height: 260,
		xMin: -5,
		xMax: 5,
		yMin: -0.5,
		yMax: 5,
		duration: 0,
		axes: false,
		params: [p('m1', 2, 0.5, 5, 0.1), p('d1', 2, 0.5, 4, 0.1), p('m2', 1, 0.5, 5, 0.1), p('d2', 3, 0.5, 4, 0.1)],
		objects: [
			{ id: 'tau1', type: 'let', expr: 'm1*9.8*d1' },
			{ id: 'tau2', type: 'let', expr: 'm2*9.8*d2' },
			{ id: 'phi', type: 'let', expr: 'max(-0.25, min(0.25, (tau2 - tau1)/200))' },
			{ id: 'h', type: 'let', expr: '1.8' },
			{ id: 'pivot', type: 'polygon', points: [['0', 'h'], ['-0.5', '0'], ['0.5', '0']], fill: true },
			{ id: 'ground', type: 'segment', from: ['-5', '0'], to: ['5', '0'] },
			{ id: 'plank', type: 'segment', from: ['-4*cos(phi)', 'h + 4*sin(phi)'], to: ['4*cos(phi)', 'h - 4*sin(phi)'] },
			{ id: 'left', type: 'point', x: '-d1*cos(phi)', y: 'h + d1*sin(phi)' },
			{ id: 'right', type: 'point', x: 'd2*cos(phi)', y: 'h - d2*sin(phi)' },
			{ id: 'mass1', type: 'circle', center: ['-d1*cos(phi)', 'h + d1*sin(phi) + 0.2 + 0.06*m1'], r: '0.2 + 0.06*m1', fill: true, ink: 1 },
			{ id: 'mass2', type: 'circle', center: ['d2*cos(phi)', 'h - d2*sin(phi) + 0.2 + 0.06*m2'], r: '0.2 + 0.06*m2', fill: true, ink: 2 },
			{ id: 'w1', type: 'vector', from: 'left', dx: '0', dy: '-m1/3', label: 'm₁g', ink: 1 },
			{ id: 'w2', type: 'vector', from: 'right', dx: '0', dy: '-m2/3', label: 'm₂g', ink: 2 },
			{ id: 'torques', type: 'readout', text: 'torques: {tau1} and {tau2} N·m' },
			{ id: 'tilt', type: 'check', expr: 'phi*(tau2 - tau1) >= 0', text: 'the lever tips toward the side with more torque' },
		],
	},
]

/** The templates a user saved on this board. */
export function getSavedTemplates(editor: Editor): SceneTemplate[] {
	const saved = (editor.getDocumentSettings().meta.easelTemplates as unknown as SceneTemplate[] | undefined) ?? []
	return Array.isArray(saved) ? saved : []
}

/** Every template the agent can place: the built-in ones, then this board's own. */
export function getAllTemplates(editor: Editor): SceneTemplate[] {
	const saved = getSavedTemplates(editor)
	const savedIds = new Set(saved.map((t) => t.id))
	return [...BUILT_IN_TEMPLATES.filter((t) => !savedIds.has(t.id)), ...saved]
}

/**
 * An id for a new saved template from a title: built from the title, and kept
 * apart from every built-in and saved template, so saving never overwrites one.
 */
export function newTemplateId(editor: Editor, title: string): string {
	const slug = (title || 'scene').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scene'
	const taken = new Set([...BUILT_IN_TEMPLATES, ...getSavedTemplates(editor)].map((t) => t.id))
	if (!taken.has(slug)) return slug
	let n = 2
	while (taken.has(`${slug}-${n}`)) n++
	return `${slug}-${n}`
}

/**
 * Save a template on the board, replacing one with the same id. It writes the
 * document record through the store, so it is an ordinary, undoable change.
 */
export function saveTemplate(editor: Editor, template: SceneTemplate) {
	const document = editor.getDocumentSettings()
	const others = getSavedTemplates(editor).filter((t) => t.id !== template.id)
	editor.store.put([
		{ ...document, meta: { ...document.meta, easelTemplates: [...others, template] as unknown as Record<string, never>[] } },
	])
}
