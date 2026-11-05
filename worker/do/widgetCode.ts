export interface WidgetCode {
	html: string
	css: string
	js: string
}

/**
 * The widget code from a reply: three fenced blocks, html, css, and js. Code
 * written as plain blocks is shorter and better than code escaped inside JSON.
 * A JSON object is still read, in case a model replies that way.
 */
export function parseWidgetCode(text: string): WidgetCode {
	const block = (...langs: string[]) => {
		for (const lang of langs) {
			const match = new RegExp('```' + lang + '[^\\S\\n]*\\n([\\s\\S]*?)\\n?```', 'i').exec(text)
			if (match) return match[1]
		}
		return null
	}
	const html = block('html')
	const js = block('js', 'javascript')
	if (html !== null || js !== null) {
		const code = { html: html ?? '', css: block('css') ?? '', js: js ?? '' }
		if (!code.html.trim() && !code.js.trim()) throw new Error('The reply had empty html and js blocks.')
		return code
	}
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start < 0 || end <= start) throw new Error('The reply had no html, css, and js blocks.')
	const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<WidgetCode>
	const str = (v: unknown) => (typeof v === 'string' ? v : '')
	const code = { html: str(parsed.html), css: str(parsed.css), js: str(parsed.js) }
	if (!code.html && !code.js) throw new Error('The reply had no HTML or JavaScript.')
	return code
}
