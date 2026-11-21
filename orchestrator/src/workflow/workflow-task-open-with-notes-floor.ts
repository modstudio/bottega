// concern: workflow-task-open-with-notes-floor
/** Decides the partial-close task and note floor from already gathered facts. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type PullRequestUnavailable =
  | { kind: 'unrecorded'; reason: string; branch: string }
  | { kind: 'read-error'; reason: string }

export type PullRequestRequirementEvidence = {
  key: string
  mergedPullRequest: boolean | null
  pullRequestUnavailable?: PullRequestUnavailable
}

export function pullRequestRequirement(task: PullRequestRequirementEvidence): {
  met: boolean
  taskFailure: string | null
  trackerSuffix: string
} {
  if (task.mergedPullRequest === true)
    return { met: true, taskFailure: null, trackerSuffix: '' }
  if (task.pullRequestUnavailable?.kind === 'unrecorded') {
    const unmet = `pull request merge state could not be established: ${task.pullRequestUnavailable.reason}; record it with: ${PLATFORM_SLUG} tree branch landed ${task.pullRequestUnavailable.branch} --pr <number>`
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
  if (requirePullRequest && evidence.task) {
    const pullRequest = pullRequestRequirement(evidence.task)
    if (!pullRequest.met && pullRequest.taskFailure) failures.push(pullRequest.taskFailure)
  }
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
