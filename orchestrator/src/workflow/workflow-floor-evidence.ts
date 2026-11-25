// concern: workflows
/** Gathers recorded rows that a floor decision may consume. Must not decide satisfaction. */

import type { Database } from 'bun:sqlite'
import { realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { docScopeHasProjectSubject, docScopeIsProjectless } from '../../../shared/docs.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { installedBottegaExecutable } from '../../../shared/self-spawn.ts'
import { branchForTaskKey, pullRequestNumberForBranch } from '../branch/task-key-pull-request.ts'
import { db } from '../database/db.ts'
import { readDocReference } from '../doc/doc-authoritative-read.ts'
import { landingGatePurposeRefusal, resolveGateIdentifier } from '../gate/gate-identifier.ts'
import { resolveCommitArgument } from '../git/commit-resolution.ts'
import { projectByName, registeredCheckoutRoots } from '../project/projects.ts'
import {
  questionForWorkflowCursorByNumber,
  questionRuleAuditReasons,
} from '../question-store/question-store-read.ts'
import {
  reviewRoundTriageComplete,
  reviewsForTriage,
  type TriageReviewRow,
} from '../review/review-group.ts'
import { resolveReviewIdentifier } from '../review/review-identifier.ts'
import { reviewLineage } from '../review/review-lineage-store.ts'
import { rulingStatus } from '../run/question-vocabulary.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import { taskFlowHandoffLinks, taskFlowReadStore } from './task-flow-store.ts'
import type {
  ArtifactEvidence,
  BottegaCommandIdentity,
  ValidatedArtifactEvidence,
} from './workflow-artifact-evidence.ts'
import {
  type CheckoutResolution,
  checkoutOutsideChangeRefusal,
  classifyCheckoutResolution,
} from './workflow-checkout-refusal.ts'
import { createdAfterStepActivation } from './workflow-cursor-trail.ts'
import type { CursorState } from './workflow-cursor-transition.ts'
import { resolveWorkflowCursorSuccessor } from './workflow-cursor-transition.ts'
import type { WorkflowEvidenceInput } from './workflow-evidence-input.ts'
import {
  type ArtifactRef,
  decideReviewReadArtifact,
  type Floor,
  flagForFloor,
  floorGuidance,
  floorsAcceptCommandArtifact,
  floorsIncludeTrackerTransition,
  githubPullRequestUrlIn,
  hasGateFloor,
  parseArtifactRef,
  pullRequestCreateArgv,
  type ValidatedEvidence,
} from './workflow-floor.ts'
import {
  requireAttachedTextFreshness,
  requireMutableArtifactFreshness,
} from './workflow-floor-artifact-freshness.ts'
import { gitText, productionResolveCheckout } from './workflow-floor-evidence-checkout.ts'
import { positiveEvidenceId } from './workflow-floor-evidence-input.ts'
import { gatherPassingGateForTree } from './workflow-floor-evidence-passing-gate.ts'
import {
  type FloorEvidencePorts,
  invokeFloorEvidencePort,
  rethrowFloorEvidencePortMiss,
} from './workflow-floor-evidence-replay.ts'
import { gatherNoteArtifactEvidence } from './workflow-floor-note-evidence.ts'
import { gatherPromotedNotes } from './workflow-floor-promoted-notes-evidence.ts'
import {
  gatherPullRequestArtifactEvidence,
  viewPullRequestInProject,
} from './workflow-floor-pull-request-evidence.ts'
import { resolveTaskArtifact } from './workflow-floor-task-artifact-evidence.ts'
import { readHubTask, readHubTaskDocument } from './workflow-floor-task-read.ts'
import { floorFromObligationRow } from './workflow-obligation-floor.ts'
import { resolvedOfferedArtifact } from './workflow-offered-artifacts.ts'
import {
  type BoundRun,
  decideRunBinding,
  type SessionMatch,
  sessionOrAdopterMatch,
} from './workflow-run-binding.ts'
import { attachedTextReferenceMeetsFloor, type WorkflowTextRow } from './workflow-text.ts'

export type { FloorEvidencePorts } from './workflow-floor-evidence-replay.ts'

export type CursorIdentity = {
  project: string
  workflowKey: string
  workflowTaskRecordId?: string | null
  branch: string | null
  worktree: string | null
  session: string | null
  createdAt: string
  stepActivatedAt: string
}

export const productionFloorPorts = (): FloorEvidencePorts => ({
  readTask: (key) => readHubTask(key),
  readTaskDocument: readHubTaskDocument,
  viewPullRequest: viewPullRequestInProject,
  readOriginUrl: (project) => {
    const row = projectByName(project)
    if (!row) throw new Error(`project ${project} is not registered; cannot read its origin`)
    return gitText(row.path, ['remote', 'get-url', 'origin'])
  },
})

export async function gatherRuling(
  id: number,
  cursorId: string,
  stepOrdinal: number,
  stepSlug: string,
  d: Database,
): Promise<ValidatedEvidence['ruling']> {
  const question = await questionForWorkflowCursorByNumber(d, cursorId, id)
  if (!question)
    throw new Error(
      `--ruling ${id} is not a question on this workflow cursor; pass the number that \`${PLATFORM_SLUG} workflow rule\` or \`${PLATFORM_SLUG} workflow await\` printed for this cursor, then retry`,
    )
  const row = {
    id,
    answered_at: question.answered_at as string | null,
    answerer_kind: question.answerer_kind as string | null,
    overturned_at: question.overturned_at as string | null,
    replacement: question.replacement as string | null,
    is_open: question.answered_at === null && question.closed_at === null ? 1 : 0,
    workflow_step_ordinal: question.workflow_step_ordinal as number | null,
    workflow_step_slug: question.workflow_step_slug as string | null,
  }
  const facts = questionRowToFacts(row)
  return {
    id,
    answered: facts.answered,
    answeredByOperator: facts.answeredByOperator,
    boundToCursor: true,
    boundToStep: row.workflow_step_ordinal === stepOrdinal && row.workflow_step_slug === stepSlug,
    answeredAt: row.answered_at,
  }
}

export type QuestionEvidenceRow = {
  id: number
  answered_at: string | null
  answerer_kind: string | null
  overturned_at: string | null
  replacement: string | null
  is_open: number
}

export function questionRowToFacts(row: QuestionEvidenceRow): {
  state: NonNullable<ValidatedEvidence['stepQuestion']>['state']
  answered: boolean
  answeredByOperator: boolean
  answeredAt: string | null
  replacement: string | null
} {
  const status = rulingStatus(row.overturned_at, row.answered_at)
  const overturned = status === 'overturned'
  const answered = status === 'answered'
  const answeredByOperator = answered && row.answerer_kind === 'operator'
  return {
    state: overturned
      ? 'overturned'
      : answered
        ? answeredByOperator
          ? 'answered-by-operator'
          : 'answered-by-agent'
        : row.is_open
          ? 'open'
          : 'closed',
    answered,
    answeredByOperator,
    answeredAt: row.answered_at,
    replacement: row.replacement,
  }
}

function gatherReview(
  recordId: string,
  identity: CursorIdentity,
  d: Database,
): ValidatedEvidence['review'] {
  const review = d
    .query<
      {
        record_id: string
        number: number
        project_name: string | null
        patch_id: string | null
        zero_context_patch_id: string | null
        path_set: string | null
      },
      [string]
    >(
      `SELECT r.record_id,r.number, p.name AS project_name, r.patch_id,r.zero_context_patch_id,r.path_set
         FROM review r LEFT JOIN project p ON p.record_id=r.project_record_id
        WHERE r.record_id=?`,
    )
    .get(recordId)
  if (!review) throw new Error(`--review ${recordId} does not exist`)
  if (review.project_name !== identity.project)
    throw new Error(
      `--review ${review.number} project is ${review.project_name ?? 'unset'}, not this cursor's ${identity.project}`,
    )
  const lineage = identity.branch ? reviewLineage(d, identity.project, identity.branch) : []
  const branchMatch = identity.branch ? `ru.branch IN (${lineage.map(() => '?').join(',')})` : '0'
  const bound = d
    .query<{ branch: string | null }, (string | null)[]>(
      `SELECT ru.branch
         FROM review_lens rl JOIN run ru ON ru.record_id=rl.run_record_id
        WHERE rl.review_record_id=?
          AND (${branchMatch} OR ru.task_record_id=?)
        ORDER BY CASE WHEN ${branchMatch} THEN 0 ELSE 1 END, ru.started_at,rl.record_id LIMIT 1`,
    )
    .get(recordId, ...lineage, identity.workflowTaskRecordId ?? null, ...lineage)
  if (!bound)
    throw new Error(
      `--review ${review.number} has no lens run on branch ${identity.branch ?? 'unset'} or task ${identity.workflowKey || 'unset'}`,
    )
  const branch = identity.branch ?? bound.branch
  const grouped = reviewsForTriage(
    d,
    {
      project: identity.project,
      branch: branch ?? '',
      patchId: review.patch_id ?? '',
      zeroContextPatchId: review.zero_context_patch_id,
      pathSet: review.path_set === null ? [] : (JSON.parse(review.path_set) as string[]),
    },
    recordId,
  )
  const reviews =
    review.patch_id === null || review.path_set === null
      ? grouped.branchReviews.filter(({ reviewRecordId }) => reviewRecordId === recordId)
      : grouped.reviews
  const unfinishedReviewIds = reviews
    .filter((review) => !reviewRoundTriageComplete(review))
    .map(({ reviewNumber }) => reviewNumber)
  return {
    recordId,
    number: review.number,
    allFindingsDisposed: reviews.every(({ findings }) =>
      findings.every(({ disposition }) => disposition !== null),
    ),
    allLensesGraded: reviewRoundsHaveTriageEvidence(reviews),
    ...(unfinishedReviewIds.length ? { unfinishedReviewIds } : {}),
  }
}

/** Whether settled review rounds include at least one evidence-bearing lens result. */
export function reviewRoundsHaveTriageEvidence(reviews: readonly TriageReviewRow[]): boolean {
  return (
    reviews.length > 0 &&
    reviews.every(reviewRoundTriageComplete) &&
    reviews.some((review) => review.lenses.some((lens) => lens.graded))
  )
}

function loadRunBinding(runId: string, d: Database): BoundRun | null {
  const row = d
    .query<
      {
        repo: string | null
        task_record_id: string | null
        branch: string | null
        session_id: string | null
        started_at: string
        project_name: string | null
      },
      [string]
    >(
      `SELECT r.repo, r.task_record_id, r.branch, r.session_id, r.started_at, p.name AS project_name
         FROM run r LEFT JOIN project p ON p.record_id=r.project_record_id
        WHERE r.record_id=?`,
    )
    .get(runId)
  if (!row) return null
  return {
    project: row.project_name ?? row.repo,
    taskRecordId: row.task_record_id,
    branch: row.branch,
    sessionId: row.session_id,
    createdAt: row.started_at,
  }
}

async function loadAdoptionReasons(
  cursorId: string,
  actorSession: string,
  d: Database,
): Promise<Array<string | null>> {
  return questionRuleAuditReasons(d, cursorId, actorSession)
}

async function sessionOrAdopterFor(
  cursorId: string,
  cursorSession: string | null,
  actorSession: string | null,
  d: Database,
): Promise<SessionMatch> {
  const adoptionReasons =
    cursorSession !== null && actorSession !== null
      ? await loadAdoptionReasons(cursorId, actorSession, d)
      : []
  return sessionOrAdopterMatch({
    cursorSession,
    actorSession,
    adoptionReasons,
  })
}

async function requireRunBinding(
  flag: string,
  run: BoundRun,
  identity: CursorIdentity,
  cursorId: string,
  d: Database,
): Promise<void> {
  const session = await sessionOrAdopterFor(cursorId, identity.session, run.sessionId, d)
  const refusal = decideRunBinding({ flag, run, identity, ...session })
  if (refusal) throw new Error(refusal)
}

function requireCheckout(
  flag: string,
  cwd: string,
  headCommit: string | null,
  identity: CursorIdentity,
  resolveCheckout: FloorEvidencePorts['resolveCheckout'],
): CheckoutResolution {
  if (!resolveCheckout)
    throw new Error(`${flag} cwd project is unset, not this cursor's ${identity.project}`)
  const checkout = resolveCheckout(cwd, headCommit, identity.branch)
  if (checkout.project !== identity.project)
    throw new Error(
      `${flag} cwd project is ${checkout.project ?? 'unset'}, not this cursor's ${identity.project}`,
    )
  const location = classifyCheckoutResolution(checkout)
  if (identity.branch && location === 'outside-change')
    throw new Error(
      checkoutOutsideChangeRefusal(flag, identity.branch, checkout.checkoutPath, checkout),
    )
  return checkout
}

function requireCommandArtifactCheckout(
  required: boolean,
  flag: string,
  row: { cwd: string; head_commit: string | null },
  identity: CursorIdentity,
  resolveCheckout: FloorEvidencePorts['resolveCheckout'],
): void {
  if (required) requireCheckout(flag, row.cwd, row.head_commit, identity, resolveCheckout)
}

async function gatherGate(
  recordId: string,
  identity: CursorIdentity,
  cursorId: string,
  resolveCheckout: FloorEvidencePorts['resolveCheckout'],
  d: Database,
): Promise<ValidatedEvidence['gate']> {
  const row = d
    .query<
      {
        record_id: string
        number: number
        finished_at: string | null
        exit_code: number | null
        run_record_id: string | null
        cwd: string | null
        head_commit: string | null
      },
      [string]
    >(
      `SELECT record_id,number,finished_at,exit_code,run_record_id,cwd,head_commit
         FROM gate_execution
        WHERE record_id=? AND purpose='gate'`,
    )
    .get(recordId)
  if (!row) throw new Error(landingGatePurposeRefusal(recordId, d, `${PLATFORM_SLUG} gate run`))
  const flag = `--gate ${row.number}`
  let project: string | null
  if (row.run_record_id !== null) {
    const run = loadRunBinding(row.run_record_id, d)
    if (!run) throw new Error(`${flag} run ${row.run_record_id} does not exist`)
    await requireRunBinding(flag, run, identity, cursorId, d)
    project = run.project
  } else {
    if (!row.cwd) throw new Error(`${flag} architect row has no cwd`)
    project = requireCheckout(flag, row.cwd, row.head_commit, identity, resolveCheckout).project
  }
  return {
    recordId: row.record_id,
    finished: row.finished_at !== null && row.exit_code !== null,
    exitCode: row.exit_code,
    project,
    commit: row.head_commit,
  }
}

function resolveOfferedGate(
  d: Database,
  identifier: string | number | undefined,
): string | undefined {
  if (identifier === undefined || String(identifier).trim() === '') return undefined
  return resolveGateIdentifier(d, identifier)
}

async function gatherRun(
  id: string,
  identity: CursorIdentity,
  cursorId: string,
  d: Database,
): Promise<ValidatedEvidence['run']> {
  const row = d
    .query<{ status: string; exit_code: number | null }, [string]>(
      'SELECT status,exit_code FROM run WHERE record_id=?',
    )
    .get(id)
  if (!row) throw new Error(`--run ${id} does not exist`)
  const binding = loadRunBinding(id, d)
  if (!binding) throw new Error(`--run ${id} does not exist`)
  await requireRunBinding(`--run ${id}`, binding, identity, cursorId, d)
  return {
    id,
    terminal: TERMINAL_RUN_STATUS_SET.has(row.status) && row.exit_code !== null,
    exitCode: row.exit_code,
  }
}

/**
 * Whether a document address is admissible as evidence on a project's cursor. A document in a
 * project-less scope (global, machine) belongs to no project, so it is admissible on any
 * cursor; a document scoped to another project is not.
 */
export function docAdmissibleAsCursorEvidence(
  address: { scope: string; subject: string | null; projectName: string | null },
  project: string,
): boolean {
  return (
    docScopeIsProjectless(address.scope) ||
    address.projectName === project ||
    (docScopeHasProjectSubject(address.scope) && address.subject === project)
  )
}

async function resolveDocArtifact(
  value: string,
  identity: CursorIdentity,
  d: Database,
): Promise<string> {
  const row = await readDocReference(value, d)
  const flag = `--artifact doc:${value}`
  if (!row)
    throw new Error(
      renderRefusal(
        refusal(`${flag} does not exist`, {
          kind: 'edit',
          text: floorGuidance['recorded-artifact'],
        }),
      ),
    )
  if (!docAdmissibleAsCursorEvidence(row, identity.project))
    throw new Error(
      `${flag} is scoped to ${row.projectName ?? row.subject ?? row.scope}, not this cursor's ${identity.project}`,
    )
  requireMutableArtifactFreshness('doc', row.updatedAt, identity.stepActivatedAt)
  return row.address
}

function resolveRunArtifactIdentifier(input: string, raw: string, d: Database): string {
  try {
    return resolveRunIdentifier(d, input)
  } catch {
    throw new Error(`--artifact ${raw} is not a run; pass ${flagForFloor('recorded-artifact')}`)
  }
}

async function resolveNumericArtifact(
  id: number,
  identity: CursorIdentity,
  cursorId: string,
  d: Database,
): Promise<ArtifactEvidence> {
  const run = d.query('SELECT record_id FROM run WHERE number=?').get(id) as {
    record_id: string
  } | null
  if (run) {
    const binding = loadRunBinding(run.record_id, d)
    if (!binding) throw new Error(`--artifact ${id} is not a run bound to this cursor`)
    await requireRunBinding(`--artifact ${id}`, binding, identity, cursorId, d)
    return { ref: String(id), exists: true }
  }
  throw new Error(`--artifact ${id} is not a recorded run`)
}

async function resolveStoredArtifact(
  ref: Extract<ArtifactRef, { kind: 'attached-text' | 'doc' | 'review-read' }>,
  identity: CursorIdentity,
  binding: { cursorId: string; stepOrdinal: number; stepSlug: string },
  d: Database,
  branchTip: string | null,
): Promise<ArtifactEvidence> {
  if (ref.kind === 'attached-text') {
    const row = await taskFlowReadStore(d).textAttachmentByRecordId(ref.id)
    const attachment: WorkflowTextRow | null = row
      ? {
          id: row.id,
          cursorId: row.cursor_record_id,
          stepOrdinal: row.step_ordinal,
          stepSlug: row.step_slug,
          body: row.body,
          writtenAt: row.created_at,
        }
      : null
    requireAttachedTextFreshness(attachment, identity.stepActivatedAt)
    return {
      ref: 'attached-text',
      exists: attachedTextReferenceMeetsFloor({ ...binding, attachment }),
    }
  }
  if (ref.kind === 'doc')
    return { ref: `doc:${await resolveDocArtifact(ref.address, identity, d)}`, exists: true }
  const row = d
    .query<{ tip: string }, [string]>('SELECT tip FROM review_read WHERE record_id=?')
    .get(ref.recordId)
  const flag = `--artifact review-read:${ref.recordId}`
  if (!row)
    throw new Error(
      `${flag} does not exist; record a fresh read with \`${PLATFORM_SLUG} review read --cwd <tree> --sha <tip> --note <text>\` and pass its id as \`--artifact review-read:<UUID>\``,
    )
  const decision = decideReviewReadArtifact({ reviewedCommit: row.tip, branchTip })
  if (!decision.accepted) throw new Error(`${flag} ${decision.message}`)
  return { ref: `review-read:${ref.recordId}`, exists: true }
}

async function resolveArtifact(
  ref: ArtifactRef,
  raw: string,
  identity: CursorIdentity,
  binding: { cursorId: string; stepOrdinal: number; stepSlug: string },
  d: Database,
  ports: FloorEvidencePorts,
  resolveCheckout: FloorEvidencePorts['resolveCheckout'],
  branchTip: string | null,
  requireCommandCheckout: boolean,
  hasTrackerTransitionFloor: boolean,
): Promise<ArtifactEvidence> {
  if (ref.kind === 'attached-text' || ref.kind === 'doc' || ref.kind === 'review-read')
    return resolveStoredArtifact(ref, identity, binding, d, branchTip)
  if (ref.kind === 'id') return await resolveNumericArtifact(ref.id, identity, binding.cursorId, d)
  if (ref.kind === 'pull-request') return { ref: ref.url, exists: true }
  if (ref.kind === 'commit') {
    const project = projectByName(identity.project, d)
    if (!project) throw new Error(`project ${identity.project} is not registered`)
    return {
      ref: invokeFloorEvidencePort(
        ports,
        'resolveCommit',
        resolveCommitArgument,
        project.path,
        ref.sha,
      ),
      exists: true,
    }
  }
  if (ref.kind === 'probe' || ref.kind === 'exec') {
    const row = d
      .query<
        {
          cwd: string
          head_commit: string | null
          exit_code: number
          kind: string
          number: number
          session_id: string | null
          created_at: string
        },
        [string]
      >(
        'SELECT cwd,head_commit,exit_code,kind,number,session_id,created_at FROM probe WHERE record_id=?',
      )
      .get(ref.recordId)
    const unresolvedFlag = `--artifact ${ref.kind}:${ref.recordId}`
    if (!row) throw new Error(`${unresolvedFlag} does not exist`)
    const flag = `--artifact ${ref.kind}:${row.number}`
    if (row.kind !== ref.kind) throw new Error(`${flag} is recorded as ${row.kind}:${row.number}`)
    requireCommandArtifactCheckout(requireCommandCheckout, flag, row, identity, resolveCheckout)
    return { ref: raw, exists: true }
  }
  if (ref.kind === 'run') {
    const recordId = resolveRunArtifactIdentifier(ref.id, raw, d)
    const run = loadRunBinding(recordId, d)
    if (!run) throw new Error(`--artifact ${raw} does not exist`)
    await requireRunBinding(`--artifact ${raw}`, run, identity, binding.cursorId, d)
    return {
      ref: raw,
      exists: true,
    }
  }
  if (ref.kind === 'note') throw new Error('note artifacts resolve through the note evidence port')
  return await resolveTaskArtifact(ref, raw, identity, ports, hasTrackerTransitionFloor)
}

function gatherTask(
  key: string,
  identity: CursorIdentity,
  d: Database,
  ports: FloorEvidencePorts,
): ValidatedEvidence['task'] {
  if (!ports.readTask)
    throw new Error(`--task ${key} needs a ${PLATFORM_SLUG} task read and no reader was provided`)
  const task = invokeFloorEvidencePort(ports, 'readTask', ports.readTask, key, {
    fresh: true,
  })
  if (
    identity.workflowTaskRecordId
      ? task.recordId !== identity.workflowTaskRecordId
      : Boolean(identity.workflowKey) && key !== identity.workflowKey
  )
    throw new Error(`--task ${key} is not this cursor's task ${identity.workflowKey}`)
  const trackerStates = projectByName(identity.project, d)?.settings.tracker?.states ?? {}
  const branch = branchForTaskKey(identity.project, task.key, identity.branch, d)
  const number = branch ? pullRequestNumberForBranch(identity.project, branch, d) : null
  let mergedPullRequest: boolean | null = null
  let pullRequestUnavailable:
    | NonNullable<NonNullable<ValidatedEvidence['task']>['pullRequestUnavailable']>
    | undefined
  if (number !== null) {
    try {
      const fallback = productionFloorPorts().viewPullRequest!
      const view = invokeFloorEvidencePort(
        ports,
        'viewPullRequest',
        fallback,
        identity.project,
        number,
      )
      mergedPullRequest = view.state === 'MERGED'
    } catch (error) {
      rethrowFloorEvidencePortMiss(error)
      const detail = error instanceof Error ? error.message : String(error)
      pullRequestUnavailable = {
        kind: 'read-error',
        reason: detail.split(/\r?\n/, 1)[0]?.trim() || 'pull request read failed',
      }
    }
  } else {
    const taskBranch = branch ?? identity.branch ?? '<branch>'
    pullRequestUnavailable = {
      kind: 'unrecorded',
      reason: `no pull request is recorded for task branch ${taskBranch}`,
      branch: taskBranch,
    }
  }
  return {
    key: task.key,
    status: task.status,
    statusCategory: task.statusCategory,
    mergedPullRequest,
    ...(pullRequestUnavailable ? { pullRequestUnavailable } : {}),
    trackerStates,
  }
}

async function gatherSatisfy(
  id: string,
  cursorId: string,
  d: Database,
  taskFlowClient?: Parameters<typeof taskFlowReadStore>[1],
): Promise<ValidatedEvidence['satisfy']> {
  const store = taskFlowReadStore(d, taskFlowClient)
  const row = await store.obligationByRecordId(id)
  if (!row) return { id, found: false }
  const floor = floorFromObligationRow(row)
  const handoffLinks = await taskFlowHandoffLinks(store, [cursorId])
  return {
    id,
    found: true,
    open: row.satisfied_at === null && row.abandoned_at === null,
    abandoned: row.abandoned_at !== null,
    cursorMatches: resolveWorkflowCursorSuccessor(row.cursor_record_id, handoffLinks) === cursorId,
    floor,
  }
}

async function gatheredCommandEvidence(
  kind: 'probe' | 'exec',
  id: number,
  recordId: string,
  row: {
    command: string
    cwd: string
    head_commit: string | null
    exit_code: number
    session_id: string | null
    created_at: string
    output_tail: string
    withheld: number
    command_withheld: number
  },
  identity: CursorIdentity,
  cursorId: string,
  d: Database,
  checkout: CheckoutResolution,
  ports: FloorEvidencePorts,
): Promise<Pick<ValidatedArtifactEvidence, 'probe' | 'exec' | 'pullRequest'>> {
  if (kind === 'probe') return { probe: { id, exitCode: row.exit_code } }
  const session = await sessionOrAdopterFor(cursorId, identity.session, row.session_id, d)
  const argv = recordedArgv(row.command)
  const commandIdentity = bottegaCommandIdentity(argv?.[0], row.cwd, d)
  const url = pullRequestCreateArgv(argv, commandIdentity)
    ? githubPullRequestUrlIn(row.output_tail)
    : undefined
  const exec: NonNullable<ValidatedArtifactEvidence['exec']> = {
    id,
    recordId,
    command: recordedCommand(row.command),
    argv,
    commandIdentity,
    exitCode: row.exit_code,
    sessionMatches: session.sessionMatches,
    sessionAdoptedCursor: session.sessionAdoptedCursor,
    createdAfterStepActivation: createdAfterStepActivation(
      row.created_at,
      identity.stepActivatedAt,
    ),
    checkoutLocation: classifyCheckoutResolution(checkout),
    headCommit: row.head_commit,
    cursorBranch: identity.branch,
    output: row.output_tail,
    outputWithheld: row.withheld === 1,
    commandWithheld: row.command_withheld === 1,
  }
  if (!url) return { exec }
  try {
    return {
      exec,
      pullRequest: gatherPullRequestArtifactEvidence(
        url,
        identity,
        d,
        ports,
        `--artifact exec:${id}`,
      ),
    }
  } catch (error) {
    rethrowFloorEvidencePortMiss(error)
    const detail = error instanceof Error ? error.message : String(error)
    return {
      exec: {
        ...exec,
        pullRequestCondition: detail.startsWith('--artifact ')
          ? detail
          : `--artifact exec:${id}: ${detail}`,
      },
    }
  }
}

function realpathIfPresent(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

export function bottegaCommandIdentity(
  executable: string | undefined,
  cwd: string,
  d: Database,
): BottegaCommandIdentity | undefined {
  if (!executable) return undefined
  const resolvedCandidate = realpathIfPresent(
    isAbsolute(executable) ? executable : resolve(cwd, executable),
  )
  const mainCheckout = projectByName(PLATFORM_SLUG, d)?.path
  const mainCheckoutExecutable = mainCheckout
    ? realpathIfPresent(join(mainCheckout, 'bin', PLATFORM_SLUG))
    : null
  const installed = installedBottegaExecutable()
  const installedExecutable = installed ? realpathIfPresent(installed) : null
  return { resolvedCandidate, mainCheckoutExecutable, installedExecutable }
}

function recordedArgv(raw: string): string[] | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value
  } catch {
    // Older and withheld records are not structured argv.
  }
  return null
}

