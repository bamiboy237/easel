import { AnthropicProvider, AnthropicProviderOptions, createAnthropic } from '@ai-sdk/anthropic'
import {
	createGoogleGenerativeAI,
	GoogleGenerativeAIProvider,
	GoogleGenerativeAIProviderOptions,
} from '@ai-sdk/google'
import { createOpenAI, OpenAIProvider, OpenAIResponsesProviderOptions } from '@ai-sdk/openai'
import { ImagePart, jsonSchema, LanguageModel, ModelMessage, Output, streamText, TextPart } from 'ai'
import {
	AgentModelDefinition,
	AgentModelName,
	getAgentModelDefinition,
	isValidModelName,
	OpenAIReasoningEffort,
} from '../../shared/models'
import { buildResponseSchema } from '../../shared/schema/buildResponseSchema'
import { DebugPart, ModelNamePart } from '../../shared/schema/PromptPartDefinitions'
import { AgentAction } from '../../shared/types/AgentAction'
import { AgentPrompt } from '../../shared/types/AgentPrompt'
import { Streaming } from '../../shared/types/Streaming'
import { Environment } from '../environment'
import { buildMessages } from '../prompt/buildMessages'
import { buildLoadedToolsPrompt, buildSystemPrompt } from '../prompt/buildSystemPrompt'
import { getModelName } from '../prompt/getModelName'
import { ANIMATION_CHOOSE_PROMPT, ANIMATION_REVIEW_PROMPT, animationWriterPrompt } from '../prompt/animationPrompt'
import { WIDGET_SYSTEM_PROMPT } from '../prompt/widgetPrompt'
import { ActionStream } from './ActionStream'

/**
 * Output budget per response. Reasoning models spend part of it thinking, so a
 * small budget can end before the first action on a hard prompt.
 */
const MAX_OUTPUT_TOKENS = 16384

/** How hard an OpenAI model reasons while writing a widget's code. */
const WIDGET_WRITER_EFFORT: OpenAIReasoningEffort = 'medium'

/** How hard an OpenAI model reasons while writing, and while checking, an animation. */
const ANIMATION_WRITER_EFFORT: OpenAIReasoningEffort = 'medium'
const ANIMATION_REVIEW_EFFORT: OpenAIReasoningEffort = 'low'

/** What the board sends to have a widget written. */
export interface WidgetRequest {
	modelName: string
	title: string
	brief: string
	width: number
	height: number
	params: { name: string; value: number; min: number; max: number; step: number }[]
	state: Record<string, unknown>
	/** What was wrong with the last attempt, for a retry. */
	problem?: string
}

/** What the board sends to have an animation written, or a render of it checked. */
export interface AnimationRequest {
	modelName: string
	title: string
	brief: string
	/** write: a new scene, or a rewrite after a failed render. review: check frames of a render of source. */
	mode?: 'write' | 'review'
	/** The scene so far: the one that failed, or the one whose frames are checked. */
	source?: string
	/** What was wrong with the last attempt, such as Manim's error, for a rewrite. */
	problem?: string
	/** Frames of a low-resolution render, as PNG data URLs, each with its time in seconds. */
	frames?: { image: string; time: number }[]
	/** What the automatic layout check found in the render. */
	layout?: string[]
	duration?: number
	/** A second version of the scene, written beside the first: the review picks the better one, then checks it. */
	alternative?: { source: string; frames: { image: string; time: number }[]; layout: string[]; duration?: number }
}

export class AgentService {
	openai: OpenAIProvider
	anthropic: AnthropicProvider
	google: GoogleGenerativeAIProvider
	meta: OpenAIProvider
	chatgpt: OpenAIProvider

