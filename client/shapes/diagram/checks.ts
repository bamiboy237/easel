/**
 * Checks of a diagram's structure that a reader would catch: a cycle that
 * does not close. In a concept map of a cycle, such as the water cycle or the
 * carbon cycle, every part lies on the loop: something flows into it and
 * something flows out of it back toward the loop. A part that only receives
 * (groundwater with no way back to the oceans) is a dead end, and a learner
 * reads it as where the matter stops.
 */
export interface DiagramCheckEdge {
	from: string
	to: string
}

/** The strongly connected parts of a directed graph, by Tarjan's algorithm. */
function stronglyConnected(ids: string[], edges: DiagramCheckEdge[]): string[][] {
	const next = new Map<string, string[]>(ids.map((id) => [id, []]))
	for (const e of edges) next.get(e.from)?.push(e.to)
	const index = new Map<string, number>()
	const low = new Map<string, number>()
	const stack: string[] = []
	const onStack = new Set<string>()
	const out: string[][] = []
	let counter = 0
	const visit = (v: string) => {
		index.set(v, counter)
		low.set(v, counter)
		counter++
		stack.push(v)
		onStack.add(v)
		for (const w of next.get(v) ?? []) {
			if (!index.has(w)) {
				visit(w)
				low.set(v, Math.min(low.get(v)!, low.get(w)!))
			} else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
		}
		if (low.get(v) === index.get(v)) {
			const part: string[] = []
			let w: string
			do {
				w = stack.pop()!
				onStack.delete(w)
				part.push(w)
			} while (w !== v)
			out.push(part)
		}
	}
	for (const id of ids) if (!index.has(id)) visit(id)
	return out
}

/**
 * Problems in a concept map that holds a cycle: each part joined to the cycle
 * that receives but leads nowhere. Only maps are checked: a flow's ends are
 * meant to end.
 */
export function diagramProblems(layout: string, nodes: { id: string; label: string }[], edges: DiagramCheckEdge[]): string[] {
	if (layout !== 'map' || nodes.length < 3) return []
	const ids = nodes.map((n) => n.id)
	const loops = stronglyConnected(ids, edges).filter((part) => part.length >= 2)
	if (loops.length === 0) return []
	const onLoop = new Set(loops.flat())
	// The parts joined to a loop, by links in either direction.
	const joined = new Set(onLoop)
	for (let changed = true; changed; ) {
		changed = false
		for (const e of edges) {
			if (joined.has(e.from) !== joined.has(e.to)) {
				joined.add(e.from)
				joined.add(e.to)
				changed = true
			}
		}
	}
	const label = new Map(nodes.map((n) => [n.id, n.label]))
	const problems: string[] = []
	for (const id of ids) {
		if (onLoop.has(id) || !joined.has(id)) continue
		// Only what flows in and never out: an input that feeds the cycle, such as
		// sunlight, rightly has nothing flowing into it.
		if (edges.some((e) => e.from === id)) continue
		const name = `"${label.get(id) ?? id}"`
		problems.push(`${name} is a dead end: something flows into it, but nothing flows from it back into the cycle, so the cycle does not close. Add the link that returns it, such as groundwater flowing back to the oceans, unless it truly is where the matter leaves the cycle`)
	}
	return problems
}
