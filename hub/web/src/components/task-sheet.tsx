import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { relativeTime } from '@/lib/format'
import { taskStatusLook } from '@/lib/task-status'
import { queryClient, type TaskRecordResponse, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'
import { Input } from '@/ui/field/input'
import { Textarea } from '@/ui/field/textarea'
import { Identifier } from '@/ui/identifier/identifier'
import { ProjectMark, SourceMark } from './design-system'
import { DisplayRow, FieldSection, SettingBlock } from './fields'
import { Markdown } from './markdown'
import { Select } from './select'
import { Sheet } from './sheet'

function reasonRows(capabilities: TaskRecordResponse['capabilities']) {
  const entries = [
    ['Change status', 'setStatus'],
    ['Edit title', 'setTitle'],
    ['Add comment', 'comment'],
    ['Edit documents', 'documents'],
  ] as const
  // A refused write is a DisplayRow, not a disabled control, because a greyed-out
  // input looks like it might work and turns a protocol fact into a UI tease.
  return entries.flatMap(([label, name]) =>
    capabilities[name].allowed
      ? []
      : [<DisplayRow key={name} label={label} value={capabilities[name].reason} />],
  )
}

function DocumentEditor({ document }: { document: TaskRecordResponse['documents'][number] }) {
  const [title, setTitle] = useState(document.title)
  const [body, setBody] = useState(document.body)
  useEffect(() => {
    setTitle(document.title)
    setBody(document.body)
  }, [document.title, document.body])
  const save = useMutation({
    ...trpc.work.setDocument.mutationOptions(),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
    },
  })
  return (
    <article className="space-y-3 border border-border p-3">
      <div className="flex items-center gap-2">
        {document.role ? <Badge tone="info">{document.role}</Badge> : null}
        <span className="text-[11px] text-muted-foreground">version {document.version}</span>
      </div>
      <Input
        aria-label={`Title for document ${document.id}`}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Textarea
        className="min-h-48"
        aria-label={`Body for document ${document.id}`}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      {save.error ? <p className="text-destructive">{save.error.message}</p> : null}
      <Button
        variant="primary"
        size="sm"
        disabled={save.isPending || !title.trim()}
        onClick={() => save.mutate({ id: document.id, title, body, version: document.version })}
      >
        {save.isPending ? 'Saving...' : 'Save document'}
      </Button>
    </article>
  )
}

