import { Badge } from '@bottega/hub-ui/badge'
import { Button } from '@bottega/hub-ui/button'
import { Companion } from '@bottega/hub-ui/companion'
import { Input } from '@bottega/hub-ui/field/input'
import { Textarea } from '@bottega/hub-ui/field/textarea'
import { DisplayRow, FieldSection, SettingBlock } from '@bottega/hub-ui/form-layout'
import { Identifier } from '@bottega/hub-ui/identifier'
import { Select } from '@bottega/hub-ui/listbox/select'
import { Markdown } from '@bottega/hub-views/markdown'
import { TaskHistory } from '@bottega/hub-views/task-history'
import { useEffect, useState } from 'react'
import { relativeTime } from '@/lib/format'
import { taskHistoryEntries } from '@/lib/task-history'
import { taskStatusLook } from '@/lib/task-status'
import type { TaskSheetDetail, TaskSheetResult } from '@/routes/-task-sheet-data'
import { ProjectMark, SourceMark } from './design-system'
import { HostedTaskSheet } from './hosted-task-sheet'

function reasonRows(capabilities: TaskSheetDetail['capabilities']) {
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

function DocumentEditor({
  document,
  action,
}: {
  document: TaskSheetDetail['documents'][number]
  action: TaskSheetResult['actions']['setDocument']
}) {
  const [title, setTitle] = useState(document.title)
  const [body, setBody] = useState(document.body)
  useEffect(() => {
    setTitle(document.title)
    setBody(document.body)
  }, [document.title, document.body])
  return (
    <article className="space-y-3 border border-border-default p-3">
      <div className="flex items-center gap-2">
        {document.role ? <Badge tone="info">{document.role}</Badge> : null}
        <span className="text-xs text-text-muted">version {document.version}</span>
      </div>
      <Input
        aria-label={`Title for document ${document.label}`}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Textarea
        className="min-h-48"
        aria-label={`Body for document ${document.label}`}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      {action.error ? (
        <p data-tone="error" className="text-status-text">
          {action.error.message}
        </p>
      ) : null}
      <Button
        variant="primary"
        size="sm"
        disabled={action.pending || !title.trim()}
        onClick={() => void action.run({ id: document.id, title, body, version: document.version })}
      >
        {action.pending ? 'Saving...' : 'Save document'}
      </Button>
    </article>
  )
}

function HostedAwareTaskSheet({
  taskKey,
  result,
  onClose,
}: {
  taskKey: string
  result: TaskSheetResult
  onClose: () => void
}) {
  if (result.detail?.task.spaceName)
    return <HostedTaskSheet taskKey={taskKey} result={result} onClose={onClose} />
  return <TaskSheet taskKey={taskKey} result={result} onClose={onClose} />
}

function historyAction<T extends { error: { message: string } | null }>(action: T) {
  return { ...action, error: action.error?.message ?? null }
}

function TaskSheet({
  taskKey,
  result,
  onClose,
}: {
  taskKey: string
  result: TaskSheetResult
  onClose: () => void
}) {
  const record = { data: result.detail, error: result.error }
  const [title, setTitle] = useState('')
  const taskTitle = record.data?.task.title
  useEffect(() => {
    if (taskTitle !== undefined) setTitle(taskTitle ?? '')
  }, [taskTitle])
  const { setTitle: saveTitle, setStatus: saveStatus } = result.actions
  const sourceLine =
    record.data?.task.source === 'local'
      ? 'hub'
      : record.data?.task.source === 'git'
        ? 'git'
        : `${record.data?.task.project ?? 'external'} · ${record.data?.task.sourceProtocol ?? 'tracker protocol unknown'}`
  return (
    <Companion
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
            <div className="mt-1 inline-flex items-center gap-2 text-xs">
              <SourceMark
                source={record.data.task.source}
                project={record.data.task.project}
                protocol={record.data.task.sourceProtocol}
              />
              {sourceLine}
            </div>
          </>
        ) : (
          'Loading task...'
        )
      }
    >
      {record.error ? (
        <p data-tone="error" className="text-status-text">
          {record.error.message}
        </p>
      ) : null}
      {record.data ? (
        <>
          <DisplayRow
            label="Status"
            value={
              record.data.task.statusCategory ? (
                <Badge
                  {...taskStatusLook(record.data.task.statusCategory)}
                  title={`Hub status: ${record.data.task.statusCategory}`}
                >
                  {record.data.task.source === 'local'
                    ? record.data.task.statusCategory
                    : (record.data.task.status ?? record.data.task.statusCategory)}
                </Badge>
              ) : (
                (record.data.task.status ?? 'unknown')
              )
            }
          />
          <DisplayRow label="Assignee" value={record.data.task.assignee ?? 'unassigned'} />
          <DisplayRow label="Parent" value={record.data.task.parentKey ?? '-'} />
          <DisplayRow
            label="Updated"
            value={record.data.task.updatedAt ? relativeTime(record.data.task.updatedAt) : '-'}
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
                        disabled={saveTitle.pending || !title.trim()}
                        onClick={() => void saveTitle.run(title)}
                      >
                        Save
                      </Button>
                    </div>
                  }
                  hint={
                    saveTitle.error ? (
                      <span data-tone="error" className="text-status-text">
                        {saveTitle.error.message}
                      </span>
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
                      value={record.data.task.statusCategory ?? 'open'}
                      options={(record.data.capabilities.statusVocabulary ?? []).map((status) => ({
                        value: status,
                        label: status,
                      }))}
                      onChange={(status) =>
                        void saveStatus.run(
                          status as 'open' | 'active' | 'review' | 'done' | 'dropped',
                        )
                      }
                    />
                  }
                  hint={
                    saveStatus.error ? (
                      <span data-tone="error" className="text-status-text">
                        {saveStatus.error.message}
                      </span>
                    ) : undefined
                  }
                />
              </FieldSection>
            ) : null}
            {record.data.capabilities.documents.allowed ? (
              <FieldSection title="Documents">
                {record.data.documents.length ? (
                  record.data.documents.map((document) => (
                    <DocumentEditor
                      key={document.id}
                      document={document}
                      action={result.actions.setDocument}
                    />
                  ))
                ) : (
                  <p className="text-text-muted">No documents.</p>
                )}
              </FieldSection>
            ) : null}
            {record.data.task.body ? (
              <FieldSection title="Description">
                <Markdown content={record.data.task.body} />
              </FieldSection>
            ) : null}
            <TaskHistory
              entries={taskHistoryEntries(record.data)}
              comment={historyAction(result.actions.comment)}
              editComment={historyAction(result.actions.editComment)}
              deleteComment={historyAction(result.actions.deleteComment)}
            />
          </div>
        </>
      ) : null}
    </Companion>
  )
}

export { HostedAwareTaskSheet as TaskSheet }
