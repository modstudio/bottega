import { Avatar } from '@bottega/hub-ui/avatar'
import { Button } from '@bottega/hub-ui/button'
import { Segmented } from '@bottega/hub-ui/segmented'
import { Bot, CircleDot, MessageSquare } from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { EditorBody } from '../document-editor/document-editor.tsx'
import { type CommentWrite, HistoryComment } from './history-comment.tsx'
import {
  type ActorCluster,
  type CommentEntry,
  groupHistory,
  type HistoryActor,
  type HistoryEntry,
  type HistoryFilter,
  type HistoryItem,
  historyKinds,
  runDuration,
  type StatusRun,
  statusPath,
} from './history-model.ts'
import { taskHistoryStyles } from './task-history.styles.ts'

/** Adding a comment: refused carries the reason the reader may not. */
export type CommentAction = {
  run: (body: string) => Promise<unknown> | unknown
  pending: boolean
  error: string | null
  refused?: string
}

export type TaskHistoryProps = {
  entries: readonly HistoryEntry[]
  comment: CommentAction
  /** Renders a run's identifier as a link to the run, when the screen has a run page. */
  renderRun?: (run: string, children: ReactNode) => ReactNode
  /** The moment day labels are measured from; defaults to now. */
  now?: Date
  /** The element id the page's contents list points at. */
  id?: string
  /** Edits a comment the reader may edit; absent where comments cannot change. */
  editComment?: CommentWrite<{ id: string; body: string }>
  /** Deletes a comment the reader may delete; absent where comments cannot change. */
  deleteComment?: CommentWrite<{ id: string }>
}

/** The reply's opening: the comment quoted, then a blank line for the answer. */
const quote = (body: string) =>
  `${body
    .trim()
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')}\n\n`

const FILTER_LABELS: Record<HistoryFilter, string> = {
  all: 'All',
  comment: 'Comments',
  status: 'Status',
  run: 'Runs',
}

const clock = (at: string) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(at))

function Composer({
  comment,
  draft,
  setDraft,
}: {
  comment: CommentAction
  /** Null while the composer is closed. */
  draft: string | null
  setDraft: (draft: string | null) => void
}) {
  const open = draft !== null
  const body = draft ?? ''
  const setOpen = (next: boolean) => setDraft(next ? '' : null)
  const setBody = (next: string) => setDraft(next)
  const [mode, setMode] = useState<'rich' | 'markdown'>('rich')
  if (comment.refused) return <p className={taskHistoryStyles().refusal()}>{comment.refused}</p>
  if (!open) {
    return (
      <button type="button" className={taskHistoryStyles().prompt()} onClick={() => setOpen(true)}>
        Add a comment
      </button>
    )
  }
  const submit = async () => {
    if (!body.trim() || comment.pending) return
    await comment.run(body)
    setDraft(null)
  }
  return (
    <div>
      <div className={taskHistoryStyles().editor()}>
        <EditorBody
          value={body}
          onChange={setBody}
          mode={mode}
          onModeChange={setMode}
          onSaveShortcut={() => void submit()}
          bodyLabel="Comment"
        />
      </div>
      {comment.error ? <p className={taskHistoryStyles().error()}>{comment.error}</p> : null}
      <div className={taskHistoryStyles().composerActions()}>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!body.trim() || comment.pending}
          onClick={() => void submit()}
        >
          {comment.pending ? 'Commenting…' : 'Comment'}
        </Button>
      </div>
    </div>
  )
}

