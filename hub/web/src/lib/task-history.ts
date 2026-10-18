import type { HistoryEntry } from '@bottega/hub-views/task-history/history-model'
import type { TaskScreenDetail } from '@/routes/-task-screen-data'

/** A task's comments, status changes and runs in the shape the history feed draws. */
export function taskHistoryEntries(detail: TaskScreenDetail): HistoryEntry[] {
  return [
    ...detail.comments.map(
      (comment): HistoryEntry => ({
        kind: 'comment',
        id: `comment:${comment.id}`,
        at: comment.createdAt,
        body: comment.body,
        actor: comment.actorName,
        agent: comment.agent,
        canEdit: comment.canEdit,
        canDelete: comment.canDelete,
      }),
    ),
    ...detail.statusEvents.map(
      (event): HistoryEntry => ({
        kind: 'status',
        id: `status:${event.id}`,
        at: event.at,
        from: event.fromStatus,
        to: event.toStatus,
        actor: event.actorName,
        agent: event.agent,
      }),
    ),
    // A run can appear once per interval, and a hosted interval may have no run id, so the row's
    // position is what keeps each entry unique.
    ...detail.runs.map(
      (run, index): HistoryEntry => ({
        kind: 'run',
        id: `run:${index}:${run.id ?? ''}`,
        at: run.startedAt,
        run: run.id,
        agent: run.agent ?? run.source,
        job: run.job,
        endedAt: run.running ? null : run.endedAt,
        running: run.running,
        actor: null,
      }),
    ),
  ]
}
