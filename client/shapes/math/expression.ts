/**
 * A small, safe math expression compiler for graphs and simulations. It reads
 * expressions such as `a*sin(b*x) + c` or `x^2 - 3` and never evaluates
 * arbitrary code: only numbers, named variables, the operators + - * / ^, and
 * a fixed list of functions and constants are allowed.
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
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

type Node =
	| { kind: 'number'; value: number }
	| { kind: 'name'; name: string }
	| { kind: 'unary'; op: '-' | '+'; arg: Node }
	| { kind: 'binary'; op: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node }
	| { kind: 'call'; fn: string; arg: Node }

export type Scope = Record<string, number>
export type CompiledExpression = (scope: Scope) => number

/**
 * Compile an expression, or throw an Error that says what is wrong with it.
 * A name before parentheses multiplies, as on a graphing calculator, so
 * `a(x+1)` is a times (x+1); a name that is not in scope is not a number.
 */
export function compileExpression(source: string): CompiledExpression {
	const node = parse(source)
	return (scope) => evaluate(node, scope)
}

function evaluate(node: Node, scope: Scope): number {
	switch (node.kind) {
		case 'number':
			return node.value
		case 'name': {
			if (node.name in scope) return scope[node.name]
			if (node.name in CONSTANTS) return CONSTANTS[node.name]
			return NaN
		}
		case 'unary': {
			const value = evaluate(node.arg, scope)
			return node.op === '-' ? -value : value
		}
		case 'call':
			return FUNCTIONS[node.fn](evaluate(node.arg, scope))
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
		if ('+-*/^()'.includes(char)) {
			tokens.push({ type: 'op', value: char })
			i++
			continue
		}
		throw new Error(`Unexpected "${char}" in "${source}"`)
	}
	return tokens
}

/**
 * Precedence, lowest first: + -, then * / and implicit multiplication (2x,
 * 3(x+1)), then unary minus, then ^ (right-associative), then calls and atoms.
 */
function parse(source: string): Node {
	const tokens = tokenize(source)
	let position = 0
	const peek = () => tokens[position]
	const isOp = (value: string) => peek()?.type === 'op' && peek()!.value === value

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
		return !!token && (token.type === 'number' || token.type === 'name' || (token.type === 'op' && token.value === '('))
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
	const atom = (): Node => {
		const token = peek()
		if (!token) throw new Error(`"${source}" ends too early`)
		if (token.type === 'number') {
			position++
			return { kind: 'number', value: token.value }
		}
		if (token.type === 'name') {
			position++
			if (token.value in FUNCTIONS) {
				if (!isOp('(')) throw new Error(`${token.value} needs parentheses in "${source}"`)
				position++
				const arg = expression()
				if (!isOp(')')) throw new Error(`Missing ")" in "${source}"`)
				position++
				return { kind: 'call', fn: token.value, arg }
			}
			return { kind: 'name', name: token.value }
		}
		if (token.value === '(') {
			position++
			const inner = expression()
			if (!isOp(')')) throw new Error(`Missing ")" in "${source}"`)
			position++
			return inner
		}
		throw new Error(`Unexpected "${token.value}" in "${source}"`)
	}

	const node = expression()
	if (position < tokens.length) throw new Error(`Unexpected "${(tokens[position] as Token).value}" in "${source}"`)
	return node
}