function recordedCommand(value: string): string {
  return recordedArgv(value)?.join(' ') ?? value
}

function offeredArtifactRunEvidence(
  parsed: ArtifactRef,
  d: Database,
): Pick<ValidatedArtifactEvidence, 'artifactRunOffered'> {
  if (parsed.kind === 'run') return { artifactRunOffered: parsed.id }
  if (parsed.kind === 'id') {
    const run = d.query('SELECT record_id FROM run WHERE number=?').get(parsed.id) as {
      record_id: string
    } | null
    if (run) return { artifactRunOffered: run.record_id }
  }
  return {}
}

function gatherTreeEvidence(
  identity: CursorIdentity,
  ports: FloorEvidencePorts,
): NonNullable<ValidatedEvidence['tree']> {
  return {
    project: identity.project,
    worktree: identity.worktree,
    commit: identity.worktree
      ? invokeFloorEvidencePort(
          ports,
          'resolveTreeCommit',
          (worktree) => gitText(worktree, ['rev-parse', 'HEAD']),
          identity.worktree,
        )
      : null,
  }
}

function evidenceCheckoutResolver(
  identity: CursorIdentity,
  ports: FloorEvidencePorts,
  d: Database,
): NonNullable<FloorEvidencePorts['resolveCheckout']> {
  return (cwd, head, branch) =>
    invokeFloorEvidencePort(
      ports,
      'resolveCheckout',
      (at, commit, expected) => productionResolveCheckout(at, commit, expected, identity, d),
      cwd,
      head,
      branch,
    )
}

