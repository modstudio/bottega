import { Badge } from '@bottega/hub-ui/badge'
import { IconButton } from '@bottega/hub-ui/button'
import { Dialog } from '@bottega/hub-ui/dialog'
import { Select } from '@bottega/hub-ui/listbox/select'
import { relativeTime } from '@bottega/hub-util/format'
import { DocumentSurface } from '@bottega/hub-views/document-surface'
import { taskStatusLook } from '@bottega/hub-views/status-look/task-status'
import { TaskHistory } from '@bottega/hub-views/task-history'
import { TaskPage, type TaskPageSave } from '@bottega/hub-views/task-page'
import type { TaskPageDoc, TaskPageFact } from '@bottega/hub-views/task-page/task-rail'
import { X } from 'lucide-react'
import { taskHistoryEntries } from '@/lib/task-history'
import type { TaskScreenDetail, TaskScreenResult } from '@/routes/-task-screen-data'
import { ProjectMark, SourceMark } from './design-system'
import { TaskMeasures } from './measure-display'

type TaskStatus = 'open' | 'active' | 'review' | 'done' | 'dropped'

function StatusBadge({ task }: { task: TaskScreenDetail['task'] }) {
  if (!task.statusCategory) return <>{task.status ?? 'unknown'}</>
  return (
    <Badge {...taskStatusLook(task.statusCategory)} title={`Hub status: ${task.statusCategory}`}>
      {task.source === 'local' ? task.statusCategory : (task.status ?? task.statusCategory)}
    </Badge>
  )
}

function StatusControl({ detail, result }: { detail: TaskScreenDetail; result: TaskScreenResult }) {
  const { setStatus } = result.actions
  if (!detail.capabilities.setStatus.allowed) return <StatusBadge task={detail.task} />
  return (
    <Select
      label="Task status"
      size="sm"
      className="w-full min-w-0"
      value={detail.task.statusCategory ?? 'open'}
      options={(detail.capabilities.statusVocabulary ?? []).map((status) => ({
        value: status,
        label: status,
      }))}
      onChange={(status) => void setStatus.run(status as TaskStatus)}
    />
  )
}

function sourceLine(task: TaskScreenDetail['task']): string {
  if (task.source === 'local') return 'hub'
  if (task.source === 'git') return 'git'
  return `${task.project ?? 'external'} · ${task.sourceProtocol ?? 'tracker protocol unknown'}`
}

/** One row per refusal reason, because a hosted or remote task usually refuses every edit alike. */
function refusalFacts(capabilities: TaskScreenDetail['capabilities']): TaskPageFact[] {
  const reasons = new Set(
    [
      capabilities.setTitle,
      capabilities.setStatus,
      capabilities.setBody,
      capabilities.comment,
      capabilities.documents,
    ].flatMap((capability) => (capability.allowed ? [] : [capability.reason])),
  )
  return [...reasons].map((reason) => ({ label: 'Changes', value: reason }))
}

function taskFacts(detail: TaskScreenDetail, result: TaskScreenResult): TaskPageFact[] {
  const { task } = detail
  return [
    { label: 'Status', value: <StatusControl detail={detail} result={result} /> },
    { label: 'Project', value: <ProjectMark name={task.project} /> },
    ...(task.spaceName ? [{ label: 'Space', value: task.spaceName }] : []),
    { label: 'Assignee', value: task.assignee ?? 'Unassigned' },
    { label: 'Parent', value: task.parentKey ?? '—' },
    {
      label: 'Source',
      value: (
        <span className="inline-flex items-center gap-1.5">
          <SourceMark source={task.source} project={task.project} protocol={task.sourceProtocol} />
          {sourceLine(task)}
        </span>
      ),
    },
    { label: 'Updated', value: task.updatedAt ? relativeTime(task.updatedAt) : '—' },
    ...refusalFacts(detail.capabilities),
  ]
}

