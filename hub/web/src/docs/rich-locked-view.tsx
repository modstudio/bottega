import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { Lock } from 'lucide-react'
import { useContext } from 'react'
import { Markdown } from '@/components/markdown/markdown'
import { RichEditContext } from './rich-edit-context.ts'

export function LockedBlockView({ node }: ReactNodeViewProps) {
  const { switchToMarkdown } = useContext(RichEditContext)
  const source = typeof node.attrs.source === 'string' ? node.attrs.source : ''
  return (
    <NodeViewWrapper className="doc-editor-locked" contentEditable={false}>
      <Markdown content={source} />
      <span className="doc-editor-locked-icon p-1 text-icon-muted" aria-hidden="true">
        <Lock size={14} />
      </span>
      <button
        type="button"
        className="doc-editor-locked-edit bg-surface-page px-2 py-1 text-text-muted text-xs"
        onClick={switchToMarkdown}
      >
        <Lock size={14} aria-hidden="true" />
        Edit in Markdown mode
      </button>
    </NodeViewWrapper>
  )
}
