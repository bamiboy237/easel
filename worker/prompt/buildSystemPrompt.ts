import { buildResponseSchema } from '../../shared/schema/buildResponseSchema'
import type { ModePart } from '../../shared/schema/PromptPartDefinitions'
import { GROUPED_ACTIONS, TOOL_GROUP_IDS, TOOL_GROUPS, ToolGroupId } from '../../shared/toolGroups'
import { AgentPrompt } from '../../shared/types/AgentPrompt'
import { getSystemPromptFlags } from './getSystemPromptFlags'
import { buildIntroPromptSection } from './sections/intro-section'
import { buildRulesPromptSection } from './sections/rules-section'
import canvasWorkSkill from './skills/canvas-work.md?raw'
import designSkill from './skills/design.md?raw'
import drawingSkill from './skills/drawing.md?raw'
import explainingSkill from './skills/explaining.md?raw'
import { BUILT_IN_TEMPLATES } from '../../client/shapes/scene/templates'

/**
 * Build the system prompt for the agent.
 *
 * This is the main instruction set that tells the AI how to behave.
 * The prompt is constructed from modular sections that adapt based on
 * what actions and parts are available.
 *
 * @param prompt - The prompt containing all parts including the mode part.
 * @param opts - Options for building the system prompt.
 * @param opts.withSchema - Whether to include the JSON schema in the system prompt. Defaults to true.
 * @returns The system prompt string.
 */
export function buildSystemPrompt(
	prompt: AgentPrompt,
	opts: { withSchema: boolean } = { withSchema: true }
): string {
	const { withSchema = true } = opts

	const modePart = prompt.mode
	if (!modePart) {
		throw new Error('A mode part is always required.')
	}

	const { actionTypes, partTypes } = modePart
	const flags = getSystemPromptFlags(actionTypes, partTypes)

	const lines = [
		buildIntroPromptSection(flags),
		canvasWorkSkill,
		explainingSkill,
		buildRulesPromptSection(flags),
	]

	if (modePart.actionTypes.includes('scene_template')) lines.push(buildTemplatesSection())

	if (withSchema) {
		lines.push(buildSchemaPromptSection(modePart))
		lines.push(buildToolGroupsIndexSection(modePart))
	}

	const result = normalizeNewlines(lines.join('\n'))

	return result
}

/** The guide each tool group brings with it, if any. */
const TOOL_GROUP_GUIDES: Partial<Record<ToolGroupId, string>> = {
	drawing: drawingSkill,
	design: designSkill,
	layout: `- To arrange several shapes, prefer \`align\`, \`distribute\`, \`stack\`, and \`place\` over moving each shape: they are faster and more exact. Use \`move\` and \`update\` when a shape needs precise, custom placement.`,
}

/**
 * The always-loaded actions: every action outside a tool group. This part of
 * the prompt does not depend on which groups are loaded, so it stays cached.
 */
function getCoreActionTypes(modePart: ModePart) {
	return modePart.actionTypes.filter((type) => !GROUPED_ACTIONS.has(type))
}

function buildToolGroupsIndexSection(modePart: ModePart) {
	if (!modePart.actionTypes.includes('load_tools')) return ''
	const rows = TOOL_GROUP_IDS.map((id) => {
		const actions = TOOL_GROUPS[id].actions as readonly string[]
		const names = actions.length ? ` Actions: ${actions.map((a) => `\`${a}\``).join(', ')}.` : ''
		return `- \`${id}\`: ${TOOL_GROUPS[id].useWhen}.${names}`
	})
	return `## Tool groups

Some tools load only when a task needs them, each with its schema and guide. Groups loaded in this conversation are described under "Loaded tools" at the end of this prompt; any other group is not loaded. Before work that needs a group that is not loaded, send one \`load_tools\` action with the groups and the task as its intent, and nothing else. You continue in the next pass with them loaded.

${rows.join('\n')}
`
}

/**
 * The schemas and guides of the tool groups loaded in this conversation, in
 * the order they loaded. This goes after the stable system prompt and only
 * grows at its end, so the cached part of the prompt does not change.
 */
export function buildLoadedToolsPrompt(prompt: AgentPrompt): string {
	const modePart = prompt.mode
	const loaded = modePart?.loadedToolGroups ?? []
	if (!modePart || loaded.length === 0) return ''
	const sections = loaded
		.filter((id) => TOOL_GROUPS[id])
		.map((id) => {
			const actions = (TOOL_GROUPS[id].actions as readonly string[]).filter((a) =>
				modePart.actionTypes.includes(a as ModePart['actionTypes'][number])
			) as ModePart['actionTypes']
			const schema = actions.length
				? `These actions are now available, in the same response format:\n\n${JSON.stringify(buildResponseSchema(actions, modePart.modeType))}\n`
				: ''
			return `## Loaded tools: ${id}\n\n${schema}\n${TOOL_GROUP_GUIDES[id] ?? ''}`
		})
	return normalizeNewlines(`\n${sections.join('\n')}`)
}

/**
 * The built-in scene templates. They never change, so they live in the cached
 * system prompt; templates a user saved on the board come with each request.
 */
function buildTemplatesSection() {
	const rows = BUILT_IN_TEMPLATES.map(
		(t) => `  - ${t.id}: ${t.title}, for ${t.useFor}. Params: ${t.params.map((p) => `${p.name} (${p.min} to ${p.max})`).join(', ')}.`
	)
	return `## Scene templates

Scene templates you can place with scene_template. These are checked and verified, so prefer one when it fits:
${rows.join('\n')}
`
}

function buildSchemaPromptSection(modePart: ModePart) {
	const schema = buildResponseSchema(getCoreActionTypes(modePart), modePart.modeType)

	return `## JSON schema

This is the JSON schema for the events you can return. You must conform to this schema. You must only return things in this format, otherwise your response will error. Output ONLY the JSON itself — do not add any preamble, explanation, or commentary before or after it, and do NOT wrap your response in a markdown code block (e.g. \`\`\`json). Just the raw JSON object.

Put explanations and progress updates in message actions. When no action is needed, return {"actions":[]}. Use this same response format for reviews and follow-up requests.

${JSON.stringify(schema)}
`
}

function normalizeNewlines(text: string): string {
	return text.replace(/\n{3,}/g, '\n\n')
}