type GatherValidatedEvidenceInput = {
  cursorId: string
  cursorState: CursorState
  identity: CursorIdentity
  stepOrdinal: number
  stepSlug: string
  floors: Floor[]
  evidence: WorkflowEvidenceInput
  ports?: FloorEvidencePorts
  d?: Database
  taskFlowClient?: Parameters<typeof taskFlowReadStore>[1]
}

async function gatherCommandArtifactEntry(
  parsed: Extract<ArtifactRef, { kind: 'probe' | 'exec' }>,
  entry: ValidatedArtifactEvidence,
  input: GatherValidatedEvidenceInput,
  d: Database,
  ports: FloorEvidencePorts,
  resolveCheckout: NonNullable<FloorEvidencePorts['resolveCheckout']>,
): Promise<void> {
  const row = d
    .query<
      {
        number: number
        command: string
        cwd: string
        head_commit: string | null
        exit_code: number
        session_id: string | null
        created_at: string
        output_tail: string
        withheld: number
        command_withheld: number
      },
      [string]
    >(
      'SELECT number,command,cwd,head_commit,exit_code,session_id,created_at,output_tail,withheld,command_withheld FROM probe WHERE record_id=?',
    )
    .get(parsed.recordId)!
  const checkout = resolveCheckout(row.cwd, row.head_commit, input.identity.branch)
  Object.assign(
    entry,
    await gatheredCommandEvidence(
      parsed.kind,
      row.number,
      parsed.recordId,
      row,
      input.identity,
      input.cursorId,
      d,
      checkout,
      ports,
    ),
  )
}