	constructor(env: Environment) {
		// The same base as the voice route, which in development goes through a local relay.
		this.openai = createOpenAI({
			apiKey: env.OPENAI_API_KEY,
			...(env.OPENAI_API_BASE_URL ? { baseURL: `${env.OPENAI_API_BASE_URL.replace(/\/$/, '')}/v1` } : {}),
		})
		this.anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })
		this.google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY })
		this.meta = createOpenAI({
			apiKey: env.MODEL_API_KEY,
			baseURL: env.MODEL_API_BASE_URL || 'https://api.meta.ai/v1',
		})
		// chatgpt/helper.ts holds the real token, so this key is never used.
		this.chatgpt = createOpenAI({ apiKey: 'unused', baseURL: 'http://127.0.0.1:8788/v1' })
	}

	getModel(modelName: AgentModelName): LanguageModel {
		const modelDefinition = getAgentModelDefinition(modelName)
		const provider = modelDefinition.provider
		return this[provider](modelDefinition.id)
	}

	/**
	 * Write a widget's HTML, CSS, and JavaScript from a brief, in one model call,
	 * streamed as it is written: the board shows the layout before the script.
	 */
	streamWidget(request: WidgetRequest): AsyncIterable<string> {
		const modelName = isValidModelName(request.modelName) ? request.modelName : getModelName({} as AgentPrompt)
		const model = this.getModel(modelName)
		const definition = getAgentModelDefinition(modelName)
		const params = request.params.length
			? request.params.map((p) => `${p.name} = ${p.value} (from ${p.min} to ${p.max}, step ${p.step})`).join('; ')
			: 'none'
		const prompt = [
			`Title: ${request.title}`,
			`Size: ${Math.round(request.width)} by ${Math.round(request.height)} pixels.`,
			`Parameters: ${params}.`,
			`State, with starting values: ${JSON.stringify(request.state)}.`,
			`Brief: ${request.brief}`,
			request.problem ? `Your last attempt had this problem, so fix it: ${request.problem}` : '',
		]
			.filter(Boolean)
			.join('\n')
		const started = Date.now()
		const result = streamText({
			model,
			system: WIDGET_SYSTEM_PROMPT,
			prompt,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			...(definition.supportsTemperature ? { temperature: 0 } : {}),
			// The brief is already a full spec, so the writer needs less reasoning
			// than the agent that planned it.
			providerOptions: getProviderOptions(definition, WIDGET_WRITER_EFFORT),
		})
		void Promise.resolve(result.usage)
			.then((usage) =>
				console.log(
					`[widget] model=${modelName} seconds=${Math.round((Date.now() - started) / 1000)} input=${usage.inputTokens ?? 0} output=${usage.outputTokens ?? 0}`
				)
			)
			.catch(() => {})
		return result.textStream
	}

	/**
	 * Write a Manim scene from a brief, or check frames of a render of one and
	 * fix it, in one model call, streamed as it is written.
	 */
	streamAnimation(request: AnimationRequest): AsyncIterable<string> {
		const modelName = isValidModelName(request.modelName) ? request.modelName : getModelName({} as AgentPrompt)
		const model = this.getModel(modelName)
		const definition = getAgentModelDefinition(modelName)
		const review = request.mode === 'review' && !!request.source
		const intro = [`Title: ${request.title}`, `Brief: ${request.brief}`]
		let content: Array<TextPart | ImagePart> = []
		const choose = review && !!request.alternative
		if (review) {
			const versions = [
				{ name: 'A', source: request.source!, frames: request.frames ?? [], layout: request.layout ?? [], duration: request.duration },
				...(request.alternative ? [{ name: 'B', ...request.alternative }] : []),
			]
			content = [{ type: 'text', text: intro.join('\n\n') }]
			for (const v of versions) {
				const frames = v.frames.slice(0, choose ? 5 : 6)
				content.push({
					type: 'text',
					text: [
						choose ? `Version ${v.name}:` : 'The scene you wrote:',
						`\`\`\`python\n${v.source}\n\`\`\``,
						`It runs ${v.duration ?? '?'} seconds. The frames below are at ${frames.map((f) => `${f.time.toFixed(1)} s`).join(', ')}; the last is the final picture.`,
						v.layout.length ? `The automatic layout check found:\n${v.layout.map((p) => `- ${p}`).join('\n')}` : 'The automatic layout check found nothing.',
					].join('\n\n'),
				})
				content.push(...frames.map((f) => ({ type: 'image' as const, image: f.image.replace(/^data:image\/\w+;base64,/, ''), mediaType: 'image/png' })))
			}
		} else {
			const lines = [...intro]
			if (request.source && request.problem) {
				lines.push(`Your last version:\n\`\`\`python\n${request.source}\n\`\`\``, `It failed with this error, so fix it and send the whole file again: ${request.problem}`)
			} else if (request.problem) {
				lines.push(`Your last attempt had this problem, so avoid it: ${request.problem}`)
			}
			content = [{ type: 'text', text: lines.join('\n\n') }]
		}
		const started = Date.now()
		const result = streamText({
			model,
			// The review needs the rules, not the reference scenes: a shorter prompt answers sooner.
			system: choose ? ANIMATION_CHOOSE_PROMPT : review ? ANIMATION_REVIEW_PROMPT : animationWriterPrompt(request.title ?? '', request.brief ?? ''),
			messages: [{ role: 'user', content } as ModelMessage],
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			...(definition.supportsTemperature ? { temperature: 0 } : {}),
			providerOptions: getProviderOptions(definition, review ? ANIMATION_REVIEW_EFFORT : ANIMATION_WRITER_EFFORT),
		})
		void Promise.resolve(result.usage)
			.then((usage) =>
				console.log(
					`[animation] ${choose ? 'choose' : review ? 'review' : 'write'} model=${modelName} seconds=${Math.round((Date.now() - started) / 1000)} input=${usage.inputTokens ?? 0} output=${usage.outputTokens ?? 0}`
				)
			)
			.catch(() => {})
		return result.textStream
	}

	async *stream(prompt: AgentPrompt): AsyncGenerator<Streaming<AgentAction>> {
		try {
			for await (const event of this.streamActions(prompt)) {
				yield event
			}
		} catch (error: any) {
			console.error('Stream error:', error)
			throw error
		}
	}

	private async *streamActions(prompt: AgentPrompt): AsyncGenerator<Streaming<AgentAction>> {
		const modelName = getModelName(prompt)
		const model = this.getModel(modelName)

		if (typeof model === 'string') {
			throw new Error('Model is a string, not a LanguageModel')
		}

		const { provider } = model
		// The definition comes from the name the user picked, not the provider's
		// model id: one model can be listed twice, billed by an API key or by a
		// ChatGPT plan.
		const modelId = modelName

		const modelDefinition = getAgentModelDefinition(modelName)
		const usesNativeJsonSchema = ['meta', 'openai', 'chatgpt'].includes(modelDefinition.provider)
		// The schema stays in the prompt even where it is also the response format:
		// without it, OpenAI models sent field values the schema does not allow. It
		// is part of the cached core, so it costs little.
		const corePrompt = buildSystemPrompt(prompt)
		// Loaded tool groups go after the stable core, so the core stays cached.
		const loadedToolsPrompt = buildLoadedToolsPrompt(prompt)
		const systemPrompt = corePrompt + loadedToolsPrompt

		// Build messages with provider-specific options
		const messages: ModelMessage[] = []

		// The system prompt goes in the SDK's `system` option, except for Anthropic:
		// its cache breakpoint is set on a system message, at the end of the system
		// prompt, so all system content (which changes together) is cached.
		const systemInMessages = provider === 'anthropic.messages'
		if (systemInMessages) {
			// Two cache breakpoints: the stable core, then the loaded tool groups,
			// which only grow at their end.
			for (const content of [corePrompt, loadedToolsPrompt].filter(Boolean)) {
				messages.push({
					role: 'system',
					content,
					providerOptions: {
						anthropic: { cacheControl: { type: 'ephemeral' } },
					},
				})
			}
		}

		// Add prompt messages
		const promptMessages = buildMessages(prompt)
		messages.push(...promptMessages)

		// Check for debug flags and log if enabled
		const debugPart = prompt.debug as DebugPart | undefined
		if (debugPart) {
			if (debugPart.logSystemPrompt) {
				const promptWithoutSchema = buildSystemPrompt(prompt, { withSchema: false })
				console.log('[DEBUG] System Prompt (without schema):\n', promptWithoutSchema)
			}
			if (debugPart.logMessages) {
				console.log('[DEBUG] Messages:\n', JSON.stringify(promptMessages, null, 2))
			}
		}

		// Prefill the assistant turn to force the JSON start, where the model allows it.
		// Opus 4.7+ and Sonnet 4.6 reject last-assistant-turn prefills (400), so skip it there.
		if (modelDefinition.supportsPrefill) {
			messages.push({
				role: 'assistant',
				content: '{"actions": [{"_type":',
			})
		}

		try {
			const { fullStream } = streamText({
				model,
				...(systemInMessages ? { allowSystemInMessages: true } : { system: systemPrompt }),
				messages,
				maxOutputTokens: MAX_OUTPUT_TOKENS,
				// Opus 4.7+ removed `temperature` (and top_p/top_k); sending it returns a 400.
				...(modelDefinition.supportsTemperature ? { temperature: 0 } : {}),
				providerOptions: getProviderOptions(modelDefinition, (prompt.modelName as ModelNamePart | undefined)?.reasoningEffort),
				// Raw events let us log how a provider stream ended when it ends without finishing
				includeRawChunks: true,
				experimental_output: usesNativeJsonSchema
					? Output.object({
						schema: jsonSchema<{ actions: AgentAction[] }>(
							buildResponseSchema(prompt.mode.actionTypes, prompt.mode.modeType)
						),
					})
					: undefined,
			})

			const canForceResponseStart =
				(provider === 'anthropic.messages' || provider === 'google.generative-ai') &&
				modelDefinition.supportsPrefill
			const reader = new ActionStream(prompt.mode?.modeType ?? 'working')
			if (canForceResponseStart) {
				for (const action of reader.push('{"actions": [{"_type":')) yield action
			}
			const commentary = new Map<string, { text: string; startedAt: number }>()
			let finishReason = 'unknown'
			const lastProviderEvents: string[] = []
			for await (const part of fullStream) {
				if (part.type === 'raw') {
					lastProviderEvents.push(JSON.stringify(part.rawValue).slice(0, 300))
					if (lastProviderEvents.length > 3) lastProviderEvents.shift()
					// The SDK drops in-stream Responses API error events, so surface the provider's message.
					const providerError = getProviderStreamError(part.rawValue)
					if (providerError) throw new Error(providerError)
				}
				switch (part.type) {
					case 'text-start':
						if (part.providerMetadata?.openai?.phase === 'commentary') {
							commentary.set(part.id, { text: '', startedAt: Date.now() })
						}
						break
					case 'text-delta':
						if (commentary.has(part.id)) {
							commentary.get(part.id)!.text += part.text
						} else {
							for (const action of reader.push(part.text)) yield action
						}
						break
					case 'text-end': {
						const progress = commentary.get(part.id)
						if (progress?.text && prompt.mode.actionTypes.includes('message')) {
							yield {
								_type: 'message',
								text: progress.text,
								complete: true,
								time: Date.now() - progress.startedAt,
							}
						}
						commentary.delete(part.id)
						break
					}
					case 'finish': {
						finishReason = part.finishReason
						// One line per request, so prompt size and caching can be measured.
						const usage = part.totalUsage
						console.log(
							`[usage] model=${modelId} effort=${(prompt.modelName as ModelNamePart | undefined)?.reasoningEffort ?? ('reasoningEffort' in modelDefinition ? modelDefinition.reasoningEffort : '-')} actions=${prompt.mode.actionTypes.length} groups=${prompt.mode.loadedToolGroups?.join('+') || 'none'} systemChars=${systemPrompt.length} loadedChars=${loadedToolsPrompt.length} input=${usage.inputTokens ?? '?'} cached=${usage.cachedInputTokens ?? 0} output=${usage.outputTokens ?? '?'} reasoning=${usage.reasoningTokens ?? 0}`
						)
						break
					}
					case 'error':
						// Some providers end the stream with an error that carries nothing.
						throw part.error ??
							new Error(`The model stream failed without a reason. Last provider events: ${lastProviderEvents.join(' | ') || 'none'}`)
					case 'abort':
						throw new Error('Agent response was canceled.')
				}
			}
			if (finishReason !== 'stop') {
				console.error(`Agent response ended with "${finishReason}". Last provider events:`, lastProviderEvents)
			}
			reader.finish(finishReason)
		} catch (error: any) {
			console.error('streamActions error:', error)
			throw error
		}
	}
}

