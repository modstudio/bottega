import { Button, TextButton } from '@bottega/hub-ui/button'
import { Dialog } from '@bottega/hub-ui/dialog'
import { Input } from '@bottega/hub-ui/field/input'
import { Popover } from '@bottega/hub-ui/popover'
import { Segmented } from '@bottega/hub-ui/segmented'
import type { Editor } from '@tiptap/core'
import { Save, X } from 'lucide-react'
import {
  type FormEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Markdown } from '../markdown/markdown.tsx'
import { documentEditorStyles } from './document-editor.styles.ts'
import { readingBody } from './editor-body.ts'
export type DocumentEditorMode = 'rich' | 'markdown'

function singleLineTitle(title: string): string {
  return title.replace(/[\r\n]+/g, ' ')
}

export function EditableTitle({
  title,
  onChange,
  headingRef,
}: {
  title: string
  onChange: (title: string) => void
  headingRef: Ref<HTMLElement | null>
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const setHeadingRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      textareaRef.current = element
      if (typeof headingRef === 'function') headingRef(element)
      else if (headingRef) headingRef.current = element
    },
    [headingRef],
  )
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || textarea.value !== title || CSS.supports('field-sizing', 'content')) return
    const size = () => {
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    }
    size()
    const observer = new ResizeObserver(size)
    if (textarea.parentElement) observer.observe(textarea.parentElement)
    return () => observer.disconnect()
  }, [title])
  return (
    <textarea
      ref={setHeadingRef}
      className={documentEditorStyles().title()}
      data-long={title.length > 40 ? '' : undefined}
      rows={1}
      value={title}
      onChange={(event) => onChange(singleLineTitle(event.target.value))}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.preventDefault()
      }}
      aria-label="Title"
    />
  )
}

export function EditorBody({
  value,
  onChange,
  mode,
  onModeChange,
  onSaveShortcut,
  onRichEditorChange,
}: {
  value: string
  onChange: (value: string) => void
  mode: DocumentEditorMode
  onModeChange: (mode: DocumentEditorMode) => void
  onSaveShortcut: () => void
  onRichEditorChange?: (editor: Editor | null) => void
}) {
  const [MarkdownUi, setMarkdownUi] = useState<
    null | typeof import('./markdown-editor.tsx').MarkdownEditor
  >(null)
  const [RichUi, setRichUi] = useState<null | typeof import('./rich-editor.tsx').RichEditor>(null)
  useEffect(() => {
    let live = true
    if (mode === 'markdown') {
      void import('./markdown-editor.tsx').then((module) => {
        if (live) setMarkdownUi(() => module.MarkdownEditor)
      })
    } else {
      void import('./rich-editor.tsx').then((module) => {
        if (live) setRichUi(() => module.RichEditor)
      })
    }
    return () => {
      live = false
    }
  }, [mode])
  return (
    <div className={documentEditorStyles().body()}>
      {mode === 'markdown' ? (
        MarkdownUi ? (
          <MarkdownUi value={value} onChange={onChange} onModSave={onSaveShortcut} />
        ) : (
          <div className={documentEditorStyles().loading()}>{value}</div>
        )
      ) : RichUi ? (
        <RichUi
          value={value}
          onChange={onChange}
          onReady={onRichEditorChange ?? (() => {})}
          onSwitchToMarkdown={() => onModeChange('markdown')}
        />
      ) : (
        <Markdown content={readingBody(value)} />
      )}
    </div>
  )
}

export function EditorBand({
  toolbar,
  mode,
  onModeChange,
}: {
  toolbar: ReactNode
  mode: DocumentEditorMode
  onModeChange: (mode: DocumentEditorMode) => void
}) {
  return (
    <div className={documentEditorStyles().band()}>
      <div className={documentEditorStyles().toolbar()}>{toolbar}</div>
      <Segmented
        label="Editor mode"
        size="sm"
        value={mode}
        options={[
          { value: 'rich', label: 'Rich' },
          { value: 'markdown', label: 'Markdown' },
        ]}
        onChange={(value) => {
          if (value === 'rich' || value === 'markdown') onModeChange(value)
        }}
      />
    </div>
  )
}

export function EditorBanner({
  conflict,
  message,
  onReload,
}: {
  conflict: boolean
  message: string | null
  onReload: () => void
}) {
  if (!conflict && !message) return null
  return (
    <p data-tone="error" className={documentEditorStyles().banner()}>
      {conflict ? (
        <>
          This article was saved by someone else since you opened it.{' '}
          <TextButton onClick={onReload}>Reload</TextButton>
        </>
      ) : (
        message
      )}
    </p>
  )
}

export function EditorActions({
  saveEnabled,
  saving,
  reason,
  onCancel,
  onSave,
  popoverRef,
  reasonRef,
}: {
  saveEnabled: boolean
  saving: boolean
  reason?: { value: string; onChange: (value: string) => void; required: boolean }
  onCancel: () => void
  onSave: () => void
  popoverRef?: RefObject<HTMLDivElement | null>
  reasonRef?: RefObject<HTMLInputElement | null>
}) {
  function submit(event: FormEvent) {
    event.preventDefault()
    if ((reason?.required && !reason.value.trim()) || saving) return
    onSave()
  }
  const save = (
    <Button
      variant="primary"
      size="sm"
      disabled={!saveEnabled || saving}
      onClick={reason ? undefined : onSave}
    >
      <Save size={14} />
      Save
    </Button>
  )
  return (
    <>
      <Button size="sm" variant="secondary" onClick={onCancel}>
        <X size={14} />
        Cancel
      </Button>
      {reason ? (
        <Popover
          ref={popoverRef}
          label="What changed?"
          align="end"
          trigger={save}
          onOpenChange={(open) => {
            if (open) reasonRef?.current?.focus()
          }}
        >
          <form onSubmit={submit}>
            <label htmlFor="document-edit-reason" className={documentEditorStyles().reasonLabel()}>
              <span className={documentEditorStyles().reasonText()}>What changed?</span>
              <Input
                id="document-edit-reason"
                ref={reasonRef}
                value={reason.value}
                required={reason.required}
                onChange={(event) => reason.onChange(event.target.value)}
              />
            </label>
          </form>
        </Popover>
      ) : (
        save
      )}
    </>
  )
}

export function LeaveConfirmationDialog({
  open,
  onKeep,
  onDiscard,
}: {
  open: boolean
  onKeep: () => void
  onDiscard: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeep()
      }}
      title="Discard unsaved changes?"
      description="Your edits to this article will be lost."
      footer={
        <>
          <Button onClick={onKeep}>Keep editing</Button>
          <Button variant="primary" onClick={onDiscard}>
            Discard
          </Button>
        </>
      }
    />
  )
}

export function ReloadConfirmationDialog({
  open,
  onOpenChange,
  onReload,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onReload: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reload this article?"
      description="Your unsaved changes will be discarded."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Keep editing</Button>
          <Button variant="primary" onClick={onReload}>
            Reload
          </Button>
        </>
      }
    />
  )
}
