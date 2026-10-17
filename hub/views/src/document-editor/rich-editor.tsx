import type { Editor } from '@tiptap/core'
import { EditorContent, ReactNodeViewRenderer, useEditor } from '@tiptap/react'
import { useEffect, useRef } from 'react'
import { Markdown } from '../markdown/markdown.tsx'
import { RichEditContext } from './rich-edit-context.ts'
import { richExtensions } from './rich-extensions.ts'
import { LOCKED_BLOCK_NAME, LockedBlock } from './rich-locked.ts'
import { LockedBlockView } from './rich-locked-view.tsx'
import { type DocumentBodyTransform, parseRichDocument, saveRichDocument } from './rich-save.ts'

function editorExtensions(lockedView: typeof LockedBlockView) {
  return richExtensions().map((extension) =>
    extension.name === LOCKED_BLOCK_NAME
      ? LockedBlock.extend({
          addNodeView: () => ReactNodeViewRenderer(lockedView),
        })
      : extension,
  )
}

function preventLinkOpen(_view: unknown, event: Event) {
  const target = event.target
  if (target instanceof HTMLElement && target.closest('a')) event.preventDefault()
  return false
}

export function RichEditor({
  value,
  onChange,
  onReady,
  onSwitchToMarkdown,
  bodyLabel = 'Body',
  bodyTransform,
  lockedFences,
}: {
  value: string
  onChange: (value: string) => void
  onReady: (editor: Editor | null) => void
  onSwitchToMarkdown: () => void
  bodyLabel?: string
  bodyTransform?: DocumentBodyTransform
  lockedFences?: Record<string, string>
}) {
  const sourceRef = useRef(value)
  const lastSent = useRef(value)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const editor = useEditor({
    extensions: editorExtensions(LockedBlockView),
    content: { type: 'doc', content: parseRichDocument(value, { bodyTransform, lockedFences }) },
    editorProps: {
      attributes: { class: 'markdown doc-editor-rich', 'aria-label': bodyLabel },
      handleDOMEvents: { click: preventLinkOpen },
    },
    onUpdate: ({ editor: instance }) => {
      const next = saveRichDocument(sourceRef.current, instance.getJSON().content ?? [], {
        bodyTransform,
        lockedFences,
      })
      if (next === lastSent.current) return
      lastSent.current = next
      onChangeRef.current(next)
    },
  })

  useEffect(() => {
    onReady(editor)
    return () => onReady(null)
  }, [editor, onReady])

  useEffect(() => {
    if (!editor || value === lastSent.current) return
    sourceRef.current = value
    lastSent.current = value
    editor.commands.setContent({
      type: 'doc',
      content: parseRichDocument(value, { bodyTransform, lockedFences }),
    })
  }, [editor, value, bodyTransform, lockedFences])

  if (!editor) return <Markdown content={bodyTransform?.split(value).editable ?? value} />

  return (
    <RichEditContext.Provider value={{ switchToMarkdown: onSwitchToMarkdown }}>
      <EditorContent editor={editor} />
    </RichEditContext.Provider>
  )
}
