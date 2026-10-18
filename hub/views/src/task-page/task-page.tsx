import { Button, IconButton } from '@bottega/hub-ui/button'
import type { Editor } from '@tiptap/core'
import { Pencil, X } from 'lucide-react'
import { type ReactNode, type Ref, useEffect, useState } from 'react'
import {
  type DocumentEditorMode,
  EditableTitle,
  EditorActions,
  EditorBand,
  EditorBanner,
  EditorBody,
  LeaveConfirmationDialog,
} from '../document-editor/document-editor.tsx'
import { DocumentSurface, DocumentTitle } from '../document-surface/document-surface.tsx'
import { KeyLine } from '../key-line/key-line.tsx'
import { Markdown } from '../markdown/markdown.tsx'
import { taskPageStyles } from './task-page.styles.ts'
import { NarrowFacts, type TaskPageDoc, type TaskPageFact, TaskRail } from './task-rail.tsx'

/** Saving the task's title and description together; refused when the tracker will not take it. */
export type TaskPageSave = {
  run: (draft: { title: string; body: string }) => Promise<boolean>
  pending: boolean
  error: string | null
  refused?: string
  conflict: boolean
  /** Fetches the stored task afresh; the draft restarts from what it returns. */
  reload: () => Promise<{ title: string; body: string }>
}

type RichToolbarView = (props: { editor: Editor; linkHint?: string }) => ReactNode

function useRichToolbar(active: boolean) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [Toolbar, setToolbar] = useState<RichToolbarView | null>(null)
  useEffect(() => {
    if (!active) return
    let live = true
    void import('../document-editor/rich-toolbar.tsx').then((module) => {
      if (live) setToolbar(() => module.RichToolbar)
    })
    return () => {
      live = false
    }
  }, [active])
  return {
    setEditor,
    toolbar: active && Toolbar && editor ? <Toolbar editor={editor} linkHint="URL" /> : null,
  }
}

function useDraft(title: string, body: string) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ title, body })
  const [mode, setMode] = useState<DocumentEditorMode>('rich')
  const [leaving, setLeaving] = useState<(() => void) | null>(null)
  const rich = useRichToolbar(editing && mode === 'rich')
  const changed = editing && (draft.title.trim() !== title.trim() || draft.body !== body)
  return {
    editing,
    draft,
    mode,
    setMode,
    rich,
    changed,
    setTitle: (next: string) => setDraft((current) => ({ ...current, title: next })),
    setBody: (next: string) => setDraft((current) => ({ ...current, body: next })),
    start(from: { title: string; body: string } = { title, body }) {
      setDraft(from)
      setEditing(true)
    },
    stop: () => setEditing(false),
    /** Leaves the edit, asking first when there is something to lose. */
    leave(then: () => void = () => {}) {
      const go = () => {
        setEditing(false)
        then()
      }
      if (changed) setLeaving(() => go)
      else go()
    },
    leaving,
    keep: () => setLeaving(null),
    discard() {
      leaving?.()
      setLeaving(null)
    },
  }
}

type Draft = ReturnType<typeof useDraft>

/**
 * Escape belongs to the editor while editing, so it never closes the page over a draft. The
 * page's dialog raises cancel only once nothing above it, such as a toolbar popover, took Escape.
 */