async function gatherArtifactEntry(
  offeredArtifact: string,
  input: GatherValidatedEvidenceInput,
  gathered: ValidatedEvidence,
  d: Database,
  ports: FloorEvidencePorts,
  resolveCheckout: NonNullable<FloorEvidencePorts['resolveCheckout']>,
): Promise<ValidatedArtifactEvidence> {
  const parsed = parseArtifactRef(offeredArtifact, input.identity.project)
  if ('error' in parsed) throw new Error(parsed.error)
  const noteEvidence =
    parsed.kind === 'note'
      ? await gatherNoteArtifactEvidence(
          parsed,
          offeredArtifact,
          input.identity.project,
          input.identity.stepActivatedAt,
          ports,
        )
      : undefined
  const entry: ValidatedArtifactEvidence = {
    artifact: noteEvidence
      ? noteEvidence.artifact
      : await resolveArtifact(
          parsed,
          offeredArtifact,
          input.identity,
          {
            cursorId: input.cursorId,
            stepOrdinal: input.stepOrdinal,
            stepSlug: input.stepSlug,
          },
          d,
          ports,
          resolveCheckout,
          gathered.tree!.commit,
          floorsAcceptCommandArtifact(input.floors),
          floorsIncludeTrackerTransition(input.floors),
        ),
    ...offeredArtifactRunEvidence(parsed, d),
  }
  if (noteEvidence) {
    entry.note = noteEvidence.note
    if (!gathered.notes) gathered.notes = []
    gathered.notes.push(noteEvidence.note)
  }
  if (parsed.kind === 'pull-request')
    entry.pullRequest = gatherPullRequestArtifactEvidence(parsed.url, input.identity, d, ports)
  if (parsed.kind === 'probe' || parsed.kind === 'exec')
    await gatherCommandArtifactEntry(parsed, entry, input, d, ports, resolveCheckout)
  return entry
}

