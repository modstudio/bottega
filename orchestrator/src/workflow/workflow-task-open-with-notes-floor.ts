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
  writtenAt?: string
}

type PromotedNotesEvidence =
  | {
      known: true
      notes: Pick<NoteFloorEvidence, 'recordId' | 'label' | 'staleAt'>[]
    }
  | { known: false; reason: string }

export type TaskOpenWithNotesEvidence = {
  task?: {
    key: string
    status: string | null
    statusCategory: string | null
    mergedPullRequest: boolean | null
    pullRequestUnavailable?: PullRequestUnavailable
  }
  notes?: NoteFloorEvidence[]
  promotedNotes?: PromotedNotesEvidence
}

function hasLivePromotedNotes(evidence: TaskOpenWithNotesEvidence): boolean {
  return evidence.promotedNotes?.known === true
    ? evidence.promotedNotes.notes.some((note) => note.staleAt === null)
    : true
}

export function taskOpenWithNotesRemedy(
  evidence: TaskOpenWithNotesEvidence,
  workflowKey?: string,
): string {
  return hasLivePromotedNotes(evidence)
    ? ` and --artifact note:<record-id|label> naming a live note promoted to ${workflowKey ?? 'the cursor task'}`
    : `; no note artifact is needed because no live note is promoted to ${workflowKey ?? 'the cursor task'}`
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
  if (!evidence.notes?.length && hasLivePromotedNotes(evidence)) {
    const unreadable =
      evidence.promotedNotes?.known === false
        ? `; the notes promoted to ${workflowKey ?? 'the cursor task'} could not be read: ${evidence.promotedNotes.reason}`
        : ''
    failures.push(`no note artifact was named${unreadable}`)
  }
  for (const note of evidence.notes ?? []) {
    const name = note.label ?? note.reference
    if (!note.recordId) failures.push(`${name} does not exist`)
    else if (note.promotedTask !== workflowKey)
      failures.push(`${name} is attached to ${note.promotedTask ?? 'no task'}, not ${workflowKey}`)
    if (note.recordId && note.staleAt !== null)
      failures.push(
        `${name} is stale; record a sighting with \`${platformSlug} note new --same-as ${name} --project <project> "<sighting>"\``,
      )
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
