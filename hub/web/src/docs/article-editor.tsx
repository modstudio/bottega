import { Button, TextButton } from '@bottega/hub-ui/button'
import { Dialog } from '@bottega/hub-ui/dialog'
import { useStoredState } from '@bottega/hub-ui/dom/use-stored-state'
import { Input } from '@bottega/hub-ui/field/input'
import { Popover } from '@bottega/hub-ui/popover'
import { Segmented } from '@bottega/hub-ui/segmented'
import type { Editor } from '@tiptap/core'
import { Pencil, Save, X } from 'lucide-react'
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
import { Markdown } from '@/components/markdown/markdown'
import { readingBody } from './body.ts'
import { docLeaveNeedsConfirmation, isDocReasonReady, isDocSaveEnabled } from './edit-state.ts'
import { LONG_TITLE } from './reading.tsx'
import {
  DOC_EDITOR_MODE_DEFAULT,
  DOC_EDITOR_MODE_KEY,
  DOC_EDITOR_MODES,
  type DocEditorMode,
} from './rich-mode.ts'
import type { DocsDoc } from './types.ts'

export type StoredDocument = { title: string; body: string; revision: string | null }

type MarkdownEditorProps = {
  value: string
  onChange: (value: string) => void
  onModSave: () => void
}

type RichEditorProps = {
  value: string
  onChange: (value: string) => void
  onReady: (editor: Editor | null) => void
  onSwitchToMarkdown: () => void
}

type Draft = { title: string; body: string }

function singleLineTitle(title: string): string {
  return title.replace(/[\r\n]+/g, ' ')
}

export function articleDraftSource(
  _pageDocument: Pick<DocsDoc, 'title' | 'body'> | null,
  storedDocument: Pick<StoredDocument, 'title' | 'body'> | undefined,
): Draft | null {
  return storedDocument ? { title: storedDocument.title, body: storedDocument.body } : null
}