function useEscapeLeaves(root: HTMLElement | null, editing: boolean, leave: () => void) {
  useEffect(() => {
    const dialog = root?.closest('dialog')
    if (!dialog || !editing) return
    const onCancel = (event: Event) => {
      event.preventDefault()
      leave()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => dialog.removeEventListener('cancel', onCancel)
  }, [root, editing, leave])
}

function HeaderActions({
  edit,
  editing,
  canEdit,
  save,
  onClose,
}: {
  edit: Draft
  editing: boolean
  canEdit: boolean
  save: TaskPageSave
  onClose: () => void
}) {
  return (
    <>
      {editing ? (
        <EditorActions
          saveEnabled={edit.changed && Boolean(edit.draft.title.trim())}
          saving={save.pending}
          onCancel={() => edit.leave()}
          onSave={() =>
            void save.run(edit.draft).then((saved) => {
              if (saved) edit.stop()
            })
          }
        />
      ) : canEdit ? (
        <Button size="sm" variant="secondary" onClick={() => edit.start()}>
          <Pencil size={14} />
          Edit
        </Button>
      ) : null}
      <IconButton size="sm" label="Close task" onClick={() => edit.leave(onClose)}>
        <X />
      </IconButton>
    </>
  )
}

function ReadingBody({ body }: { body: string }) {
  return body.trim() ? (
    <div className={taskPageStyles().description()}>
      <Markdown content={body} />
    </div>
  ) : (
    <p className={taskPageStyles().empty()}>No description.</p>
  )
}

function EditingBody({ edit }: { edit: Draft }) {
  return (
    <EditorBody
      value={edit.draft.body}
      onChange={edit.setBody}
      mode={edit.mode}
      onModeChange={edit.setMode}
      onSaveShortcut={() => {}}
      onRichEditorChange={edit.rich.setEditor}
      bodyLabel="Task description"
    />
  )
}

export function TaskPage({
  crumbs,
  title,
  body,
  keyLine,
  details,
  detailsExtra,
  docs,
  openDoc,
  onOpenDoc,
  history,
  save,
  onClose,
}: {
  crumbs: { key: string; label: ReactNode }[]
  title: string
  body: string
  keyLine: { key: string; icon?: ReactNode; content: ReactNode }[]
  details: TaskPageFact[]
  /** Shown under the details, such as the task's measures. */
  detailsExtra?: ReactNode
  docs: TaskPageDoc[]
  /** The task document shown in place of the task, chosen by the screen. */
  openDoc: string | null
  onOpenDoc: (id: string | null) => void
  history: ReactNode
  save: TaskPageSave
  onClose: () => void
}) {
  const doc = docs.find((candidate) => candidate.id === openDoc) ?? null
  const edit = useDraft(title, body)
  const editing = edit.editing && !doc
  const shownTitle = doc ? doc.title : title
  const openOther = (id: string | null) => edit.leave(() => onOpenDoc(id))
  const rail = { doc, docs, details, detailsExtra, onOpenDoc: openOther }
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  useEscapeLeaves(root, editing, edit.leave)
  return (
    <div ref={setRoot} className={taskPageStyles().root()}>
      <div className={taskPageStyles().grid()}>
        <DocumentSurface
          crumbs={doc ? [...crumbs, { key: `doc:${doc.id}`, label: doc.label }] : crumbs}
          title={shownTitle}
          heading={(ref: Ref<HTMLElement | null>) =>
            editing ? (
              <EditableTitle title={edit.draft.title} onChange={edit.setTitle} headingRef={ref} />
            ) : (
              <DocumentTitle title={shownTitle} ref={ref} />
            )
          }
          keyLine={
            editing ? (
              <EditorBand
                toolbar={edit.rich.toolbar}
                mode={edit.mode}
                onModeChange={edit.setMode}
              />
            ) : (
              <KeyLine items={doc ? doc.keyLine : keyLine} />
            )
          }
          banner={
            editing ? (
              <EditorBanner
                conflict={save.conflict}
                message={save.error}
                onReload={() => void save.reload().then((fresh) => edit.start(fresh))}
                subject="task"
              />
            ) : null
          }
          headerActions={
            <HeaderActions
              edit={edit}
              editing={editing}
              canEdit={!doc && !save.refused}
              save={save}
              onClose={onClose}
            />
          }
          body={
            <>
              <NarrowFacts {...rail} />
              {editing ? <EditingBody edit={edit} /> : <ReadingBody body={doc ? doc.body : body} />}
            </>
          }
          footer={doc ? null : <section className={taskPageStyles().history()}>{history}</section>}
        />
        <TaskRail {...rail} body={body} />
      </div>
      <LeaveConfirmationDialog
        open={edit.leaving !== null}
        onKeep={edit.keep}
        onDiscard={edit.discard}
        subject="task"
      />
    </div>
  )
}
