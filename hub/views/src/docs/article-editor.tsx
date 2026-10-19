import { Button } from '@bottega/hub-ui/button'
import { useStoredState } from '@bottega/hub-ui/dom/use-stored-state'
import type { Editor } from '@tiptap/core'
import { Pencil } from 'lucide-react'
import { type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from 'react'
import {
  type DocumentEditorMode,
  EditableTitle,
  EditorActions,
  EditorBand,
  EditorBanner,
  EditorBody,
  LeaveConfirmationDialog,
  ReloadConfirmationDialog,
} from '../document-editor/document-editor.tsx'
import { docsBodyTransform } from './body.ts'
import { docLeaveNeedsConfirmation, isDocReasonReady, isDocSaveEnabled } from './edit-state.ts'
import type { DocsDoc } from './types.ts'

const DOC_EDITOR_MODES = ['rich', 'markdown'] as const
type DocEditorMode = DocumentEditorMode
const DOC_EDITOR_MODE_KEY = 'hub-docs-editor-mode'
const DOC_EDITOR_MODE_DEFAULT: DocEditorMode = 'rich'
const DOCS_LOCKED_FENCES = { articles: 'Article list (generated)' }

export type StoredDocument = { title: string; body: string; revision: string | null }

type Draft = { title: string; body: string }

export function articleDraftSource(
  _pageDocument: Pick<DocsDoc, 'title' | 'body'> | null,
  storedDocument: Pick<StoredDocument, 'title' | 'body'> | undefined,
): Draft | null {
  return storedDocument ? { title: storedDocument.title, body: storedDocument.body } : null
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
  const [RichToolbar, setRichToolbar] = useState<
    null | ((props: { editor: Editor; linkHint?: string }) => ReactNode)
  >(null)
  useEffect(() => {
    if (!editing || mode !== 'rich') {
      setRichEditor(null)
      return
    }
    let live = true
    void import('../document-editor/rich-toolbar.tsx').then((mod) => {
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
      <>
        <LeaveConfirmationDialog
          open={leaveBlocker.blocked}
          onKeep={leaveBlocker.onKeep}
          onDiscard={leaveBlocker.onDiscard}
          subject="article"
        />
        <ReloadConfirmationDialog
          open={notice.confirmingReload}
          onOpenChange={notice.setConfirmingReload}
          onReload={() => void notice.reload()}
          subject="article"
        />
      </>
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
      <EditorBody
        value={editor.body}
        onChange={editor.setBody}
        mode={editor.mode}
        onModeChange={editor.setMode}
        onSaveShortcut={editor.openSave}
        onRichEditorChange={editor.setRichEditor}
        bodyLabel="Article body"
        bodyTransform={docsBodyTransform}
        lockedFences={DOCS_LOCKED_FENCES}
      />
    ) : (
      revisionBody
    ),
    editBand: activeEditing ? (
      <EditorBand
        toolbar={
          editor.mode === 'rich' && Toolbar && editor.richEditor ? (
            <Toolbar editor={editor.richEditor} linkHint="URL or article slug" />
          ) : null
        }
        mode={editor.mode}
        onModeChange={editor.setMode}
      />
    ) : undefined,
    banner: activeEditing ? (
      <EditorBanner
        conflict={editor.conflict}
        message={editor.errorMessage}
        onReload={editor.askReload}
        subject="article"
      />
    ) : null,
    titleView: activeEditing
      ? (headingRef: Ref<HTMLElement | null>) => (
          <EditableTitle title={editor.title} onChange={editor.setTitle} headingRef={headingRef} />
        )
      : undefined,
    headerAction: activeEditing ? (
      <EditorActions
        saveEnabled={editor.saveEnabled}
        saving={editor.saving}
        reason={{ value: editor.reason, onChange: editor.setReason, required: true }}
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