async function gatherArtifactEvidence(
  input: GatherValidatedEvidenceInput,
  gathered: ValidatedEvidence,
  d: Database,
  ports: FloorEvidencePorts,
  resolveCheckout: NonNullable<FloorEvidencePorts['resolveCheckout']>,
): Promise<void> {
  const seen = new Set<string>()
  for (const artifact of input.evidence.artifacts ?? []) {
    if (!artifact.trim()) continue
    const offeredArtifact = resolvedOfferedArtifact(d, artifact)
    if (seen.has(offeredArtifact)) continue
    seen.add(offeredArtifact)
    if (!gathered.artifacts) gathered.artifacts = []
    gathered.artifacts.push(
      await gatherArtifactEntry(offeredArtifact, input, gathered, d, ports, resolveCheckout),
    )
  }
}

export async function gatherValidatedEvidenceBase(
  input: GatherValidatedEvidenceInput,
): Promise<ValidatedEvidence> {
  const { d = db(), ports = {} } = input
  const resolveCheckout = evidenceCheckoutResolver(input.identity, ports, d)
  const gathered: ValidatedEvidence = {}
  gathered.tree = gatherTreeEvidence(input.identity, ports)
  if (
    input.identity.workflowKey &&
    input.floors.some((floor) => floor.kind === 'task-open-with-notes')
  )
    gathered.promotedNotes = await gatherPromotedNotes(
      input.identity.project,
      input.identity.workflowKey,
      ports,
    )
  const ruling = positiveEvidenceId(input.evidence.ruling, '--ruling')
  const review = input.evidence.review
  const gateRecordId = resolveOfferedGate(d, input.evidence.gate)
  const { run, satisfies } = input.evidence
  const n = hasGateFloor(input.floors) && gatherPassingGateForTree(gathered.tree, d)
  if (n !== false) gathered.passingGateForTree = n == null ? n : { number: n }
  if (ruling)
    gathered.ruling = await gatherRuling(
      ruling,
      input.cursorId,
      input.stepOrdinal,
      input.stepSlug,
      d,
    )
  if (review) gathered.review = gatherReview(resolveReviewIdentifier(d, review), input.identity, d)
  if (gateRecordId)
    gathered.gate = await gatherGate(
      gateRecordId,
      input.identity,
      input.cursorId,
      resolveCheckout,
      d,
    )
  if (run) {
    gathered.runOffered = run
    gathered.run = await gatherRun(run, input.identity, input.cursorId, d)
  }
  await gatherArtifactEvidence(input, gathered, d, ports, resolveCheckout)
  if (input.evidence.task?.trim())
    gathered.task = gatherTask(input.evidence.task.trim(), input.identity, d, ports)
  if (input.evidence.defer?.trim()) gathered.deferReason = input.evidence.defer.trim()
  if (satisfies)
    gathered.satisfy = await gatherSatisfy(satisfies, input.cursorId, d, input.taskFlowClient)
  if (
    input.floors.some((floor) => floor.kind === 'class-measured') ||
    (gathered.satisfy?.found && gathered.satisfy.floor.kind === 'class-measured')
  )
    gathered.registeredCheckoutRoots = registeredCheckoutRoots(d)
  return gathered
}
