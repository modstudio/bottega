import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Badge } from './badge'
import { Button } from './button'
import { ProjectMark, SourceMark } from './design-system'
import { DisplayRow, FieldSection, SettingBlock } from './fields'
import { Input } from './input'
import { Markdown } from './markdown'
import { Select } from './select'
import { Sheet } from './sheet'
import { Textarea } from './textarea'
import { relativeTime } from '@/lib/format'
import { queryClient, trpc, type TaskRecordResponse } from '@/trpc/client'

const statuses = ['open', 'active', 'review', 'done', 'dropped'] as const

function reasonRows(capabilities: TaskRecordResponse['capabilities']) {
  const entries = [
    ['Create task', 'create'],
    ['Change status', 'setStatus'],
    ['Edit title', 'setTitle'],
    ['Add comment', 'comment'],
    ['Edit documents', 'documents'],
  ] as const
  return entries.flatMap(([label, name]) => capabilities[name] ? [] : [
    <DisplayRow key={name} label={label} value={capabilities.reasons[name] ?? 'Unavailable'} />,
  ])
}

function DocumentEditor({ document }: { document: TaskRecordResponse['documents'][number] }) {
  const [title, setTitle] = useState(document.title)
  const [body, setBody] = useState(document.body)
  useEffect(() => {
    setTitle(document.title)
    setBody(document.body)
  }, [document.id, document.version])
  const save = useMutation({
    ...trpc.work.setDocument.mutationOptions(),
    onSuccess: async () => { await queryClient.invalidateQueries() },
  })
  return <article className="space-y-3 border border-border p-3">
    <div className="flex items-center gap-2">{document.role ? <Badge variant="info">{document.role}</Badge> : null}<span className="text-[11px] text-muted-foreground">version {document.version}</span></div>
    <Input aria-label={`Title for document ${document.id}`} value={title} onChange={(event) => setTitle(event.target.value)} />
    <Textarea className="min-h-48" aria-label={`Body for document ${document.id}`} value={body} onChange={(event) => setBody(event.target.value)} />
    {save.error ? <p className="text-destructive">{save.error.message}</p> : null}
    <Button size="sm" disabled={save.isPending || !title.trim()} onClick={() => save.mutate({ id: document.id, title, body, version: document.version })}>{save.isPending ? 'Saving...' : 'Save document'}</Button>
  </article>
}