function getProviderStreamError(rawValue: unknown): string | null {
	if (!rawValue || typeof rawValue !== 'object') return null
	const event = rawValue as { type?: unknown; error?: { message?: unknown } }
	if (event.type !== 'error' || typeof event.error?.message !== 'string') return null
	return event.error.message
}

type StreamTextProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

/**
 * Map a model definition's reasoning preferences to AI SDK provider options.
 * Only the matching provider's options are set; the SDK ignores the rest.
 */
function getProviderOptions(definition: AgentModelDefinition, effort?: OpenAIReasoningEffort): StreamTextProviderOptions {
	switch (definition.provider) {
		case 'anthropic':
			return {
				anthropic: {
					thinking:
						definition.thinking === 'adaptive' ? { type: 'adaptive' } : { type: 'disabled' },
					...(definition.effort ? { effort: definition.effort } : {}),
				} satisfies AnthropicProviderOptions,
			}
		case 'google':
			return {
				google: {
					thinkingConfig: { thinkingLevel: definition.thinkingLevel },
				} satisfies GoogleGenerativeAIProviderOptions,
			}
		// Meta's Muse models are not reasoning models, so they get no reasoning effort.
		case 'meta':
			return {}
		case 'openai':
		case 'chatgpt':
			return {
				openai: {
					reasoningEffort: effort ?? definition.reasoningEffort,
				} satisfies OpenAIResponsesProviderOptions,
			}
	}
}
