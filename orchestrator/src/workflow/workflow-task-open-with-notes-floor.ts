// concern: workflow-task-open-with-notes-floor
/** Decides the partial-close task and note floor from already gathered facts. */

type PullRequestUnavailable =
  | { kind: 'unrecorded'; reason: string; branch: string }
  | { kind: 'read-error'; reason: string }

export type PullRequestRequirementEvidence = {
  key: string
  mergedPullRequest: boolean | null
  pullRequestUnavailable?: PullRequestUnavailable
}

export function pullRequestRequirement(
  task: PullRequestRequirementEvidence,
  platformSlug: string,
): {
  met: boolean
  taskFailure: string | null
  trackerSuffix: string
} {
  if (task.mergedPullRequest === true) return { met: true, taskFailure: null, trackerSuffix: '' }
  if (task.pullRequestUnavailable?.kind === 'unrecorded') {
    const unmet = `pull request merge state could not be established: ${task.pullRequestUnavailable.reason}; record it with: ${platformSlug} tree branch landed ${task.pullRequestUnavailable.branch} --pr <number>`
    return { met: false, taskFailure: unmet, trackerSuffix: `; ${unmet}` }
  }
  if (task.pullRequestUnavailable?.kind === 'read-error') {
    const unmet = `pull request merge state could not be established: ${task.pullRequestUnavailable.reason}; rerun the close when GitHub is reachable`
    return { met: false, taskFailure: unmet, trackerSuffix: `; ${unmet}` }
  }
  return {
    met: false,
    taskFailure: `${task.key} has no merged pull request; merge the pull request and record its link on the task`,
    trackerSuffix: '',
  }
}

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
    pullRequestUnavailable?: PullRequestUnavailable
  }
  notes?: NoteFloorEvidence[]
}

function taskFailures(
  task: TaskOpenWithNotesEvidence['task'],
  requirePullRequest: boolean,
  platformSlug: string,
): string[] {
  if (!task) return ['the task was not named']
  const failures: string[] = []
  if (!task.statusCategory) failures.push(`${task.key}'s status category could not be established`)
  else if (!['open', 'active', 'review'].includes(task.statusCategory))
    failures.push(
      `${task.key} reads back as ${task.status ?? 'unset'} (category ${task.statusCategory ?? 'unset'})`,
    )
  if (requirePullRequest) {
    const pullRequest = pullRequestRequirement(task, platformSlug)
    if (!pullRequest.met && pullRequest.taskFailure) failures.push(pullRequest.taskFailure)
  }
  return failures
}

export function taskOpenWithNotesFailures(
  evidence: TaskOpenWithNotesEvidence,
  workflowKey?: string,
  requirePullRequest = false,
  platformSlug = '',
): string[] {
  const failures = taskFailures(evidence.task, requirePullRequest, platformSlug)
  if (!workflowKey) failures.push('the cursor has no task key')
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
  platformSlug = '',
): boolean {
  return (
    taskOpenWithNotesFailures(evidence, workflowKey, requirePullRequest, platformSlug).length === 0
  )
}
