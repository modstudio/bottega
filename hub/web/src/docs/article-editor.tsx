import { useMutation } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import { TRPCClientError } from '@trpc/client'
import { Pencil, Save, X } from 'lucide-react'
import {
  type FormEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { queryClient, trpc } from '@/trpc/client'
import { Button, TextButton } from '@/ui/button/button'
import { Dialog } from '@/ui/dialog/dialog'
import { Input } from '@/ui/field/input'
import { Popover } from '@/ui/popover/popover'
import type { DocScope } from '../../../../shared/docs.ts'
import { docLeaveNeedsConfirmation, isDocReasonReady, isDocSaveEnabled } from './edit-state.ts'
import { LONG_TITLE } from './reading.tsx'
import { isScope } from './scope.ts'
import type { DocsDoc, DocsSource } from './types.ts'
import { type StoredDocument, useStoredDocument } from './use-docs.ts'

function isConflictError(error: unknown): boolean {
  return error instanceof TRPCClientError && error.data?.code === 'CONFLICT'
}

type MarkdownEditorProps = {
  value: string
  onChange: (value: string) => void
  onModSave: () => void
}

type Draft = { title: string; body: string }

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
  return (
    <input
      ref={headingRef as Ref<HTMLInputElement>}
      className="doc-title doc-editor-title"
      data-long={title.length > LONG_TITLE ? '' : undefined}
      value={title}
      onChange={(event) => onChange(event.target.value)}
      aria-label="Title"
    />
  )
}

