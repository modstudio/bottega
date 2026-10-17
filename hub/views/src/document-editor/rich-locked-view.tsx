import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { Lock } from 'lucide-react'
import { useContext } from 'react'
import { Markdown } from '../markdown/markdown.tsx'
import { fenceUse } from '../markdown/markdown-fences.ts'
import { RichEditContext } from './rich-edit-context.ts'
import { richLockedViewStyles } from './rich-locked-view.styles.ts'

export function LockedBlockView({ node }: ReactNodeViewProps) {
  const { switchToMarkdown } = useContext(RichEditContext)
  const source = typeof node.attrs.source === 'string' ? node.attrs.source : ''
  const language = /^```([^\n]*)/.exec(source)?.[1]
  const generatedArticleList = fenceUse(language) === 'article-list'
  return (
    <NodeViewWrapper className={richLockedViewStyles().root()} contentEditable={false}>
      {generatedArticleList ? (
        <p className={richLockedViewStyles().generated()}>Article list (generated)</p>
      ) : (
        <Markdown content={source} />
      )}
      <span className={richLockedViewStyles().icon()} aria-hidden="true">
        <Lock size={14} />
      </span>
      <button type="button" className={richLockedViewStyles().edit()} onClick={switchToMarkdown}>
        <Lock size={14} aria-hidden="true" />
        Edit in Markdown mode
      </button>
    </NodeViewWrapper>
  )
}
