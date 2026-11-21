// concern: workflow-task-open-with-notes-floor
/** Decides the partial-close task and note floor from already gathered facts. */

export type NoteFloorEvidence = {
  reference: string
  recordId: string | null
  label: string | null
  promotedTask: string | null
  staleAt: string | null
}

export type TaskOpenWithNotesEvidence = {
  task?: {
    key: string
    status: string | null
    statusCategory: string | null
    mergedPullRequest: boolean | null
  }
  notes?: NoteFloorEvidence[]
}

export function taskOpenWithNotesFailures(
  evidence: TaskOpenWithNotesEvidence,
  workflowKey?: string,
  requirePullRequest = false,
): string[] {
  const failures: string[] = []
  if (!workflowKey) failures.push('the cursor has no task key')
  if (!evidence.task) failures.push('the task was not named')
  else if (!evidence.task.statusCategory)
    failures.push(`${evidence.task.key}'s status category could not be established`)
  else if (!['open', 'active', 'review'].includes(evidence.task.statusCategory))
    failures.push(
      `${evidence.task.key} reads back as ${evidence.task.status ?? 'unset'} (category ${evidence.task.statusCategory ?? 'unset'})`,
    )
  if (requirePullRequest && evidence.task?.mergedPullRequest !== true)
    failures.push(
      `${evidence.task?.key ?? workflowKey ?? 'the task'} has no merged pull request; merge the pull request and record its link on the task`,
    )
  if (!evidence.notes?.length) failures.push('no note artifact was named')
  for (const note of evidence.notes ?? []) {
    const name = note.label ?? note.reference
    if (!note.recordId) failures.push(`${name} does not exist`)
    else if (note.promotedTask !== workflowKey)
      failures.push(`${name} is attached to ${note.promotedTask ?? 'no task'}, not ${workflowKey}`)
    if (note.recordId && note.staleAt !== null) failures.push(`${name} is stale`)
  }
  return failures
}

export function taskOpenWithNotesMet(
  evidence: TaskOpenWithNotesEvidence,
  workflowKey?: string,
  requirePullRequest = false,
): boolean {
  return taskOpenWithNotesFailures(evidence, workflowKey, requirePullRequest).length === 0
}