function ArticleEditTitle({
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
      className="doc-title doc-editor-title"
      data-long={title.length > LONG_TITLE ? '' : undefined}
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

function ArticleEditBody({
  value,
  onChange,
  onModSave,
  mode,
  onReady,
  onSwitchToMarkdown,
}: MarkdownEditorProps & {
  mode: DocEditorMode
  onReady: (editor: Editor | null) => void
  onSwitchToMarkdown: () => void
}) {
  const [MarkdownUi, setMarkdownUi] = useState<null | ((props: MarkdownEditorProps) => ReactNode)>(
    null,
  )
  const [RichUi, setRichUi] = useState<null | ((props: RichEditorProps) => ReactNode)>(null)
  useEffect(() => {
    let live = true
    if (mode === 'markdown') {
      void import('./markdown-editor.tsx').then((mod) => {
        if (live) setMarkdownUi(() => mod.MarkdownEditor)
      })
    } else {
      void import('./rich-editor.tsx').then((mod) => {
        if (live) setRichUi(() => mod.RichEditor)
      })
    }
    return () => {
      live = false
    }
  }, [mode])
  return (
    <div className="mt-6">
      {mode === 'markdown' ? (
        MarkdownUi ? (
          <MarkdownUi value={value} onChange={onChange} onModSave={onModSave} />
        ) : (
          <div className="doc-editor-loading">{value}</div>
        )
      ) : RichUi ? (
        <RichUi
          value={value}
          onChange={onChange}
          onReady={onReady}
          onSwitchToMarkdown={onSwitchToMarkdown}
        />
      ) : (
        <Markdown content={readingBody(value)} />
      )}
    </div>
  )
}

function ArticleEditBanner({
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
    <p data-tone="error" className="text-status-text">
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

function ArticleEditActions({
  saveEnabled,
  saving,
  reason,
  onReason,
  onCancel,
  onSave,
  popoverRef,
  reasonRef,
}: {
  saveEnabled: boolean
  saving: boolean
  reason: string
  onReason: (reason: string) => void
  onCancel: () => void
  onSave: () => void
  popoverRef: RefObject<HTMLDivElement | null>
  reasonRef: RefObject<HTMLInputElement | null>
}) {
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!isDocReasonReady(reason) || saving) return
    onSave()
  }
  return (
    <>
      <Button size="sm" variant="secondary" onClick={onCancel}>
        <X size={14} />
        Cancel
      </Button>
      <Popover
        ref={popoverRef}
        label="What changed?"
        align="end"
        trigger={
          <Button variant="primary" size="sm" disabled={!saveEnabled || saving}>
            <Save size={14} />
            Save
          </Button>
        }
        onOpenChange={(open) => {
          if (open) reasonRef.current?.focus()
        }}
      >
        <form onSubmit={submit}>
          <label htmlFor="doc-edit-reason" className="grid gap-1 text-sm">
            <span className="text-text-muted">What changed?</span>
            <Input
              id="doc-edit-reason"
              ref={reasonRef}
              value={reason}
              onChange={(event) => onReason(event.target.value)}
            />
          </label>
        </form>
      </Popover>
    </>
  )
}

/**
 * The editing tools, in the place of the status line under the title: the formatting toolbar for
 * the body and the Rich | Markdown switch. It holds the line's height, so nothing below moves, and
 * stays in view under the article's header while the body scrolls.
 */
function ArticleEditBand({
  toolbar,
  mode,
  onMode,
}: {
  toolbar: ReactNode
  mode: DocEditorMode
  onMode: (mode: DocEditorMode) => void
}) {
  return (
    <div className="doc-measure -mx-1 z-[9] mt-3 flex h-control-sm items-center gap-3 bg-surface-page px-1 lg:sticky lg:top-[calc(var(--docs-stick)+var(--docs-reading-top))]">
      <div className="flex min-w-0 flex-1 items-center">{toolbar}</div>
      <Segmented
        label="Editor mode"
        size="sm"
        value={mode}
        options={[
          { value: 'rich', label: 'Rich' },
          { value: 'markdown', label: 'Markdown' },
        ]}
        onChange={(value) => {
          if (value === 'rich' || value === 'markdown') onMode(value)
        }}
      />
    </div>
  )
}

function ArticleEditOverlays({
  blocked,
  onKeep,
  onDiscard,
  confirmingReload,
  onConfirmingReload,
  onReload,
}: {
  blocked: boolean
  onKeep: () => void
  onDiscard: () => void
  confirmingReload: boolean
  onConfirmingReload: (open: boolean) => void
  onReload: () => void
}) {
  return (
    <>
      <Dialog
        open={blocked}
        onOpenChange={(open) => {
          if (!open) onKeep()
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
      <Dialog
        open={confirmingReload}
        onOpenChange={onConfirmingReload}
        title="Reload this article?"
        description="Your unsaved changes will be discarded."
        footer={
          <>
            <Button onClick={() => onConfirmingReload(false)}>Keep editing</Button>
            <Button variant="primary" onClick={onReload}>
              Reload
            </Button>
          </>
        }
      />
    </>
  )
}

function useArticleDraft(
  doc: DocsDoc | null,
  storedDocument: StoredDocument | undefined,
  editing: boolean,
) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [loaded, setLoaded] = useState<Draft>({ title: '', body: '' })
  const [session, setSession] = useState<string | null>(null)
  const allowLeave = useRef(false)
  const source = articleDraftSource(doc, storedDocument)
  // A new edit session starts from the document during render, so the first painted
  // frame of the editor already shows its title and body.
  const current = editing && doc && source ? doc.id : null
  if (current !== session) {
    setSession(current)
    if (source && current) {
      setTitle(source.title)
      setBody(source.body)
      setLoaded(source)
      allowLeave.current = false
    }
  }
  return { title, setTitle, body, setBody, loaded, setLoaded, allowLeave, ready: Boolean(current) }
}

function useReloadArticle(
  doc: DocsDoc | null,
  editing: boolean,
  fetchCurrentArticle: () => Promise<Draft | null>,
  setTitle: (title: string) => void,
  setBody: (body: string) => void,
  setLoaded: (draft: Draft) => void,
) {
  const [reason, setReason] = useState('')
  const [confirmingReload, setConfirmingReload] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: notices reset when edit starts on a document.
  useEffect(() => {
    setReason('')
    setConfirmingReload(false)
  }, [doc?.id, editing])
  const reload = useCallback(async () => {
    if (!doc) return
    setConfirmingReload(false)
    const next = await fetchCurrentArticle()
    if (next) {
      setTitle(next.title)
      setBody(next.body)
      setLoaded(next)
    }
    setReason('')
  }, [doc, fetchCurrentArticle, setTitle, setBody, setLoaded])
  return {
    reason,
    setReason,
    confirmingReload,
    setConfirmingReload,
    reload,
  }
}

function useEditorMode(editing: boolean) {
  const [mode, setMode] = useStoredState(
    DOC_EDITOR_MODE_KEY,
    DOC_EDITOR_MODE_DEFAULT,
    DOC_EDITOR_MODES,
  )
  const [richEditor, setRichEditor] = useState<Editor | null>(null)
  const [RichToolbar, setRichToolbar] = useState<null | ((props: { editor: Editor }) => ReactNode)>(
    null,
  )
  useEffect(() => {
    if (!editing || mode !== 'rich') {
      setRichEditor(null)
      return
    }
    let live = true
    void import('./rich-editor.tsx').then((mod) => {
      if (live) setRichToolbar(() => mod.RichToolbar)
    })
    return () => {
      live = false
    }
  }, [editing, mode])
  return { mode, setMode, richEditor, setRichEditor, RichToolbar }
}

function useModSaveHotkey(editing: boolean, openSave: () => void) {
  useEffect(() => {
    if (!editing) return
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 's') return
      event.preventDefault()
      openSave()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editing, openSave])
}

export function useArticleEditor({
  doc,
  editing,
  onLeave,
  storedDocument,
  saveAction,
  fetchCurrentArticle,
  onLeaveRequest,
  leaveBlocker,
}: {
  doc: DocsDoc | null
  editing: boolean
  onLeave: () => void
  storedDocument: StoredDocument | undefined
  saveAction: {
    run: (input: { title: string; body: string; reason: string }) => Promise<unknown>
    pending: boolean
    error: unknown
    refused?: string
    conflict: boolean
  }
  fetchCurrentArticle: () => Promise<Draft | null>
  onLeaveRequest: (request: () => boolean) => void
  leaveBlocker: { blocked: boolean; onKeep: () => void; onDiscard: () => void }
}) {
  const { title, setTitle, body, setBody, loaded, setLoaded, allowLeave, ready } = useArticleDraft(
    doc,
    storedDocument,
    editing,
  )
  const notice = useReloadArticle(doc, editing, fetchCurrentArticle, setTitle, setBody, setLoaded)
  const editorMode = useEditorMode(editing)
  const popoverRef = useRef<HTMLDivElement>(null)
  const reasonRef = useRef<HTMLInputElement>(null)
  const draft = { title, body }
  const saveEnabled = ready && isDocSaveEnabled(loaded, draft)
  const needsConfirmation = docLeaveNeedsConfirmation(loaded, draft)
  useEffect(
    () => onLeaveRequest(() => editing && !allowLeave.current && needsConfirmation),
    [editing, needsConfirmation, onLeaveRequest, allowLeave],
  )
  const saving = saveAction.pending
  const openSave = useCallback(() => {
    if (!saveEnabled || saving) return
    popoverRef.current?.showPopover()
  }, [saveEnabled, saving])
  useModSaveHotkey(editing, openSave)

  return {
    title,
    setTitle,
    body,
    setBody,
    ready,
    saveEnabled,
    saving,
    reason: notice.reason,
    setReason: notice.setReason,
    conflict: saveAction.conflict,
    errorMessage:
      saveAction.refused ?? (saveAction.error instanceof Error ? saveAction.error.message : null),
    popoverRef,
    reasonRef,
    openSave,
    async save() {
      if (!doc || !saveEnabled || !isDocReasonReady(notice.reason) || saving) return
      const saved = await saveAction.run({ ...draft, reason: notice.reason })
      if (!saved) return
      allowLeave.current = true
      onLeave()
    },
    leave: onLeave,
    overlays: (
      <ArticleEditOverlays
        blocked={leaveBlocker.blocked}
        onKeep={leaveBlocker.onKeep}
        onDiscard={leaveBlocker.onDiscard}
        confirmingReload={notice.confirmingReload}
        onConfirmingReload={notice.setConfirmingReload}
        onReload={() => void notice.reload()}
      />
    ),
    askReload: () => notice.setConfirmingReload(true),
    ...editorMode,
  }
}

type EditorSession = ReturnType<typeof useArticleEditor>

/** View slots the article page passes through while editing, or the Edit control when not. */
export function editorChrome(
  editor: EditorSession,
  editing: boolean,
  mayEdit: boolean,
  onEnterEdit: () => void,
  revisionBody?: ReactNode,
  viewedRevision?: { title: string; body: string } | null,
) {
  const activeEditing = editing && editor.ready
  const Toolbar = editor.RichToolbar
  return {
    editing: activeEditing,
    canManage: mayEdit,
    viewedRevision: activeEditing ? null : viewedRevision,
    bodyView: activeEditing ? (
      <ArticleEditBody
        value={editor.body}
        onChange={editor.setBody}
        onModSave={editor.openSave}
        mode={editor.mode}
        onReady={editor.setRichEditor}
        onSwitchToMarkdown={() => editor.setMode('markdown')}
      />
    ) : (
      revisionBody
    ),
    editBand: activeEditing ? (
      <ArticleEditBand
        toolbar={
          editor.mode === 'rich' && Toolbar && editor.richEditor ? (
            <Toolbar editor={editor.richEditor} />
          ) : null
        }
        mode={editor.mode}
        onMode={editor.setMode}
      />
    ) : undefined,
    banner: activeEditing ? (
      <ArticleEditBanner
        conflict={editor.conflict}
        message={editor.errorMessage}
        onReload={editor.askReload}
      />
    ) : null,
    titleView: activeEditing
      ? (headingRef: Ref<HTMLElement | null>) => (
          <ArticleEditTitle
            title={editor.title}
            onChange={editor.setTitle}
            headingRef={headingRef}
          />
        )
      : undefined,
    headerAction: activeEditing ? (
      <ArticleEditActions
        saveEnabled={editor.saveEnabled}
        saving={editor.saving}
        reason={editor.reason}
        onReason={editor.setReason}
        onCancel={editor.leave}
        onSave={editor.save}
        popoverRef={editor.popoverRef}
        reasonRef={editor.reasonRef}
      />
    ) : mayEdit ? (
      <Button size="sm" variant="secondary" onClick={onEnterEdit}>
        <Pencil size={14} />
        Edit
      </Button>
    ) : null,
  }
}
