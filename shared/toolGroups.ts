/**
 * Groups of agent actions and guides that load only when a task needs them,
 * so every request does not pay for them. The prompt always lists each group
 * in one line. A group's action schemas and guide are appended after the
 * stable part of the system prompt once it is loaded, so the cached prefix
 * holds. Loaded groups stay loaded for the conversation.
 *
 * Visual actions are not here: they are the product, and always loaded.
 * Action names here are plain strings, because the action schemas import
 * this file and a typed import here would be circular.
 */
export const TOOL_GROUPS = {
	drawing: {
		useWhen: 'freehand sketches and pictures drawn with the pen, and circling or underlining part of the board',
		actions: ['pen'],
	},
	design: {
		useWhen: 'mockups, app and web screens, wireframes, and the visual design of a page or layout',
		actions: [],
	},
	layout: {
		useWhen: 'aligning, distributing, stacking, or placing several shapes relative to each other',
		actions: ['place', 'stack', 'align', 'distribute'],
	},
} as const satisfies Record<string, { useWhen: string; actions: readonly string[] }>

export type ToolGroupId = keyof typeof TOOL_GROUPS

export const TOOL_GROUP_IDS = Object.keys(TOOL_GROUPS) as ToolGroupId[]

/** Every action that belongs to a group, and so is not in the always-loaded core. */
export const GROUPED_ACTIONS: ReadonlySet<string> = new Set(
	TOOL_GROUP_IDS.flatMap((id) => TOOL_GROUPS[id].actions as readonly string[])
)

/**
 * Groups a request plainly needs, from signals the client already has: the
 * user's words and how many shapes are selected. Loading them up front saves
 * the extra model pass a `load_tools` action would cost. A false positive only
 * costs tokens, so the patterns lean broad.
 */
export function getPreloadedToolGroups({
	text,
	selectedCount,
}: {
	text: string
	selectedCount: number
}): ToolGroupId[] {
	const groups: ToolGroupId[] = []
	if (
		/\b(?:sketch\w*|doodle\w*|freehand|scribble\w*|illustrat\w*|underlin\w*|pen|circle (?:the|this|that|it)|draw(?:ing)? (?:a|an|me|the|some) (?!flow|diagram|chart|graph|map|concept))\b/i.test(text)
	) {
		groups.push('drawing')
	}
	if (/\b(mock-?ups?|wireframes?|screens?|ui|ux|apps?|landing|website|web ?page|dashboard|prototype|interface|onboarding)\b/i.test(text)) {
		groups.push('design')
	}
	if (
		selectedCount >= 2 ||
		/\b(align|line (?:these|them|those) up|distribute|space (?:these|them|those|out)|evenly|stack|arrange|tidy|organi[sz]e|in a (?:row|column|grid))\b/i.test(text)
	) {
		groups.push('layout')
	}
	return groups
}