function StatusLine({ item }: { item: StatusRun }) {
  const [open, setOpen] = useState(false)
  const path = statusPath(item.changes)
  const created = item.changes[0]?.kind === 'status' && item.changes[0].from === null
  return (
    <div>
      <div className={taskHistoryStyles().line()}>
        <span className={taskHistoryStyles().lineText()}>
          {created ? 'Created · ' : null}
          {path.map((step, index) => (
            <span key={step.key}>
              {index > 0 ? <span className={taskHistoryStyles().arrow()}> → </span> : null}
              <span className={taskHistoryStyles().strong()}>{step.status}</span>
            </span>
          ))}
        </span>
        {item.changes.length > 1 ? (
          <button
            type="button"
            className={taskHistoryStyles().toggle()}
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? 'Hide' : `${item.changes.length} changes`}
          </button>
        ) : null}
        <time className={taskHistoryStyles().time()} dateTime={item.at}>
          {clock(item.at)}
        </time>
      </div>
      {open ? (
        <div className={taskHistoryStyles().changes()}>
          {item.changes.map((change) =>
            change.kind === 'status' ? (
              <div key={change.id} className={taskHistoryStyles().line()}>
                <span className={taskHistoryStyles().lineText()}>
                  {change.from ?? 'new'} <span className={taskHistoryStyles().arrow()}>→</span>{' '}
                  {change.to}
                </span>
                <time className={taskHistoryStyles().time()} dateTime={change.at}>
                  {clock(change.at)}
                </time>
              </div>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  )
}

function Glyph({ kind }: { kind: HistoryItem['kind'] }) {
  const Icon = kind === 'comment' ? MessageSquare : kind === 'run' ? Bot : CircleDot
  return (
    <span className={taskHistoryStyles().glyph()} aria-hidden>
      <Icon size={14} />
    </span>
  )
}

type CommentControls = {
  editing: string | null
  setEditing: (id: string | null) => void
  onReply?: (body: string) => void
  editComment?: TaskHistoryProps['editComment']
  deleteComment?: TaskHistoryProps['deleteComment']
  deleted: string | null
  onDelete: (id: string) => void
}

function CommentBlock({ item, controls }: { item: CommentEntry; controls: CommentControls }) {
  const { editing, setEditing, onReply, editComment, deleteComment, deleted } = controls
  return (
    <HistoryComment
      id={item.id}
      at={item.at}
      body={item.body}
      author={item.actor?.name ?? null}
      canEdit={item.canEdit}
      canDelete={item.canDelete}
      time={clock(item.at)}
      editing={editing === item.id}
      onReply={onReply ? () => onReply(item.body) : undefined}
      onEditStart={() => setEditing(item.id)}
      onEditEnd={() => setEditing(null)}
      edit={editComment}
      onDelete={
        deleteComment && !deleteComment.refused ? () => controls.onDelete(item.id) : undefined
      }
      deleting={deleted === item.id && deleteComment?.pending}
      deleteError={deleted === item.id ? deleteComment?.error : null}
    />
  )
}

function RunLine({
  item,
  actor,
  renderRun,
}: {
  item: Extract<HistoryItem, { kind: 'run' }>
  actor: HistoryActor | null
  renderRun: TaskHistoryProps['renderRun']
}) {
  const label = item.run ? `Run #${item.run}` : 'Run'
  const duration = runDuration(item.at, item.endedAt)
  /* The cluster's name already says which agent, unless someone else is the actor. */
  const agent = item.agent && item.agent !== actor?.name ? item.agent : null
  return (
    <div className={taskHistoryStyles().line()}>
      <span className={taskHistoryStyles().lineText()}>
        <span className={taskHistoryStyles().strong()}>
          {item.run && renderRun ? renderRun(item.run, label) : label}
        </span>
        {agent ? ` · ${agent}` : ''}
        {item.job ? ` · ${item.job}` : ''}
        {item.running ? (
          <>
            {' · '}
            <span data-tone="success" className={taskHistoryStyles({ running: true }).live()} />{' '}
            running
          </>
        ) : duration ? (
          ` · ${duration}`
        ) : null}
      </span>
      <time className={taskHistoryStyles().time()} dateTime={item.at}>
        {clock(item.at)}
      </time>
    </div>
  )
}

function ClusterBlock({
  cluster,
  renderRun,
}: {
  cluster: ActorCluster
  renderRun: TaskHistoryProps['renderRun']
}) {
  return (
    <div>
      {cluster.actor ? (
        <div className={taskHistoryStyles().author()}>{cluster.actor.name}</div>
      ) : null}
      {cluster.items.map((item) => (
        <div key={`${item.kind}:${item.id}`} className={taskHistoryStyles().row()}>
          <Glyph kind={item.kind} />
          {item.kind === 'status-run' ? (
            <StatusLine item={item} />
          ) : (
            <RunLine item={item} actor={cluster.actor} renderRun={renderRun} />
          )}
        </div>
      ))}
    </div>
  )
}

/** A task's comments, status changes and runs as one newest-first feed, with a comment composer. */
export function TaskHistory({
  entries,
  comment,
  renderRun,
  now,
  id,
  editComment,
  deleteComment,
}: TaskHistoryProps) {
  const [filter, setFilter] = useState<HistoryFilter>('all')
  const [draft, setDraft] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [deleted, setDeleted] = useState<string | null>(null)
  const composer = useRef<HTMLDivElement>(null)
  const controls: CommentControls = {
    editing,
    setEditing,
    onReply: comment.refused
      ? undefined
      : (body) => {
          setDraft((current) => `${current ?? ''}${quote(body)}`)
          composer.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        },
    editComment,
    deleteComment,
    deleted,
    onDelete: (target) => {
      setDeleted(target)
      void deleteComment?.run({ id: target })
    },
  }
  const kinds = historyKinds(entries)
  const active = filter !== 'all' && !kinds.includes(filter) ? 'all' : filter
  const days = useMemo(
    () => groupHistory(entries, active, now ?? new Date()),
    [entries, active, now],
  )
  return (
    <section id={id} className={taskHistoryStyles().root()} aria-label="History">
      <div className={taskHistoryStyles().header()}>
        <h2 className={taskHistoryStyles().heading()}>History</h2>
        {kinds.length > 1 ? (
          <Segmented
            label="Show"
            size="sm"
            value={active}
            onChange={(value) => setFilter(value as HistoryFilter)}
            options={(['all', ...kinds] as const).map((value) => ({
              value,
              label: FILTER_LABELS[value],
            }))}
          />
        ) : null}
      </div>
      <div ref={composer} className={taskHistoryStyles().composer()}>
        <Composer comment={comment} draft={draft} setDraft={setDraft} />
      </div>
      {days.length ? (
        <div className={taskHistoryStyles().feed()}>
          {days.map((day) => (
            <div key={day.key} className={taskHistoryStyles().dayGroup()}>
              <div className={taskHistoryStyles().day()}>{day.label}</div>
              {day.blocks.map((block) => (
                <div key={`${block.kind}:${block.id}`} className={taskHistoryStyles().entry()}>
                  <Avatar name={block.actor?.name ?? null} kind={block.actor?.kind} />
                  {block.kind === 'comment' ? (
                    <CommentBlock item={block} controls={controls} />
                  ) : (
                    <ClusterBlock cluster={block} renderRun={renderRun} />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className={taskHistoryStyles().empty()}>Nothing has happened to this task yet.</p>
      )}
    </section>
  )
}
