import { SceneTemplatesPart } from '../../shared/schema/PromptPartDefinitions'
import { getSavedTemplates } from '../shapes/scene/templates'
import { PromptPartUtil, registerPromptPartUtil } from './PromptPartUtil'

/**
 * The scene templates saved on this board. The built-in ones never change, so
 * they are in the cached system prompt instead.
 */
export const SceneTemplatesPartUtil = registerPromptPartUtil(
	class SceneTemplatesPartUtil extends PromptPartUtil<SceneTemplatesPart> {
		static override type = 'sceneTemplates' as const

		override getPart(): SceneTemplatesPart {
			const templates = this.editor ? getSavedTemplates(this.editor) : []
			return {
				type: 'sceneTemplates',
				templates: templates.map((t) => ({
					id: t.id,
					title: t.title,
					useFor: t.useFor,
					params: t.params.map((p) => `${p.name} (${p.min} to ${p.max})`),
					saved: true,
				})),
			}
		}
	}
)
