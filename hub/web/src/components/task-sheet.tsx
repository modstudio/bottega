import { useQuery } from '@tanstack/react-query'
import { Badge } from './badge'
import { DisplayRow, FieldSection } from './fields'
import { Markdown } from './markdown'
import { Sheet } from './sheet'
import { relativeTime } from '@/lib/format'
import { trpc } from '@/trpc/client'

export function TaskSheet({ taskKey, onClose }: { taskKey: string; onClose: () => void }) {
  const record = useQuery(trpc.work.task.queryOptions({ key: taskKey }))
  return <Sheet open onClose={onClose} title={record.data?.task.key ?? taskKey} subtitle={record.data?.task.title ?? 'Loading task...'}>
    {record.error ? <p className="text-destructive">{record.error.message}</p> : null}
    {record.data ? <>
      <DisplayRow label="Project" value={record.data.project?.name ?? record.data.task.project} />
      <DisplayRow label="Source" value={<Badge variant="outline">{record.data.source}</Badge>} />
      <DisplayRow label="Status" value={record.data.task.status ?? 'unknown'} />
      <DisplayRow label="Assignee" value={record.data.task.assignee ?? 'unassigned'} />
      <DisplayRow label="Parent" value={record.data.task.parent_key ?? '-'} />
      <DisplayRow label="Updated" value={record.data.task.updated_at ? relativeTime(record.data.task.updated_at) : '-'} />
      <div className="mt-6 space-y-6">
        <FieldSection title="Documents">
          {record.data.documents.length ? record.data.documents.map((document) => <article key={document.id} className="mb-5 border border-border p-3"><div className="mb-3 flex items-center gap-2"><strong>{document.title}</strong>{document.role ? <Badge variant="info">{document.role}</Badge> : null}</div><Markdown content={document.body} /></article>) : <p className="text-muted-foreground">No documents.</p>}
        </FieldSection>
        {record.data.task.body ? <FieldSection title="Description"><Markdown content={record.data.task.body} /></FieldSection> : null}
        <FieldSection title="Comments">
          {record.data.comments.length ? record.data.comments.map((comment) => <article key={comment.id} className="border-b border-border py-3"><Markdown content={comment.body} /><div className="mt-2 text-[11px] text-muted-foreground">{relativeTime(comment.created_at)}</div></article>) : <p className="text-muted-foreground">No comments.</p>}
        </FieldSection>
        <FieldSection title="Runs">
          {record.data.runs.length ? record.data.runs.map((run) => <div key={`${run.id}:${run.agent}:${run.started_at}`} className="grid grid-cols-[4rem_1fr_auto] gap-3 border-b border-border py-2"><strong>#{run.id}</strong><span>{run.agent ?? '-'} · {run.job ?? '-'}</span><span className={run.running ? 'text-live' : 'text-muted-foreground'}>{run.running ? 'running' : relativeTime(run.ended_at)}</span></div>) : <p className="text-muted-foreground">No delegated runs.</p>}
        </FieldSection>
      </div>
    </> : null}
  </Sheet>
}
