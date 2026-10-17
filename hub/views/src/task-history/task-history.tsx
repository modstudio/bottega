import { Button } from '@bottega/hub-ui/button'
import { Segmented } from '@bottega/hub-ui/segmented'
import { Bot, CircleDot, MessageSquare } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { EditorBody } from '../document-editor/document-editor.tsx'
import { Markdown } from '../markdown/markdown.tsx'
import {
  groupHistory,
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
}

const FILTER_LABELS: Record<HistoryFilter, string> = {
  all: 'All',
  comment: 'Comments',
  status: 'Status',
  run: 'Runs',
}

const clock = (at: string) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(at))

function Composer({ comment }: { comment: CommentAction }) {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
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
    setBody('')
    setOpen(false)
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

function Item({
  item,
  renderRun,
}: {
  item: HistoryItem
  renderRun: TaskHistoryProps['renderRun']
}) {
  if (item.kind === 'status-run') return <StatusLine item={item} />
  if (item.kind === 'comment') {
    return (
      <>
        <div className={taskHistoryStyles().line()}>
          <span className={taskHistoryStyles().lineText()}>Comment</span>
          <time className={taskHistoryStyles().time()} dateTime={item.at}>
            {clock(item.at)}
          </time>
        </div>
        <div className={taskHistoryStyles().commentBody()}>
          <Markdown content={item.body} />
        </div>
      </>
    )
  }
  const label = item.run ? `Run #${item.run}` : 'Run'
  const duration = runDuration(item.at, item.endedAt)
  return (
    <div className={taskHistoryStyles().line()}>
      <span className={taskHistoryStyles().lineText()}>
        <span className={taskHistoryStyles().strong()}>
          {item.run && renderRun ? renderRun(item.run, label) : label}
        </span>
        {item.agent ? ` · ${item.agent}` : ''}
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

/** A task's comments, status changes and runs as one newest-first feed, with a comment composer. */
export function TaskHistory({ entries, comment, renderRun, now, id }: TaskHistoryProps) {
  const [filter, setFilter] = useState<HistoryFilter>('all')
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
      <div className={taskHistoryStyles().composer()}>
        <Composer comment={comment} />
      </div>
      {days.length ? (
        <div className={taskHistoryStyles().feed()}>
          {days.map((day) => (
            <div key={day.key} className={taskHistoryStyles().dayGroup()}>
              <div className={taskHistoryStyles().day()}>{day.label}</div>
              {day.items.map((item) => (
                <div key={`${item.kind}:${item.id}`} className={taskHistoryStyles().entry()}>
                  <Glyph kind={item.kind} />
                  <div>
                    <Item item={item} renderRun={renderRun} />
                  </div>
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
