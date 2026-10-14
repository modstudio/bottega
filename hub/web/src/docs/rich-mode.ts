export const DOC_EDITOR_MODES = ['rich', 'markdown'] as const
export type DocEditorMode = (typeof DOC_EDITOR_MODES)[number]
export const DOC_EDITOR_MODE_KEY = 'hub-docs-editor-mode'
export const DOC_EDITOR_MODE_DEFAULT: DocEditorMode = 'rich'
