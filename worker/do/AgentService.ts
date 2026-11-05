import { AnthropicProvider, AnthropicProviderOptions, createAnthropic } from '@ai-sdk/anthropic'
import {
	createGoogleGenerativeAI,
	GoogleGenerativeAIProvider,
	GoogleGenerativeAIProviderOptions,
} from '@ai-sdk/google'
import { createOpenAI, OpenAIProvider, OpenAIResponsesProviderOptions } from '@ai-sdk/openai'
import { jsonSchema, LanguageModel, ModelMessage, Output, streamText } from 'ai'
import {
	AgentModelDefinition,
	AgentModelName,
	getAgentModelDefinition,
	isValidModelName,
} from '../../shared/models'
import { buildResponseSchema } from '../../shared/schema/buildResponseSchema'
import { DebugPart } from '../../shared/schema/PromptPartDefinitions'
import { AgentAction } from '../../shared/types/AgentAction'
import { AgentPrompt } from '../../shared/types/AgentPrompt'
import { Streaming } from '../../shared/types/Streaming'
import { Environment } from '../environment'
import { buildMessages } from '../prompt/buildMessages'
import { buildLoadedToolsPrompt, buildSystemPrompt } from '../prompt/buildSystemPrompt'
import { getModelName } from '../prompt/getModelName'
import { ActionStream } from './ActionStream'

/**
 * Output budget per response. Reasoning models spend part of it thinking, so a
 * small budget can end before the first action on a hard prompt.
 */
const MAX_OUTPUT_TOKENS = 16384

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
		this.google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_API_KEY })
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

		const { modelId, provider } = model
		if (!isValidModelName(modelId)) {
			throw new Error(`Model ${modelId} is not in AGENT_MODEL_DEFINITIONS`)
		}

		const modelDefinition = getAgentModelDefinition(modelId)
		const corePrompt = buildSystemPrompt(prompt)
		// Loaded tool groups go after the stable core, so the core stays cached.
		const loadedToolsPrompt = buildLoadedToolsPrompt(prompt)
		const systemPrompt = corePrompt + loadedToolsPrompt
		const usesNativeJsonSchema = ['meta', 'openai', 'chatgpt'].includes(modelDefinition.provider)

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
				providerOptions: getProviderOptions(modelDefinition),
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
							`[usage] model=${modelId} actions=${prompt.mode.actionTypes.length} groups=${prompt.mode.loadedToolGroups?.join('+') || 'none'} systemChars=${systemPrompt.length} schemaChars=${corePrompt.length - buildSystemPrompt(prompt, { withSchema: false }).length} loadedChars=${loadedToolsPrompt.length} input=${usage.inputTokens ?? '?'} cached=${usage.cachedInputTokens ?? 0} output=${usage.outputTokens ?? '?'} reasoning=${usage.reasoningTokens ?? 0}`
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
function getProviderOptions(definition: AgentModelDefinition): StreamTextProviderOptions {
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
					reasoningEffort: definition.reasoningEffort,
				} satisfies OpenAIResponsesProviderOptions,
			}
	}
}
