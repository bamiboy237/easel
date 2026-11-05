import { SceneTemplatesPart } from '../../shared/schema/PromptPartDefinitions'
import { getAllTemplates } from '../shapes/scene/templates'
import { PromptPartUtil, registerPromptPartUtil } from './PromptPartUtil'

/** The scene templates the agent can place: the built-in ones and this board's own. */
export const SceneTemplatesPartUtil = registerPromptPartUtil(
	class SceneTemplatesPartUtil extends PromptPartUtil<SceneTemplatesPart> {
		static override type = 'sceneTemplates' as const

		override getPart(): SceneTemplatesPart {
			const templates = this.editor ? getAllTemplates(this.editor) : []
			return {
				type: 'sceneTemplates',
				templates: templates.map((t) => ({
					id: t.id,
					title: t.title,
					useFor: t.useFor,
					params: t.params.map((p) => `${p.name} (${p.min} to ${p.max})`),
				})),
			}
		}
	}
)
