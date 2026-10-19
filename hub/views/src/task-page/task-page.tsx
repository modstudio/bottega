import { Button, IconButton } from '@bottega/hub-ui/button'
import { useMediaQuery } from '@bottega/hub-ui/dom/use-media-query'
import { Tabs } from '@bottega/hub-ui/tabs'
import type { Editor } from '@tiptap/core'
import { ArrowLeft, Pencil, X } from 'lucide-react'
import { type ReactNode, type Ref, useEffect, useId, useState } from 'react'
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
import {
  TaskContents,
  TaskFacts,
  type TaskPageDoc,
  type TaskPageFact,
  TaskRail,
} from './task-rail.tsx'

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

/** At this width the rail sits beside the page; below it, the rail's tabs join the page's. */
const RAIL_QUERY = '(min-width: 64rem)'

type PhoneTab = 'task' | 'contents' | 'details'

type TaskPageProps = {
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
}

/** The parts of the page every layout shares, built once for the current task or document. */
function usePageParts(props: TaskPageProps) {
  const { docs, openDoc, title, body, keyLine, save, onOpenDoc, onClose } = props
  const doc = docs.find((candidate) => candidate.id === openDoc) ?? null
  const edit = useDraft(title, body)
  const editing = edit.editing && !doc
  const shownTitle = doc ? doc.title : title
  return {
    doc,
    edit,
    editing,
    shownTitle,
    heading: (ref: Ref<HTMLElement | null>) =>
      editing ? (
        <EditableTitle title={edit.draft.title} onChange={edit.setTitle} headingRef={ref} />
      ) : (
        <DocumentTitle title={shownTitle} ref={ref} />
      ),
    keyLine: editing ? (
      <EditorBand toolbar={edit.rich.toolbar} mode={edit.mode} onModeChange={edit.setMode} />
    ) : (
      <KeyLine items={doc ? doc.keyLine : keyLine} />
    ),
    editorBanner: editing ? (
      <EditorBanner
        conflict={save.conflict}
        message={save.error}
        onReload={() => void save.reload().then((fresh) => edit.start(fresh))}
        subject="task"
      />
    ) : null,
    headerActions: (
      <HeaderActions
        edit={edit}
        editing={editing}
        canEdit={!doc && !save.refused}
        save={save}
        onClose={onClose}
      />
    ),
    main: editing ? <EditingBody edit={edit} /> : <ReadingBody body={doc ? doc.body : body} />,
    history: doc ? null : <section className={taskPageStyles().history()}>{props.history}</section>,
    openOther: (id: string | null) => edit.leave(() => onOpenDoc(id)),
  }
}

type PageParts = ReturnType<typeof usePageParts>

/** On a phone the task, its contents and its details are three tabs of one page. */
function usePhoneTabs({
  parts,
  props,
  tab,
  onTab,
}: {
  parts: PageParts
  props: TaskPageProps
  tab: PhoneTab
  onTab: (tab: PhoneTab) => void
}) {
  const id = useId()
  const { doc } = parts
  const toSection = (section: string) => {
    onTab('task')
    // The section exists again once the task tab has rendered.
    requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView())
  }
  return {
    bar: (
      <div className={taskPageStyles().phoneTabs()}>
        <Tabs
          id={id}
          label={doc ? 'Document' : 'Task'}
          value={tab}
          onChange={(value) => onTab(value as PhoneTab)}
          items={[
            { value: 'task', label: doc ? 'Document' : 'Task' },
            { value: 'contents', label: 'Contents' },
            { value: 'details', label: 'Details' },
          ]}
        />
      </div>
    ),
    panel: (children: ReactNode) => (
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`}>
        {children}
      </div>
    ),
    contents: (
      <TaskContents
        body={doc ? doc.body : props.body}
        docs={props.docs}
        current={doc?.id}
        onOpenDoc={(next) => {
          onTab('task')
          parts.openOther(next)
        }}
        onHeading={toSection}
      />
    ),
    details: doc ? (
      <TaskFacts facts={doc.facts} />
    ) : (
      <TaskFacts facts={props.details} extra={props.detailsExtra} />
    ),
  }
}

function PhonePage({ parts, props }: { parts: PageParts; props: TaskPageProps }) {
  const [tab, setTab] = useState<PhoneTab>('task')
  const tabs = usePhoneTabs({ parts, props, tab, onTab: setTab })
  const { doc } = parts
  const onTask = tab === 'task'
  return (
    <DocumentSurface
      crumbs={doc ? [...props.crumbs, { key: `doc:${doc.id}`, label: doc.label }] : props.crumbs}
      title={parts.shownTitle}
      heading={() => tabs.bar}
      headerActions={parts.headerActions}
      body={tabs.panel(
        onTask ? (
          <>
            {doc ? (
              <button
                type="button"
                className={taskPageStyles().back()}
                onClick={() => parts.openOther(null)}
              >
                <ArrowLeft size={14} />
                Back to task
              </button>
            ) : null}
            {parts.editorBanner}
            {parts.heading(() => {})}
            {parts.keyLine}
            {parts.main}
            {parts.history}
          </>
        ) : (
          <div className={taskPageStyles().phonePanel()}>
            {tab === 'contents' ? tabs.contents : tabs.details}
          </div>
        ),
      )}
    />
  )
}

export function TaskPage(props: TaskPageProps) {
  const parts = usePageParts(props)
  const wide = useMediaQuery(RAIL_QUERY)
  const rail = {
    doc: parts.doc,
    docs: props.docs,
    details: props.details,
    detailsExtra: props.detailsExtra,
    onOpenDoc: parts.openOther,
  }
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  useEscapeLeaves(root, parts.editing, parts.edit.leave)
  return (
    <div ref={setRoot} className={taskPageStyles().root()}>
      <div className={taskPageStyles().grid()}>
        {wide ? (
          <DocumentSurface
            crumbs={
              parts.doc
                ? [...props.crumbs, { key: `doc:${parts.doc.id}`, label: parts.doc.label }]
                : props.crumbs
            }
            title={parts.shownTitle}
            heading={parts.heading}
            keyLine={parts.keyLine}
            banner={parts.editorBanner}
            headerActions={parts.headerActions}
            body={parts.main}
            footer={parts.history}
          />
        ) : (
          <PhonePage parts={parts} props={props} />
        )}
        {wide ? <TaskRail {...rail} body={props.body} /> : null}
      </div>
      <LeaveConfirmationDialog
        open={parts.edit.leaving !== null}
        onKeep={parts.edit.keep}
        onDiscard={parts.edit.discard}
        subject="task"
      />
    </div>
  )
}
