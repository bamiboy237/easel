/**
 * Clean up math the agent writes in plain text, before it lands on the board.
 *
 * Board text has no subscript mark, so a model reaches for Unicode subscript
 * letters (Fₙₑₜ) or LaTeX-style underscores (F_net, F_{net}). Unicode has
 * subscripts for only some letters, and the board's serif draws them from
 * different fonts at different sizes, so a word built from them looks broken.
 * One-character subscripts that every font has, the digits and a few letters
 * (v₀, xₙ), are kept; a longer subscript is written on the line in full
 * (Fnet), as plain typography sets it. A symbol that needs a real subscript
 * belongs in an equation shape, which KaTeX typesets; the prompt says so.
 */

const SUBSCRIPT_LETTERS: Record<string, string> = {
	'ₐ': 'a', 'ₑ': 'e', 'ₒ': 'o', 'ₓ': 'x', 'ₔ': 'ə', 'ₕ': 'h', 'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₚ': 'p', 'ₛ': 's', 'ₜ': 't',
	'ᵢ': 'i', 'ᵣ': 'r', 'ᵤ': 'u', 'ᵥ': 'v', 'ⱼ': 'j', 'ᵦ': 'β', 'ᵧ': 'γ', 'ᵨ': 'ρ', 'ᵩ': 'φ', 'ᵪ': 'χ',
}
const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉'
const SUBSCRIPT_CLASS = `[${Object.keys(SUBSCRIPT_LETTERS).join('')}${SUBSCRIPT_DIGITS}₊₋₌₍₎]`
const RUN = new RegExp(`${SUBSCRIPT_CLASS}{2,}`, 'g')

const plain = (run: string) =>
	[...run]
		.map((c) => {
			const digit = SUBSCRIPT_DIGITS.indexOf(c)
			if (digit >= 0) return String(digit)
			return SUBSCRIPT_LETTERS[c] ?? ({ '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')' } as Record<string, string>)[c] ?? c
		})
		.join('')

const toSubscriptDigits = (digits: string) => [...digits].map((d) => SUBSCRIPT_DIGITS[Number(d)]).join('')

export function typesetText(text: string): string {
	if (!text) return text
	return (
		text
			// F_{net} and F_net on a one-letter symbol: digits become subscript digits
			// (v_0 → v₀), longer words are set in full. Names such as file_name are left alone.
			.replace(/(?<![A-Za-z0-9_])([A-Za-zα-ωΑ-Ω])_(?:\{([A-Za-z0-9]{1,8})\}|([A-Za-z0-9]{1,8})(?![A-Za-z0-9_]))/g, (_, base: string, a?: string, b?: string) => {
				const sub = (a ?? b)!
				return base + (/^\d+$/.test(sub) ? toSubscriptDigits(sub) : sub)
			})
			// Runs of two or more Unicode subscripts mix fonts: set them on the line.
			.replace(RUN, (run) => (/^[₀-₉]+$/.test(run) ? run : plain(run)))
	)
}
