import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/badge'
import { DisplayRow } from '@/components/fields'
import { Markdown } from '@/components/markdown'
import { Sheet } from '@/components/sheet'
import { BoardView, TaskView } from '@/components/work-view'
import { relativeTime } from '@/lib/format'
import { trpc } from '@/trpc/client'

type From = 'flight' | 'done' | 'board'

export const Route = createFileRoute('/tasks/$key')({
  validateSearch: (search: Record<string, unknown>) => ({
    from: search.from === 'done' || search.from === 'board' ? search.from : 'flight' as From,
  }),
  component: TaskRecordPage,
})

function TaskRecordPage() {
  const { key } = Route.useParams()
  const { from } = Route.useSearch()
  const navigate = useNavigate()
  const record = useQuery(trpc.work.task.queryOptions({ key }))
  const close = async () => {
    await navigate({ to: `/${from}` as '/flight' | '/done' | '/board' })
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-record-key="${CSS.escape(key)}"]`)?.focus()
    })
  }
  return <>
    {from === 'board' ? <BoardView /> : <TaskView name={from} />}
    <Sheet open onClose={close} title={record.data?.task.key ?? key} subtitle={record.data?.task.title ?? 'Loading task...'}>
      {record.error ? <p className="text-destructive">{record.error.message}</p> : null}
      {record.data ? <>
        <DisplayRow label="Project" value={record.data.project?.name ?? record.data.task.project} />
        <DisplayRow label="Source" value={<Badge variant="outline">{record.data.source}</Badge>} />
        <DisplayRow label="Status" value={record.data.task.status ?? 'unknown'} />
        <DisplayRow label="Assignee" value={record.data.task.assignee ?? 'unassigned'} />
        <DisplayRow label="Parent" value={record.data.task.parent_key ?? '-'} />
        <DisplayRow label="Updated" value={record.data.task.updated_at ? relativeTime(record.data.task.updated_at) : '-'} />
        <section className="mt-6"><h2 className="mb-2 font-sans text-[15px] font-semibold">Documents</h2>
          {record.data.documents.length ? record.data.documents.map((document) => <article key={document.id} className="mb-5 border border-border p-3"><div className="mb-3 flex items-center gap-2"><strong>{document.title}</strong>{document.role ? <Badge variant="info">{document.role}</Badge> : null}</div><Markdown content={document.body} /></article>) : <p className="text-muted-foreground">No documents.</p>}
        </section>
        {record.data.task.body ? <section className="mt-5"><h2 className="mb-2 font-sans text-[15px] font-semibold">Description</h2><Markdown content={record.data.task.body} /></section> : null}
        <section className="mt-6"><h2 className="mb-2 font-sans text-[15px] font-semibold">Comments</h2>
          {record.data.comments.length ? record.data.comments.map((comment) => <article key={comment.id} className="border-b border-border py-3"><Markdown content={comment.body} /><div className="mt-2 text-[11px] text-muted-foreground">{relativeTime(comment.created_at)}</div></article>) : <p className="text-muted-foreground">No comments.</p>}
        </section>
        <section className="mt-6"><h2 className="mb-2 font-sans text-[15px] font-semibold">Runs</h2>
          {record.data.runs.length ? record.data.runs.map((run) => <div key={`${run.id}:${run.agent}:${run.started_at}`} className="grid grid-cols-[4rem_1fr_auto] gap-3 border-b border-border py-2"><strong>#{run.id}</strong><span>{run.agent ?? '-'} · {run.job ?? '-'}</span><span className={run.running ? 'text-live' : 'text-muted-foreground'}>{run.running ? 'running' : relativeTime(run.ended_at)}</span></div>) : <p className="text-muted-foreground">No delegated runs.</p>}
        </section>
      </> : null}
    </Sheet>
  </>
}