export function TaskSheet({ taskKey, onClose }: { taskKey: string; onClose: () => void }) {
  const record = useQuery(trpc.work.task.queryOptions({ key: taskKey }))
  const [title, setTitle] = useState('')
  const [comment, setComment] = useState('')
  const taskTitle = record.data?.task.title
  useEffect(() => {
    if (taskTitle !== undefined) setTitle(taskTitle ?? '')
  }, [taskTitle])
  const refresh = async () => {
    await queryClient.invalidateQueries()
  }
  const saveTitle = useMutation({ ...trpc.work.setTitle.mutationOptions(), onSuccess: refresh })
  const saveStatus = useMutation({ ...trpc.work.setStatus.mutationOptions(), onSuccess: refresh })
  const addComment = useMutation({
    ...trpc.work.comment.mutationOptions(),
    onSuccess: async () => {
      setComment('')
      await refresh()
    },
  })
  const project = record.data?.project
  const protocol = record.data?.sourceProtocol
  const sourceLine =
    record.data?.source === 'local'
      ? 'hub'
      : record.data?.source === 'git'
        ? 'git'
        : `${project?.name ?? record.data?.task.project ?? 'external'} · ${protocol ?? 'tracker protocol unknown'}`
  return (
    <Sheet
      open
      onClose={onClose}
      title={
        record.data ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <Identifier>{record.data.task.key}</Identifier>
            <ProjectMark name={record.data.task.project} />
          </span>
        ) : (
          taskKey
        )
      }
      subtitle={
        record.data ? (
          <>
            <div>{record.data.task.title}</div>
            <div className="mt-1 inline-flex items-center gap-2 text-[11px]">
              <SourceMark
                source={record.data.source}
                project={record.data.task.project}
                protocol={protocol}
              />
              {sourceLine}
            </div>
          </>
        ) : (
          'Loading task...'
        )
      }
    >
      {record.error ? <p className="text-destructive">{record.error.message}</p> : null}
      {record.data ? (
        <>
          <DisplayRow
            label="Status"
            value={
              record.data.task.status_category ? (
                <Badge
                  {...taskStatusLook(record.data.task.status_category)}
                  title={`Hub status: ${record.data.task.status_category}`}
                >
                  {record.data.source === 'local'
                    ? record.data.task.status_category
                    : (record.data.task.status ?? record.data.task.status_category)}
                </Badge>
              ) : (
                (record.data.task.status ?? 'unknown')
              )
            }
          />
          <DisplayRow label="Assignee" value={record.data.task.assignee ?? 'unassigned'} />
          <DisplayRow label="Parent" value={record.data.task.parent_key ?? '-'} />
          <DisplayRow
            label="Updated"
            value={record.data.task.updated_at ? relativeTime(record.data.task.updated_at) : '-'}
          />
          {reasonRows(record.data.capabilities)}
          <div className="mt-6 space-y-6">
            {record.data.capabilities.setTitle.allowed ? (
              <FieldSection title="Title">
                <SettingBlock
                  label="Task title"
                  control={
                    <div className="flex gap-2">
                      <Input value={title} onChange={(event) => setTitle(event.target.value)} />
                      <Button
                        variant="primary"
                        disabled={saveTitle.isPending || !title.trim()}
                        onClick={() => saveTitle.mutate({ key: taskKey, title })}
                      >
                        Save
                      </Button>
                    </div>
                  }
                  hint={
                    saveTitle.error ? (
                      <span className="text-destructive">{saveTitle.error.message}</span>
                    ) : undefined
                  }
                />
              </FieldSection>
            ) : null}
            {record.data.capabilities.setStatus.allowed ? (
              <FieldSection title="Status">
                <SettingBlock
                  label="Task status"
                  control={
                    <Select
                      label="Task status"
                      value={record.data.task.status_category ?? 'open'}
                      options={(record.data.capabilities.statusVocabulary ?? []).map((status) => ({
                        value: status,
                        label: status,
                      }))}
                      onChange={(status) =>
                        saveStatus.mutate({
                          key: taskKey,
                          status: status as 'open' | 'active' | 'review' | 'done' | 'dropped',
                        })
                      }
                    />
                  }
                  hint={
                    saveStatus.error ? (
                      <span className="text-destructive">{saveStatus.error.message}</span>
                    ) : undefined
                  }
                />
              </FieldSection>
            ) : null}
            {record.data.capabilities.documents.allowed ? (
              <FieldSection title="Documents">
                {record.data.documents.length ? (
                  record.data.documents.map((document) => (
                    <DocumentEditor key={document.id} document={document} />
                  ))
                ) : (
                  <p className="text-muted-foreground">No documents.</p>
                )}
              </FieldSection>
            ) : null}
            {record.data.task.body ? (
              <FieldSection title="Description">
                <Markdown content={record.data.task.body} />
              </FieldSection>
            ) : null}
            <FieldSection title="Comments">
              {record.data.comments.length ? (
                record.data.comments.map((item) => (
                  <article key={item.id} className="border-b border-border py-3">
                    <Markdown content={item.body} />
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      {relativeTime(item.created_at)}
                    </div>
                  </article>
                ))
              ) : (
                <p className="text-muted-foreground">No comments.</p>
              )}
              {record.data.capabilities.comment.allowed ? (
                <div className="space-y-2">
                  <Textarea
                    aria-label="New comment"
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    placeholder="Add a comment"
                  />
                  {addComment.error ? (
                    <p className="text-destructive">{addComment.error.message}</p>
                  ) : null}
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={addComment.isPending || !comment.trim()}
                    onClick={() => addComment.mutate({ key: taskKey, body: comment })}
                  >
                    Add comment
                  </Button>
                </div>
              ) : null}
            </FieldSection>
            <FieldSection title="Runs">
              {record.data.runs.length ? (
                record.data.runs.map((run) => (
                  <div
                    key={`${run.id}:${run.agent}:${run.started_at}`}
                    className="grid grid-cols-[4rem_1fr_auto] gap-3 border-b border-border py-2"
                  >
                    <strong>#{run.id}</strong>
                    <span>
                      {run.agent ?? '-'} · {run.job ?? '-'}
                    </span>
                    <span className={run.running ? 'text-live' : 'text-muted-foreground'}>
                      {run.running ? 'running' : relativeTime(run.ended_at)}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">No delegated runs.</p>
              )}
            </FieldSection>
          </div>
        </>
      ) : null}
    </Sheet>
  )
}
