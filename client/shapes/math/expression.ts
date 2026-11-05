/**
 * A small, safe math expression compiler for graphs, simulations, and scenes.
 * It reads expressions such as `a*sin(b*x) + c` or `if(t < T, v*t, 0)` and never
 * evaluates arbitrary code: only numbers, named variables, the operators
 * + - * / ^, comparisons, and a fixed list of functions and constants.
 */

const FUNCTIONS: Record<string, (value: number) => number> = {
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	asin: Math.asin,
	acos: Math.acos,
	atan: Math.atan,
	sinh: Math.sinh,
	cosh: Math.cosh,
	tanh: Math.tanh,
	exp: Math.exp,
	ln: Math.log,
	log: Math.log10,
	sqrt: Math.sqrt,
	abs: Math.abs,
	floor: Math.floor,
	ceil: Math.ceil,
	round: Math.round,
	sign: Math.sign,
	/** Degrees to radians, so `sin(deg(30))` reads as a textbook writes it. */
	deg: (value) => (value * Math.PI) / 180,
}

/** Functions of several numbers, with the least and most they take. */
const MULTI_FUNCTIONS: Record<string, { arity: [number, number]; fn: (...values: number[]) => number }> = {
	atan2: { arity: [2, 2], fn: Math.atan2 },
	pow: { arity: [2, 2], fn: Math.pow },
	mod: { arity: [2, 2], fn: (a, b) => ((a % b) + b) % b },
	min: { arity: [1, 16], fn: Math.min },
	max: { arity: [1, 16], fn: Math.max },
	hypot: { arity: [1, 16], fn: Math.hypot },
	clamp: { arity: [3, 3], fn: (value, low, high) => Math.min(high, Math.max(low, value)) },
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

/** Words that join conditions, so they are never read as names. */
const LOGIC_WORDS = new Set(['and', 'or', 'not'])

/** Own keys only, so names such as toString or constructor never reach Object.prototype. */
const has = (table: object, name: string) => Object.hasOwn(table, name)

/** Every function name, so callers can keep object names apart from them. */
export function functionNames(): string[] {
	return [...Object.keys(FUNCTIONS), ...Object.keys(MULTI_FUNCTIONS)]
}

type Comparison = '<' | '>' | '<=' | '>=' | '==' | '!='

type Node =
	| { kind: 'number'; value: number }
	| { kind: 'name'; name: string }
	| { kind: 'unary'; op: '-' | '+'; arg: Node }
	| { kind: 'binary'; op: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node }
	| { kind: 'compare'; op: Comparison; left: Node; right: Node }
	| { kind: 'call'; fn: string; args: Node[] }
	| { kind: 'if'; test: Node; then: Node; else: Node }
	| { kind: 'logic'; op: 'and' | 'or'; left: Node; right: Node }
	| { kind: 'not'; arg: Node }

export type Scope = Record<string, number>
export type CompiledExpression = (scope: Scope) => number

/**
 * Compile an expression, or throw an Error that says what is wrong with it.
 * A name before parentheses multiplies, as on a graphing calculator, so
 * `a(x+1)` is a times (x+1); a name that is not in scope is not a number.
 * A comparison gives 1 or 0, conditions join with and, or, and not, and
 * `if(test, a, b)` gives a when test is not 0.
 */
export function compileExpression(source: string): CompiledExpression {
	const node = parse(source)
	return (scope) => {
		const value = evaluate(node, scope)
		return typeof value === 'number' ? value : NaN
	}
}

/** The names an expression reads, other than constants and functions. */
export function expressionNames(source: string): string[] {
	const names = new Set<string>()
	const visit = (node: Node) => {
		switch (node.kind) {
			case 'name':
				if (!has(CONSTANTS, node.name)) names.add(node.name)
				break
			case 'unary':
				visit(node.arg)
				break
			case 'binary':
			case 'compare':
			case 'logic':
				visit(node.left)
				visit(node.right)
				break
			case 'not':
				visit(node.arg)
				break
			case 'call':
				node.args.forEach(visit)
				break
			case 'if':
				visit(node.test)
				visit(node.then)
				visit(node.else)
				break
		}
	}
	visit(parse(source))
	return [...names]
}

/** Two numbers equal up to rounding, so `0.1 + 0.2 == 0.3` holds. */
function nearlyEqual(a: number, b: number) {
	return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
}

function evaluate(node: Node, scope: Scope): number {
	switch (node.kind) {
		case 'number':
			return node.value
		case 'name': {
			if (has(scope, node.name)) return scope[node.name]
			if (has(CONSTANTS, node.name)) return CONSTANTS[node.name]
			return NaN
		}
		case 'unary': {
			const value = evaluate(node.arg, scope)
			return node.op === '-' ? -value : value
		}
		case 'call': {
			const args = node.args.map((arg) => evaluate(arg, scope))
			return has(FUNCTIONS, node.fn) ? FUNCTIONS[node.fn](args[0]) : MULTI_FUNCTIONS[node.fn].fn(...args)
		}
		case 'if':
			return evaluate(node.test, scope) !== 0 ? evaluate(node.then, scope) : evaluate(node.else, scope)
		case 'logic': {
			const left = evaluate(node.left, scope) !== 0
			if (node.op === 'and') return left && evaluate(node.right, scope) !== 0 ? 1 : 0
			return left || evaluate(node.right, scope) !== 0 ? 1 : 0
		}
		case 'not':
			return evaluate(node.arg, scope) === 0 ? 1 : 0
		case 'compare': {
			const left = evaluate(node.left, scope)
			const right = evaluate(node.right, scope)
			switch (node.op) {
				case '<':
					return left < right ? 1 : 0
				case '>':
					return left > right ? 1 : 0
				case '<=':
					return left <= right || nearlyEqual(left, right) ? 1 : 0
				case '>=':
					return left >= right || nearlyEqual(left, right) ? 1 : 0
				case '==':
					return nearlyEqual(left, right) ? 1 : 0
				case '!=':
					return nearlyEqual(left, right) ? 0 : 1
			}
			return NaN
		}
		case 'binary': {
			const left = evaluate(node.left, scope)
			const right = evaluate(node.right, scope)
			switch (node.op) {
				case '+':
					return left + right
				case '-':
					return left - right
				case '*':
					return left * right
				case '/':
					return left / right
				case '^':
					return Math.pow(left, right)
			}
		}
	}
}

type Token = { type: 'number'; value: number } | { type: 'name'; value: string } | { type: 'op'; value: string }

function tokenize(source: string): Token[] {
	const tokens: Token[] = []
	let i = 0
	while (i < source.length) {
		const char = source[i]
		if (/\s/.test(char)) {
			i++
			continue
		}
		const number = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(source.slice(i))
		if (number) {
			tokens.push({ type: 'number', value: parseFloat(number[0]) })
			i += number[0].length
			continue
		}
		const name = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(source.slice(i))
		if (name) {
			tokens.push({ type: 'name', value: name[0] })
			i += name[0].length
			continue
		}
		const two = source.slice(i, i + 2)
		if (['<=', '>=', '==', '!='].includes(two)) {
			tokens.push({ type: 'op', value: two })
			i += 2
			continue
		}
		if ('+-*/^(),<>'.includes(char)) {
			tokens.push({ type: 'op', value: char })
			i++
			continue
		}
		throw new Error(`Unexpected "${char}" in "${source}"`)
	}
	return tokens
}

/**
 * Precedence, lowest first: comparisons, then + -, then * / and implicit
 * multiplication (2x, 3(x+1)), then unary minus, then ^ (right-associative),
 * then calls and atoms.
 */
function parse(source: string): Node {
	const tokens = tokenize(source)
	let position = 0
	const peek = () => tokens[position]
	const isOp = (value: string) => peek()?.type === 'op' && peek()!.value === value

	// Lowest precedence: or, then and, then not, then comparisons.
	const isWord = (word: string) => peek()?.type === 'name' && peek()!.value === word
	const logicOr = (): Node => {
		let node = logicAnd()
		while (isWord('or')) {
			position++
			node = { kind: 'logic', op: 'or', left: node, right: logicAnd() }
		}
		return node
	}
	const logicAnd = (): Node => {
		let node = logicNot()
		while (isWord('and')) {
			position++
			node = { kind: 'logic', op: 'and', left: node, right: logicNot() }
		}
		return node
	}
	const logicNot = (): Node => {
		if (isWord('not')) {
			position++
			return { kind: 'not', arg: logicNot() }
		}
		return comparison()
	}
	const comparison = (): Node => {
		const left = expression()
		const token = peek()
		if (token?.type === 'op' && ['<', '>', '<=', '>=', '==', '!='].includes(token.value)) {
			position++
			return { kind: 'compare', op: token.value as Comparison, left, right: expression() }
		}
		return left
	}
	const expression = (): Node => {
		let node = term()
		while (isOp('+') || isOp('-')) {
			const op = tokens[position++].value as '+' | '-'
			node = { kind: 'binary', op, left: node, right: term() }
		}
		return node
	}
	const startsFactor = () => {
		const token = peek()
		return (
			!!token &&
			(token.type === 'number' ||
				(token.type === 'name' && !LOGIC_WORDS.has(token.value)) ||
				(token.type === 'op' && token.value === '('))
		)
	}
	const term = (): Node => {
		let node = unary()
		for (;;) {
			if (isOp('*') || isOp('/')) {
				const op = tokens[position++].value as '*' | '/'
				node = { kind: 'binary', op, left: node, right: unary() }
			} else if (startsFactor()) {
				node = { kind: 'binary', op: '*', left: node, right: power() }
			} else return node
		}
	}
	const unary = (): Node => {
		if (isOp('-') || isOp('+')) {
			const op = tokens[position++].value as '-' | '+'
			return { kind: 'unary', op, arg: unary() }
		}
		return power()
	}
	const power = (): Node => {
		const base = atom()
		if (isOp('^')) {
			position++
			return { kind: 'binary', op: '^', left: base, right: unary() }
		}
		return base
	}
	const argumentList = (fn: string): Node[] => {
		if (!isOp('(')) throw new Error(`${fn} needs parentheses in "${source}"`)
		position++
		const args = [logicOr()]
		while (isOp(',')) {
			position++
			args.push(logicOr())
		}
		if (!isOp(')')) throw new Error(`Missing ")" in "${source}"`)
		position++
		return args
	}
	const atom = (): Node => {
		const token = peek()
		if (!token) throw new Error(`"${source}" ends too early`)
		if (token.type === 'number') {
			position++
			return { kind: 'number', value: token.value }
		}
		if (token.type === 'name') {
			position++
			if (token.value === 'if') {
				const args = argumentList('if')
				if (args.length !== 3) throw new Error(`if takes a test and two values in "${source}"`)
				return { kind: 'if', test: args[0], then: args[1], else: args[2] }
			}
			// A function name is a call only when "(" follows it. Otherwise it is
			// an ordinary name, so a scene can call an object "floor".
			const calls = isOp('(')
			const next = tokens[position]
			if (!calls && (has(FUNCTIONS, token.value) || has(MULTI_FUNCTIONS, token.value)) && next && next.type !== 'op') {
				// "sin x" is a call without its parentheses, not sin times x.
				throw new Error(`${token.value} needs parentheses in "${source}"`)
			}
			if (calls && has(FUNCTIONS, token.value)) {
				const args = argumentList(token.value)
				if (args.length !== 1) throw new Error(`${token.value} takes one value in "${source}"`)
				return { kind: 'call', fn: token.value, args }
			}
			if (calls && has(MULTI_FUNCTIONS, token.value)) {
				const args = argumentList(token.value)
				const [least, most] = MULTI_FUNCTIONS[token.value].arity
				if (args.length < least || args.length > most) {
					throw new Error(`${token.value} takes ${least === most ? least : `${least} to ${most}`} values in "${source}"`)
				}
				return { kind: 'call', fn: token.value, args }
			}
			if (LOGIC_WORDS.has(token.value)) throw new Error(`"${token.value}" needs a condition on each side in "${source}"`)
			return { kind: 'name', name: token.value }
		}
		if (token.value === '(') {
			position++
			const inner = logicOr()
			if (!isOp(')')) throw new Error(`Missing ")" in "${source}"`)
			position++
			return inner
		}
		throw new Error(`Unexpected "${token.value}" in "${source}"`)
	}

	const node = logicOr()
	if (position < tokens.length) throw new Error(`Unexpected "${(tokens[position] as Token).value}" in "${source}"`)
	return node
}
