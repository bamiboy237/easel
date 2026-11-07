/**
 * True while a revert or restore writes records back to the store. Shape
 * hooks that derive one field from another, such as a graph moving its marked
 * points when a parameter changes, skip their work then: a revert writes the
 * exact merged record, which keeps newer human work as it is.
 */
let depth = 0

export function isRestoringRecords() {
	return depth > 0
}

export function whileRestoringRecords<T>(fn: () => T): T {
	depth++
	try {
		return fn()
	} finally {
		depth--
	}
}