function ArticleEditBody({ value, onChange, onModSave }: MarkdownEditorProps) {
  const [Editor, setEditor] = useState<null | ((props: MarkdownEditorProps) => ReactNode)>(null)
  useEffect(() => {
    let live = true
    void import('./markdown-editor.tsx').then((mod) => {
      if (live) setEditor(() => mod.MarkdownEditor)
    })
    return () => {
      live = false
    }
  }, [])
  return (
    <div className="mt-6">
      {Editor ? (
        <Editor value={value} onChange={onChange} onModSave={onModSave} />
      ) : (
        // Holds the editor's place, in its own type, while its code loads.
        <div className="doc-editor-loading">{value}</div>
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

function useArticleLeave(editing: boolean, needsConfirm: boolean, allowLeave: RefObject<boolean>) {
  const shouldBlockFn = useCallback(() => {
    if (allowLeave.current) return false
    return needsConfirm
  }, [needsConfirm, allowLeave])
  return useBlocker({
    shouldBlockFn,
    enableBeforeUnload: () => needsConfirm,
    withResolver: true,
    disabled: !editing,
  })
}

function writeArticle(
  source: DocsSource,
  doc: DocsDoc,
  draft: Draft,
  reason: string,
  expectedRevision: string | null | undefined,
  saveLocal: (input: {
    scope: DocScope
    subject: string | null
    slug: string
    title: string
    body: string
    reason: string
    expectedRevision?: string
  }) => void,
  saveHosted: (input: {
    spaceId: string
    scope: string
    subject: string | null
    slug: string
    title: string
    body: string
    reason: string
    expectedRevision: string
  }) => void,
) {
  const trimmed = reason.trim()
  if (source === 'hosted') {
    if (!doc.spaceId || !expectedRevision) return
    saveHosted({
      spaceId: doc.spaceId,
      scope: doc.scope,
      subject: doc.subject,
      slug: doc.slug,
      title: draft.title,
      body: draft.body,
      reason: trimmed,
      expectedRevision,
    })
    return
  }
  if (!isScope(doc.scope)) return
  saveLocal({
    scope: doc.scope,
    subject: doc.subject,
    slug: doc.slug,
    title: draft.title,
    body: draft.body,
    reason: trimmed,
    expectedRevision: expectedRevision ?? undefined,
  })
}

async function fetchCurrentArticle(source: DocsSource, doc: DocsDoc): Promise<Draft | null> {
  if (source === 'hosted') {
    // A conflict means the cached copy is out of date, so both reads go to the server.
    const next = await queryClient.fetchQuery({
      ...trpc.record.doc.queryOptions({ id: doc.id }),
      staleTime: 0,
    })
    return { title: next.title, body: next.body }
  }
  if (!isScope(doc.scope)) return null
  const next = await queryClient.fetchQuery({
    ...trpc.doc.get.queryOptions({
      scope: doc.scope,
      subject: doc.subject,
      slug: doc.slug,
    }),
    staleTime: 0,
  })
  return { title: next.title, body: next.body }
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
  source: DocsSource,
  editing: boolean,
  setTitle: (title: string) => void,
  setBody: (body: string) => void,
  setLoaded: (draft: Draft) => void,
) {
  const [reason, setReason] = useState('')
  const [conflict, setConflict] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [confirmingReload, setConfirmingReload] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: notices reset when edit starts on a document.
  useEffect(() => {
    setReason('')
    setConflict(false)
    setErrorMessage(null)
    setConfirmingReload(false)
  }, [doc?.id, editing])
  const reload = useCallback(async () => {
    if (!doc) return
    setConfirmingReload(false)
    const next = await fetchCurrentArticle(source, doc)
    if (next) {
      setTitle(next.title)
      setBody(next.body)
      setLoaded(next)
    }
    await queryClient.invalidateQueries()
    setConflict(false)
    setErrorMessage(null)
    setReason('')
  }, [doc, source, setTitle, setBody, setLoaded])
  return {
    reason,
    setReason,
    conflict,
    setConflict,
    errorMessage,
    setErrorMessage,
    confirmingReload,
    setConfirmingReload,
    reload,
  }
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
  source,
  editing,
  onLeave,
}: {
  doc: DocsDoc | null
  source: DocsSource
  editing: boolean
  onLeave: () => void
}) {
  const storedDocument = useStoredDocument(doc, source, editing)
  const { title, setTitle, body, setBody, loaded, setLoaded, allowLeave, ready } = useArticleDraft(
    doc,
    storedDocument,
    editing,
  )
  const notice = useReloadArticle(doc, source, editing, setTitle, setBody, setLoaded)
  const popoverRef = useRef<HTMLDivElement>(null)
  const reasonRef = useRef<HTMLInputElement>(null)
  const expectedRevision = storedDocument?.revision
  const draft = { title, body }
  const saveEnabled = ready && isDocSaveEnabled(loaded, draft)
  const blocker = useArticleLeave(editing, docLeaveNeedsConfirmation(loaded, draft), allowLeave)

  function failed(error: unknown) {
    if (isConflictError(error)) {
      notice.setConflict(true)
      notice.setErrorMessage(null)
      return
    }
    notice.setConflict(false)
    notice.setErrorMessage(error instanceof Error ? error.message : String(error))
  }

  async function saved() {
    allowLeave.current = true
    await queryClient.invalidateQueries()
    onLeave()
  }

  const localSave = useMutation({
    ...trpc.doc.set.mutationOptions(),
    onSuccess: saved,
    onError: failed,
  })
  const hostedSave = useMutation({
    ...trpc.record.saveDoc.mutationOptions(),
    onSuccess: saved,
    onError: failed,
  })
  const saving = source === 'hosted' ? hostedSave.isPending : localSave.isPending
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
    conflict: notice.conflict,
    errorMessage: notice.errorMessage,
    popoverRef,
    reasonRef,
    openSave,
    save() {
      if (!doc || !saveEnabled || !isDocReasonReady(notice.reason) || saving) return
      notice.setConflict(false)
      notice.setErrorMessage(null)
      writeArticle(
        source,
        doc,
        draft,
        notice.reason,
        expectedRevision,
        (input) => localSave.mutate(input),
        (input) => hostedSave.mutate(input),
      )
    },
    leave: onLeave,
    overlays: (
      <ArticleEditOverlays
        blocked={blocker.status === 'blocked'}
        onKeep={() => blocker.reset?.()}
        onDiscard={() => blocker.proceed?.()}
        confirmingReload={notice.confirmingReload}
        onConfirmingReload={notice.setConfirmingReload}
        onReload={() => void notice.reload()}
      />
    ),
    askReload: () => notice.setConfirmingReload(true),
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
  return {
    editing: activeEditing,
    canManage: mayEdit,
    viewedRevision: activeEditing ? null : viewedRevision,
    bodyView: activeEditing ? (
      <ArticleEditBody value={editor.body} onChange={editor.setBody} onModSave={editor.openSave} />
    ) : (
      revisionBody
    ),
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
