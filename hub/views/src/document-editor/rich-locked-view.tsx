import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { Lock } from 'lucide-react'
import { useContext } from 'react'
import { Markdown } from '../markdown/markdown.tsx'
import { RichEditContext } from './rich-edit-context.ts'
import { richLockedViewStyles } from './rich-locked-view.styles.ts'

export function LockedBlockView({ node }: ReactNodeViewProps) {
  const { switchToMarkdown } = useContext(RichEditContext)
  const source = typeof node.attrs.source === 'string' ? node.attrs.source : ''
  const label = typeof node.attrs.label === 'string' ? node.attrs.label : null
  return (
    <NodeViewWrapper className={richLockedViewStyles().root()} contentEditable={false}>
      {label ? (
        <p className={richLockedViewStyles().generated()}>{label}</p>
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
