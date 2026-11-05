import { CompiledExpression, compileExpression, Scope } from '../math/expression'

/**
 * Stepped time for scenes: state variables that change at a rate given by a
 * formula, integrated with a fixed-step fourth-order Runge-Kutta method, for
 * motion with no closed form, such as a large-angle pendulum, damping, or an
 * orbit. Events change state when a condition becomes true (a bounce) or stop
 * the clock (the ball lands).
 *
 * The step is fixed and the order of work never changes, so every viewer
 * computes the same frames. Checkpoints every quarter second make scrubbing
 * cheap: a time is reached by integrating from the last checkpoint before it.
 */

/** The integration step, in seconds. */
export const STEP = 1 / 240
/** How often the integrator keeps a checkpoint, in seconds. */
const CHECKPOINT_EVERY = 0.25
/** The longest a scene's clock can integrate, in seconds. */
const MAX_TIME = 600

export interface StateVariable {
	name: string
	init: string
	rate: string
}

export interface SceneEvent {
	id: string
	when: string
	set: Record<string, string>
	stop: boolean
}

export interface SteppedSystem {
	variables: StateVariable[]
	events: SceneEvent[]
	/** Evaluates the lets for a scope that holds the parameters, t, and the state. */
	withLets: (scope: Scope) => Scope
}

interface Checkpoint {
	t: number
	state: number[]
	/** Each event's condition at this time, so an event fires only as its condition turns true. */
	armed: boolean[]
	/** The time a stop event stopped the clock, or null while it runs. */
	stoppedAt: number | null
}

interface Integration {
	checkpoints: Checkpoint[]
	compiled: { rates: CompiledExpression[]; inits: CompiledExpression[]; events: { when: CompiledExpression; set: [number, CompiledExpression][] }[] }
}

const cache = new WeakMap<object, Integration>()

/**
 * The state at time t, as a scope entry per variable. `key` is any object that
 * changes whenever the scene's parameters or objects change, so a cached
 * integration is never reused for a different scene.
 */
export function stateAt(
	system: SteppedSystem,
	base: Scope,
	t: number,
	key: object
): { state: Scope; stoppedAt: number | null } {
	const integration = getIntegration(system, base, key)
	const target = Math.min(Math.max(0, t), MAX_TIME)
	const { checkpoints } = integration
	let index = Math.min(checkpoints.length - 1, Math.floor(target / CHECKPOINT_EVERY))
	while (index > 0 && checkpoints[index].t > target) index--
	let current = cloneCheckpoint(checkpoints[index])
	// Extend the checkpoints as time moves forward, then step to the exact time.
	while (current.t + STEP <= target + 1e-12) {
		current = step(system, integration, base, current)
		const slot = Math.round(current.t / CHECKPOINT_EVERY)
		if (Math.abs(current.t - slot * CHECKPOINT_EVERY) < STEP / 2 && slot === checkpoints.length) {
			checkpoints.push(cloneCheckpoint(current))
		}
	}
	const scope: Scope = {}
	system.variables.forEach((v, i) => (scope[v.name] = current.state[i]))
	return { state: scope, stoppedAt: current.stoppedAt }
}

function getIntegration(system: SteppedSystem, base: Scope, key: object): Integration {
	const hit = cache.get(key)
	if (hit) return hit
	const compile = (source: string) => {
		try {
			return compileExpression(source)
		} catch {
			return () => NaN
		}
	}
	const compiled = {
		rates: system.variables.map((v) => compile(v.rate)),
		inits: system.variables.map((v) => compile(v.init)),
		events: system.events.map((e) => ({
			when: compile(e.when),
			set: Object.entries(e.set)
				.map(([name, source]) => [system.variables.findIndex((v) => v.name === name), compile(source)] as [number, CompiledExpression])
				.filter(([i]) => i >= 0),
		})),
	}
	// Initial values may use parameters and earlier variables, at t = 0.
	const scope: Scope = { ...base, t: 0 }
	const state = system.variables.map((v, i) => {
		const value = compiled.inits[i](system.withLets(scope))
		scope[v.name] = value
		return value
	})
	const start: Checkpoint = { t: 0, state, armed: [], stoppedAt: null }
	start.armed = compiled.events.map((e) => e.when(fullScope(system, base, start.t, start.state)) !== 0)
	const integration = { checkpoints: [start], compiled }
	cache.set(key, integration)
	return integration
}

function fullScope(system: SteppedSystem, base: Scope, t: number, state: number[]): Scope {
	const scope: Scope = { ...base, t }
	system.variables.forEach((v, i) => (scope[v.name] = state[i]))
	return system.withLets(scope)
}

function rates(system: SteppedSystem, integration: Integration, base: Scope, t: number, state: number[]): number[] {
	const scope = fullScope(system, base, t, state)
	return integration.compiled.rates.map((rate) => rate(scope))
}

/** One RK4 step, then events: a stopped clock keeps its state from then on. */
function step(system: SteppedSystem, integration: Integration, base: Scope, from: Checkpoint): Checkpoint {
	const t = from.t + STEP
	if (from.stoppedAt !== null) return { ...from, t }
	const h = STEP
	const y = from.state
	const add = (a: number[], b: number[], k: number) => a.map((v, i) => v + b[i] * k)
	const k1 = rates(system, integration, base, from.t, y)
	const k2 = rates(system, integration, base, from.t + h / 2, add(y, k1, h / 2))
	const k3 = rates(system, integration, base, from.t + h / 2, add(y, k2, h / 2))
	const k4 = rates(system, integration, base, t, add(y, k3, h))
	let state = y.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]))
	let stoppedAt: number | null = null
	const armed = [...from.armed]
	let scope = fullScope(system, base, t, state)
	integration.compiled.events.forEach((event, i) => {
		const now = event.when(scope) !== 0
		// An event fires as its condition turns true, not on every step it stays true.
		if (now && !armed[i]) {
			const next = [...state]
			for (const [index, value] of event.set) next[index] = value(scope)
			state = next
			scope = fullScope(system, base, t, state)
			if (system.events[i].stop) stoppedAt = t
			// A reset can make the condition false again, such as a bounce that puts
			// the ball back on the floor, so the event is armed for the next time.
			armed[i] = event.when(scope) !== 0
		} else {
			armed[i] = now
		}
	})
	return { t, state, armed, stoppedAt }
}

function cloneCheckpoint(c: Checkpoint): Checkpoint {
	return { t: c.t, state: [...c.state], armed: [...c.armed], stoppedAt: c.stoppedAt }
}
