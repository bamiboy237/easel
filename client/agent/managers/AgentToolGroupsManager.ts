import { Atom, atom } from 'tldraw'
import { TOOL_GROUP_IDS, ToolGroupId } from '../../../shared/toolGroups'
import type { TldrawAgent } from '../TldrawAgent'
import { BaseAgentManager } from './BaseAgentManager'

/**
 * The tool groups loaded in this conversation. Groups are only ever added, in
 * the order they load, so the prompt they produce only grows at its end and
 * the cached part of the prompt stays the same. A new conversation starts empty.
 */
export class AgentToolGroupsManager extends BaseAgentManager {
	private $loaded: Atom<ToolGroupId[]>

	constructor(agent: TldrawAgent) {
		super(agent)
		this.$loaded = atom<ToolGroupId[]>('loadedToolGroups', [])
	}

	getLoaded(): ToolGroupId[] {
		return this.$loaded.get()
	}

	/** Load groups that are not loaded yet. Returns the groups that were new. */
	load(groups: readonly string[]): ToolGroupId[] {
		const loaded = this.$loaded.get()
		const added = groups.filter(
			(id): id is ToolGroupId => (TOOL_GROUP_IDS as string[]).includes(id) && !loaded.includes(id as ToolGroupId)
		)
		const unique = [...new Set(added)]
		if (unique.length > 0) this.$loaded.set([...loaded, ...unique])
		return unique
	}

	reset(): void {
		this.$loaded.set([])
	}
}