export function TaskSheet({ taskKey, onClose }: { taskKey: string; onClose: () => void }) {
  const record = useQuery(trpc.work.task.queryOptions({ key: taskKey }))
  const [title, setTitle] = useState('')
  const [comment, setComment] = useState('')
  useEffect(() => { if (record.data) setTitle(record.data.task.title ?? '') }, [record.data?.task.title])
  const refresh = async () => { await queryClient.invalidateQueries() }
  const saveTitle = useMutation({ ...trpc.work.setTitle.mutationOptions(), onSuccess: refresh })
  const saveStatus = useMutation({ ...trpc.work.setStatus.mutationOptions(), onSuccess: refresh })
  const addComment = useMutation({
    ...trpc.work.comment.mutationOptions(),
    onSuccess: async () => { setComment(''); await refresh() },
  })
  const project = record.data?.project
  const protocol = (project?.settings.tracker as { protocol?: string } | undefined)?.protocol
  const sourceLine = record.data?.source === 'local' ? 'hub'
    : record.data?.source === 'git' ? 'git'
      : `${project?.name ?? record.data?.task.project ?? 'external'} · ${protocol ?? 'tracker protocol unknown'}`
  return <Sheet
    open onClose={onClose}
    title={record.data ? <span className="inline-flex flex-wrap items-center gap-2"><span>{record.data.task.key}</span><ProjectMark name={record.data.task.project} /></span> : taskKey}
    subtitle={record.data ? <><div>{record.data.task.title}</div><div className="mt-1 inline-flex items-center gap-2 text-[11px]"><SourceMark source={record.data.source} project={record.data.task.project} protocol={protocol} />{sourceLine}</div></> : 'Loading task...'}
  >
    {record.error ? <p className="text-destructive">{record.error.message}</p> : null}
    {record.data ? <>
      <DisplayRow label="Status" value={record.data.source === 'local'
        ? record.data.task.status ?? 'unknown'
        : <span className="inline-flex items-center gap-2">{record.data.task.status ?? 'unknown'}<span aria-hidden>→</span><Badge variant={record.data.task.status_category === 'active' ? 'live' : record.data.task.status_category === 'review' ? 'info' : record.data.task.status_category === 'dropped' ? 'danger' : 'outline'}>{record.data.task.status_category ?? 'unmapped'}</Badge></span>} />
      <DisplayRow label="Assignee" value={record.data.task.assignee ?? 'unassigned'} />
      <DisplayRow label="Parent" value={record.data.task.parent_key ?? '-'} />
      <DisplayRow label="Updated" value={record.data.task.updated_at ? relativeTime(record.data.task.updated_at) : '-'} />
      {reasonRows(record.data.capabilities)}
      <div className="mt-6 space-y-6">
        {record.data.capabilities.setTitle ? <FieldSection title="Title"><SettingBlock label="Task title" control={<div className="flex gap-2"><Input value={title} onChange={(event) => setTitle(event.target.value)} /><Button disabled={saveTitle.isPending || !title.trim()} onClick={() => saveTitle.mutate({ key: taskKey, title })}>Save</Button></div>} hint={saveTitle.error ? <span className="text-destructive">{saveTitle.error.message}</span> : undefined} /></FieldSection> : null}
        {record.data.capabilities.setStatus ? <FieldSection title="Status"><SettingBlock label="Task status" control={<Select label="Task status" value={record.data.task.status_category ?? 'open'} options={statuses.map((status) => ({ value: status, label: status }))} onChange={(status) => saveStatus.mutate({ key: taskKey, status: status as typeof statuses[number] })} />} hint={saveStatus.error ? <span className="text-destructive">{saveStatus.error.message}</span> : undefined} /></FieldSection> : null}
        {record.data.capabilities.documents ? <FieldSection title="Documents">
          {record.data.documents.length ? record.data.documents.map((document) => <DocumentEditor key={document.id} document={document} />) : <p className="text-muted-foreground">No documents.</p>}
        </FieldSection> : null}
        {record.data.task.body ? <FieldSection title="Description"><Markdown content={record.data.task.body} /></FieldSection> : null}
        <FieldSection title="Comments">
          {record.data.comments.length ? record.data.comments.map((item) => <article key={item.id} className="border-b border-border py-3"><Markdown content={item.body} /><div className="mt-2 text-[11px] text-muted-foreground">{relativeTime(item.created_at)}</div></article>) : <p className="text-muted-foreground">No comments.</p>}
          {record.data.capabilities.comment ? <div className="space-y-2"><Textarea aria-label="New comment" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add a comment" />{addComment.error ? <p className="text-destructive">{addComment.error.message}</p> : null}<Button size="sm" disabled={addComment.isPending || !comment.trim()} onClick={() => addComment.mutate({ key: taskKey, body: comment })}>Add comment</Button></div> : null}
        </FieldSection>
        <FieldSection title="Runs">
          {record.data.runs.length ? record.data.runs.map((run) => <div key={`${run.id}:${run.agent}:${run.started_at}`} className="grid grid-cols-[4rem_1fr_auto] gap-3 border-b border-border py-2"><strong>#{run.id}</strong><span>{run.agent ?? '-'} · {run.job ?? '-'}</span><span className={run.running ? 'text-live' : 'text-muted-foreground'}>{run.running ? 'running' : relativeTime(run.ended_at)}</span></div>) : <p className="text-muted-foreground">No delegated runs.</p>}
        </FieldSection>
      </div>
    </> : null}
  </Sheet>
}
