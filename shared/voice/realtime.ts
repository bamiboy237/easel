/**
 * The voice model's setup, shared by the server, which mints a session key with
 * it, and the client, which runs the tools. The voice model is OpenAI Realtime
 * speech to speech over WebRTC. Its tools are the agent's canvas tools that
 * make sense while talking, plus `delegate`, which hands heavy work to the agent.
 */

/** The speech-to-speech model: the GA Realtime mini, which handles tool calls well at a lower cost. */
export const VOICE_MODEL = 'gpt-realtime-2.1-mini'
export const VOICE_NAME = 'marin'
/** The user's words are transcribed with the same model as mark and speak. */
export const VOICE_TRANSCRIBE_MODEL = 'gpt-live-transcribe'
export const VOICE_SAMPLE_RATE = 24000

/** Push to talk: the user holds the mic. Hands-free: the server hears when a turn starts and ends. */
export type VoiceMode = 'push' | 'handsfree'

export function voiceTurnDetection(mode: VoiceMode) {
	if (mode === 'push') return null
	return {
		type: 'server_vad' as const,
		threshold: 0.5,
		prefix_padding_ms: 300,
		silence_duration_ms: 500,
		create_response: true,
		interrupt_response: true,
	}
}

export const VOICE_INSTRUCTIONS = `You are Easel's voice. You and the user share a whiteboard, and you talk about it while you point at it and change it.

How you speak:
- Answer first. Your first sentence is the answer to what the user asked, with no preamble: never "Let me point out a few things first" or "Great question", and never describe how something looks ("a straight black curve") unless they asked about its look.
- Never narrate your own steps: no "I'll quickly check the board", "Now I'm pointing at", or "I'm adding a note". The cursor and the board show what you do; your words are the content.
- Short spoken answers: one to three sentences, plain words, a calm teacher's pace. Answer every part of the question; if they asked how two things connect, say the connection.
- Use the board's own notation. If the graph shows v = a t, talk about v, a, and t, not y, x, or a generic "y = a x"; the same in notes. Never read IDs, LaTeX, or code aloud; say "this line" or "the mass term".
- Durable content goes on the board, not into long speech: put a key fact in a note, and send anything visual to delegate.
- If the user starts talking, stop and listen. Do not repeat what you already said unless asked.
- When the user says "stop", "hold on", "wait", or "be quiet", say nothing at all, not even "okay", and wait silently until they speak to you again.

Pointing:
- Point at exactly the thing your sentence names. The line or curve is the curve part (g1.curve), a marked point is its point part, a slider is its parameter part (g1.a) only when you talk about that parameter, and an equation's term is its term part.
- In the same response, call point once with one cue per thing, in the order you will say them, then speak at once; do not wait for point's result. Each cue names a shape ID or a part ID from the board and the first words of the sentence you will say about it. Use highlight for the thing that matters most, and a plain point for the rest. The cursor and highlights are silent.
- Only point at IDs the board lists.

Changing the board:
- set_parameter moves a slider of a graph, a simulation, a scene, or a widget, the same way the user would.
- place_note puts a short note beside a shape.
- ask_prediction asks the user to predict before you show a result: it places the question on the board; then ask it aloud and wait.
- delegate hands heavy work to the drawing agent: diagrams, maps, scenes, graphs, equations, widgets, animations, or several shapes at once. Say in a few words what you are doing, call delegate, and wait; it returns when the shapes are on the board, with their IDs, so you can point at them and talk about them.
- The user's own shapes are theirs. Change one only when the user just asked for that change, and pass their exact words as user_words.
- If a tool says it was rejected, tell the user briefly what did not happen.

The board is described in system messages as it changes, and the latest one is current: answer from it directly. Call read_board only when a tool said the board changed under you.`

const target = {
	type: 'string',
	description: 'A shape ID or a part ID from the board, such as g1, g1.curve, g1.point1, eq3.term2, or scene1.ball.',
}
const userWords = {
	type: 'string',
	description:
		"Only when the target is the user's own shape: the user's exact words asking for this change. Leave it out otherwise.",
}

/** The voice model's tools, as Realtime function tools. */
export const VOICE_TOOLS = [
	{
		type: 'function',
		name: 'point',
		description:
			'Fly your cursor to things on the board while you talk about them. Call it first, with the cues in the order you will say them, then speak in the same response. Silent; it needs no answer.',
		parameters: {
			type: 'object',
			properties: {
				cues: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							target,
							highlight: { type: 'boolean', description: 'Also highlight it, for the thing that matters most.' },
							words: { type: 'string', description: 'The first few words of the sentence you will say about it.' },
						},
						required: ['target', 'words'],
					},
				},
			},
			required: ['cues'],
		},
	},
	{
		type: 'function',
		name: 'read_board',
		description: 'Read the shapes on the board now: IDs, what they show, parameter values, and part IDs.',
		parameters: { type: 'object', properties: {} },
	},
	{
		type: 'function',
		name: 'set_parameter',
		description: 'Set one parameter (slider) of a graph, a simulation, a scene, or a widget. Both of you see the change.',
		parameters: {
			type: 'object',
			properties: {
				shape: { type: 'string', description: 'The shape ID.' },
				name: { type: 'string', description: 'The parameter name, as the board lists it.' },
				value: { type: 'number' },
				user_words: userWords,
			},
			required: ['shape', 'name', 'value'],
		},
	},
	{
		type: 'function',
		name: 'place_note',
		description: 'Place a short text note beside a shape or part, for a fact worth keeping on the board.',
		parameters: {
			type: 'object',
			properties: {
				near: target,
				text: { type: 'string', description: 'One or two short lines.' },
			},
			required: ['near', 'text'],
		},
	},
	{
		type: 'function',
		name: 'ask_prediction',
		description:
			'Ask the user to predict something about a shape before you show it. Places the question beside the shape; then ask it aloud and wait for the answer.',
		parameters: {
			type: 'object',
			properties: {
				near: target,
				question: { type: 'string', description: 'The question, such as "What happens to a if m doubles?"' },
			},
			required: ['near', 'question'],
		},
	},
	{
		type: 'function',
		name: 'delegate',
		description:
			'Hand heavy board work to the drawing agent: diagrams, maps, scenes, graphs, equations, widgets, animations, or several shapes at once. Returns when the shapes are on the board, with their IDs.',
		parameters: {
			type: 'object',
			properties: {
				request: {
					type: 'string',
					description: "What to make, in the user's terms, with any detail they gave, such as where it goes.",
				},
			},
			required: ['request'],
		},
	},
] as const

export type VoiceToolName = (typeof VOICE_TOOLS)[number]['name']

/** The session the server mints a key for. */
export function voiceSessionConfig(mode: VoiceMode) {
	return {
		type: 'realtime',
		model: VOICE_MODEL,
		instructions: VOICE_INSTRUCTIONS,
		tools: VOICE_TOOLS,
		tool_choice: 'auto',
		reasoning: { effort: 'low' },
		audio: {
			input: {
				format: { type: 'audio/pcm', rate: VOICE_SAMPLE_RATE },
				noise_reduction: { type: 'near_field' },
				transcription: { model: VOICE_TRANSCRIBE_MODEL, language: 'en' },
				turn_detection: voiceTurnDetection(mode),
			},
			output: { format: { type: 'audio/pcm', rate: VOICE_SAMPLE_RATE }, voice: VOICE_NAME },
		},
	}
}
