import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { GFM } from '@lezer/markdown'
import { useEffect, useRef } from 'react'

const highlight = HighlightStyle.define([
  { tag: t.comment, class: 'doc-ed-comment' },
  { tag: t.name, class: 'doc-ed-keyword' },
  { tag: t.keyword, class: 'doc-ed-keyword' },
  { tag: t.literal, class: 'doc-ed-literal' },
  { tag: t.variableName, class: 'doc-ed-name' },
  { tag: t.propertyName, class: 'doc-ed-name' },
  { tag: t.typeName, class: 'doc-ed-name' },
  { tag: t.operator, class: 'doc-ed-name' },
  { tag: t.punctuation, class: 'doc-ed-mark' },
  { tag: t.heading, class: 'doc-ed-heading' },
  { tag: t.emphasis, class: 'doc-ed-emphasis' },
  { tag: t.strong, class: 'doc-ed-strong' },
  { tag: t.link, class: 'doc-ed-link' },
  { tag: t.url, class: 'doc-ed-url' },
  { tag: t.monospace, class: 'doc-ed-code' },
  { tag: t.quote, class: 'doc-ed-quote' },
  { tag: t.processingInstruction, class: 'doc-ed-mark' },
  { tag: t.meta, class: 'doc-ed-mark' },
  { tag: t.contentSeparator, class: 'doc-ed-mark' },
  { tag: t.strikethrough, class: 'doc-ed-mark' },
])

function editorExtensions(onChange: (value: string) => void, onModSave: () => void) {
  return [
    history(),
    Prec.highest(
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onModSave()
            return true
          },
        },
      ]),
    ),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    markdown({ extensions: GFM, codeLanguages: languages }),
    syntaxHighlighting(highlight),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString())
    }),
    EditorView.contentAttributes.of({ 'aria-label': 'Article body' }),
  ]
}

export function MarkdownEditor({
  value,
  onChange,
  onModSave,
}: {
  value: string
  onChange: (value: string) => void
  onModSave: () => void
}) {
  const parent = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onModSaveRef = useRef(onModSave)
  onChangeRef.current = onChange
  onModSaveRef.current = onModSave

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is created once per mount.
  useEffect(() => {
    if (!parent.current) return
    const view = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: value,
        extensions: editorExtensions(
          (next) => onChangeRef.current(next),
          () => onModSaveRef.current(),
        ),
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    })
  }, [value])

  return <div ref={parent} className="doc-editor" />
}