function taskDocs(detail: TaskScreenDetail): TaskPageDoc[] {
  return detail.documents.map((document) => ({
    id: document.id,
    label: document.label,
    title: document.title,
    role: document.role,
    body: document.body,
    keyLine: [
      ...(document.role
        ? [{ key: 'role', content: <Badge tone="info">{document.role}</Badge> }]
        : []),
      { key: 'updated', content: `Updated ${relativeTime(document.updatedAt)}` },
    ],
    facts: [
      { label: 'Document', value: document.label },
      ...(document.role ? [{ label: 'Role', value: document.role }] : []),
      { label: 'Version', value: document.version },
      { label: 'Updated', value: relativeTime(document.updatedAt) },
    ],
  }))
}

function taskSave(result: TaskScreenResult): TaskPageSave {
  const { saveDraft, setBody } = result.actions
  return {
    run: saveDraft.run,
    pending: saveDraft.pending,
    error: saveDraft.conflict ? null : (saveDraft.error?.message ?? null),
    refused: saveDraft.refused,
    conflict: saveDraft.conflict,
    async reload() {
      const fresh = await setBody.reload()
      return { title: fresh.task.title ?? fresh.task.key, body: fresh.task.body ?? '' }
    },
  }
}

function historyAction<T extends { error: { message: string } | null }>(action: T) {
  return { ...action, error: action.error?.message ?? null }
}

function LoadedTask({
  detail,
  result,
  openDoc,
  onOpenDoc,
  onClose,
}: {
  detail: TaskScreenDetail
  result: TaskScreenResult
  openDoc: string | null
  onOpenDoc: (id: string | null) => void
  onClose: () => void
}) {
  const { task } = detail
  return (
    <TaskPage
      crumbs={[
        { key: 'project', label: task.project ?? 'Unfiled' },
        { key: 'task', label: task.key },
      ]}
      title={task.title ?? task.key}
      body={task.body ?? ''}
      keyLine={[
        { key: 'status', content: <StatusBadge task={task} /> },
        { key: 'assignee', content: task.assignee ?? 'Unassigned' },
        ...(task.updatedAt
          ? [{ key: 'updated', content: `Updated ${relativeTime(task.updatedAt)}` }]
          : []),
      ]}
      details={taskFacts(detail, result)}
      figures={
        detail.measures ? (
          <TaskMeasures
            measures={detail.measures}
            hasRecordedTime={detail.measureCoverage?.hasRecordedTime ?? true}
          />
        ) : undefined
      }
      docs={taskDocs(detail)}
      openDoc={openDoc}
      onOpenDoc={onOpenDoc}
      history={
        <TaskHistory
          entries={taskHistoryEntries(detail)}
          comment={historyAction(result.actions.comment)}
          editComment={historyAction(result.actions.editComment)}
          deleteComment={historyAction(result.actions.deleteComment)}
        />
      }
      save={taskSave(result)}
      onClose={onClose}
    />
  )
}

/** A task opened over the list it came from, as a full page; local and hosted differ only in data. */
export function TaskScreen({
  taskKey,
  result,
  openDoc,
  onOpenDoc,
  onClose,
}: {
  taskKey: string
  result: TaskScreenResult
  openDoc: string | null
  onOpenDoc: (id: string | null) => void
  onClose: () => void
}) {
  const detail = result.detail
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={detail ? `${detail.task.key} ${detail.task.title ?? ''}`.trim() : taskKey}
      size="full"
      variant="chromeless"
    >
      {detail ? (
        <LoadedTask
          detail={detail}
          result={result}
          openDoc={openDoc}
          onOpenDoc={onOpenDoc}
          onClose={onClose}
        />
      ) : (
        <DocumentSurface
          crumbs={[{ key: 'task', label: taskKey }]}
          title=""
          heading={() => null}
          headerActions={
            <IconButton size="sm" label="Close task" onClick={onClose}>
              <X />
            </IconButton>
          }
          error={result.error?.message ?? null}
          body={result.error ? null : <p className="text-md text-text-muted">Loading task…</p>}
        />
      )}
    </Dialog>
  )
}
