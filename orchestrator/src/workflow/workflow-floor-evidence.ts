// concern: workflows
/** Gathers recorded rows that a floor decision may consume. Must not decide satisfaction. */

import type { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { docScopeHasProjectSubject, docScopeIsProjectless } from '../../../shared/docs.ts'
import { githubRepository } from '../../../shared/github-repository.ts'
import { withholdSecretShapedDetail } from '../../../shared/secret-shaped.ts'
import { bottegaEntryArgv, installedBottegaExecutable } from '../../../shared/self-spawn.ts'
import { runArtifactsDir, runScratchReplyPath } from '../artifact-paths.ts'
import { viewPullRequest } from '../branch/merged-pull-request.ts'
import { branchForTaskKey, pullRequestNumberForBranch } from '../branch/task-key-pull-request.ts'
import { resolveRunsDirectory } from '../database/database-location.ts'
import { db } from '../database/db.ts'
import { resolveDocReference } from '../doc/doc-reference-read.ts'
import { landingGatePurposeRefusal, resolveGateIdentifier } from '../gate/gate-identifier.ts'
import { projectByName } from '../project/projects.ts'
import {
  reviewRoundTriageComplete,
  reviewsForTriage,
  type TriageReviewRow,
} from '../review/review-group.ts'
import { resolveReviewIdentifier } from '../review/review-identifier.ts'
import { reviewLineage } from '../review/review-lineage-store.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import { parseProbeArtifact, resolveProbeArtifact } from './probe-identifier.ts'
import {
  type CheckoutResolution,
  checkoutOutsideChangeRefusal,
  classifyCheckoutEvidence,
} from './workflow-checkout-refusal.ts'
import {
  type ArtifactRef,
  type BottegaCommandIdentity,
  DEFAULT_EXPECTED_EXIT_CODE,
  DEFAULT_EXPECTED_STATUS,
  type Floor,
  flagForFloor,
  githubPullRequestUrlIn,
  isFloorKind,
  type OpenObligation,
  parseArtifactRef,
  pullRequestCreateArgv,
  type ValidatedEvidence,
} from './workflow-floor.ts'
import { gitText, productionResolveCheckout } from './workflow-floor-evidence-checkout.ts'
import {
  type FloorEvidencePorts,
  invokeFloorEvidencePort,
  rethrowFloorEvidencePortMiss,
} from './workflow-floor-evidence-replay.ts'
import { type HubTaskRead, hubTaskReadFromJson } from './workflow-floor-task-read.ts'
import {
  type BoundRun,
  decideRunBinding,
  type SessionMatch,
  sessionOrAdopterMatch,
} from './workflow-run-binding.ts'
import { attachedTextReferenceMeetsFloor, type WorkflowTextRow } from './workflow-text.ts'

export type { FloorEvidencePorts } from './workflow-floor-evidence-replay.ts'

export type WorkflowEvidenceInput = {
  ruling?: number
  review?: string
  gate?: string | number
  run?: string
  artifact?: string
  task?: string
  defer?: string
  satisfies?: string
}

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

export function openWorkflowObligations(cursorId: string, d: Database): OpenObligation[] {
  return d
    .query<OpenObligation, [string]>(
      `SELECT record_id id, step_ordinal AS stepOrdinal, step_slug AS stepSlug, floor
         FROM workflow_obligation
        WHERE cursor_record_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL ORDER BY rowid`,
    )
    .all(cursorId)
}

function readHubTask(key: string, cwd = process.cwd()): HubTaskRead {
  const [hub, ...prefix] = bottegaEntryArgv(PLATFORM_SLUG)
  const result = spawnSync(hub!, [...prefix, 'task', 'show', key, '--json', '--fresh'], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(hubTaskReadRefusal(key, result.status, result.stderr, result.stdout))
  }
  return hubTaskReadFromJson(key, JSON.parse(result.stdout))
}

export function hubTaskReadRefusal(
  key: string,
  status: number | null,
  stderr: string,
  stdout: string,
): string {
  const rawDetail = stderr.trim() || stdout.trim() || `${PLATFORM_SLUG} exited ${status}`
  const detail = withholdSecretShapedDetail(rawDetail)
  const attempted = `${PLATFORM_SLUG} task show ${key} --json --fresh`
  if (
    rawDetail.split('\n').some((line) => {
      const text = line.trim()
      return text === `no task ${key}` || text.includes(`task ${key} was not found in project`)
    })
  )
    return `--task ${key} was not found in the project's tracker; ${attempted} attempted the registered tracker read: ${detail}`
  return `--task ${key} could not be read through the project's tracker by ${attempted}: ${detail}`
}

export const productionFloorPorts = (): FloorEvidencePorts => ({
  readTask: (key) => readHubTask(key),
  runHasArtifacts: runHasRecordedArtifacts,
  viewPullRequest: (project, number) => {
    const row = projectByName(project)
    if (!row)
      throw new Error(`project ${project} is not registered; cannot view pull request ${number}`)
    return viewPullRequest(row, number)
  },
  readOriginUrl: (project) => {
    const row = projectByName(project)
    if (!row) throw new Error(`project ${project} is not registered; cannot read its origin`)
    return gitText(row.path, ['remote', 'get-url', 'origin'])
  },
})

function runHasRecordedArtifacts(
  runId: string,
  runsDir = resolveRunsDirectory(process.env),
): boolean {
  const recordId = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
    .get(runId)?.record_id
  if (!recordId) return false
  const artifacts = runArtifactsDir(recordId, runsDir)
  const reply = runScratchReplyPath(recordId, runsDir)
  if (existsSync(reply)) return true
  return existsSync(artifacts) && readdirSync(artifacts).length > 0
}

function positive(value: number | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`)
  return value
}

function gatherRuling(
  id: number,
  cursorId: string,
  stepOrdinal: number,
  stepSlug: string,
  d: Database,
): ValidatedEvidence['ruling'] {
  const row = d
    .query<
      {
        id: string
        answered_at: string | null
        answerer_kind: string | null
        workflow_cursor_record_id: string | null
        workflow_step_ordinal: number | null
        workflow_step_slug: string | null
      },
      [number]
    >(
      `SELECT number id,answered_at,answerer_kind,workflow_cursor_record_id,workflow_step_ordinal,workflow_step_slug
         FROM question WHERE number=?`,
    )
    .get(id)
  if (!row) throw new Error(`--ruling ${id} does not exist`)
  return {
    id,
    answered: row.answered_at !== null,
    answeredByOperator: row.answerer_kind === 'operator',
    boundToCursor: row.workflow_cursor_record_id === cursorId,
    boundToStep: row.workflow_step_ordinal === stepOrdinal && row.workflow_step_slug === stepSlug,
    answeredAt: row.answered_at,
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
        path_set: string | null
      },
      [string]
    >(
      `SELECT r.record_id,r.number, p.name AS project_name, r.patch_id, r.path_set
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

function loadAdoptionReasons(
  cursorId: string,
  actorSession: string,
  d: Database,
): Array<string | null> {
  return d
    .query<{ reason: string | null }, [string, string]>(
      `SELECT a.reason
         FROM question q JOIN question_mutation_audit a ON a.question_record_id=q.record_id
        WHERE q.workflow_cursor_record_id=? AND a.action='rule' AND a.actor_session=?`,
    )
    .all(cursorId, actorSession)
    .map(({ reason }) => reason)
}

function sessionOrAdopterFor(
  cursorId: string,
  cursorSession: string | null,
  actorSession: string | null,
  d: Database,
): SessionMatch {
  const adoptionReasons =
    cursorSession !== null && actorSession !== null
      ? loadAdoptionReasons(cursorId, actorSession, d)
      : []
  return sessionOrAdopterMatch({
    cursorSession,
    actorSession,
    adoptionReasons,
  })
}

function requireRunBinding(
  flag: string,
  run: BoundRun,
  identity: CursorIdentity,
  cursorId: string,
  d: Database,
): void {
  const session = sessionOrAdopterFor(cursorId, identity.session, run.sessionId, d)
  const refusal = decideRunBinding({ flag, run, identity, ...session })
  if (refusal) throw new Error(refusal)
}

function requireCheckout(
  flag: string,
  cwd: string,
  headCommit: string | null,
  identity: CursorIdentity,
  resolveCheckout: FloorEvidencePorts['resolveCheckout'],
  requireOnBranch: boolean,
): CheckoutResolution {
  if (!resolveCheckout)
    throw new Error(`${flag} cwd project is unset, not this cursor's ${identity.project}`)
  const checkout = resolveCheckout(cwd, headCommit, identity.branch)
  if (checkout.project !== identity.project)
    throw new Error(
      `${flag} cwd project is ${checkout.project ?? 'unset'}, not this cursor's ${identity.project}`,
    )
  const location = classifyCheckoutEvidence({
    headIsTipOrAncestor: checkout.headIsTipOrAncestor,
    landingCommit: checkout.landingCommit ?? null,
    landingIsHeadOrAncestor: checkout.landingIsHeadOrAncestor ?? false,
    recordedLandingTip: checkout.recordedLandingTip,
    headIsRecordedTipOrAncestor: checkout.headIsRecordedTipOrAncestor,
    landingIsOnTrunk: checkout.landingIsOnTrunk,
  })
  if (
    requireOnBranch &&
    identity.branch &&
    checkout.branch !== identity.branch &&
    location !== 'post-landing'
  )
    throw new Error(
      `${flag} cwd is on ${checkout.branch ?? 'unset'}, not this cursor's ${identity.branch}`,
    )
  if (identity.branch && location === 'outside-change')
    throw new Error(
      checkoutOutsideChangeRefusal(flag, identity.branch, checkout.checkoutPath, checkout),
    )
  return checkout
}

function gatherGate(
  recordId: string,
  identity: CursorIdentity,
  cursorId: string,
  resolveCheckout: FloorEvidencePorts['resolveCheckout'],
  d: Database,
): ValidatedEvidence['gate'] {
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
    requireRunBinding(flag, run, identity, cursorId, d)
    project = run.project
  } else {
    if (!row.cwd) throw new Error(`${flag} architect row has no cwd`)
    project = requireCheckout(
      flag,
      row.cwd,
      row.head_commit,
      identity,
      resolveCheckout,
      true,
    ).project
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

function gatherRun(
  id: string,
  identity: CursorIdentity,
  cursorId: string,
  d: Database,
): ValidatedEvidence['run'] {
  const row = d
    .query<{ status: string; exit_code: number | null }, [string]>(
      'SELECT status,exit_code FROM run WHERE record_id=?',
    )
    .get(id)
  if (!row) throw new Error(`--run ${id} does not exist`)
  const binding = loadRunBinding(id, d)
  if (!binding) throw new Error(`--run ${id} does not exist`)
  requireRunBinding(`--run ${id}`, binding, identity, cursorId, d)
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

function resolveDocArtifact(value: string, identity: CursorIdentity, d: Database): string {
  const row = resolveDocReference(value, d)
  const flag = `--artifact doc:${value}`
  if (!row)
    throw new Error(
      `${flag} does not exist; use doc:<scope>/<subject-or-_>/<slug> or doc:<document-UUID>`,
    )
  if (!docAdmissibleAsCursorEvidence(row, identity.project))
    throw new Error(
      `${flag} is scoped to ${row.projectName ?? row.subject ?? row.scope}, not this cursor's ${identity.project}`,
    )
  return row.address
}

function resolveRunArtifactIdentifier(input: string, raw: string, d: Database): string {
  try {
    return resolveRunIdentifier(d, input)
  } catch {
    throw new Error(`--artifact ${raw} is not a run; pass ${flagForFloor('recorded-artifact')}`)
  }
}

function resolveNumericArtifact(
  id: number,
  identity: CursorIdentity,
  cursorId: string,
  d: Database,
  runHasArtifacts: (runId: string) => boolean,
): { ref: string; exists: boolean } {
  const run = d.query('SELECT record_id FROM run WHERE number=?').get(id) as {
    record_id: string
  } | null
  const runOk = run !== null && runHasArtifacts(run.record_id)
  if (run) {
    const binding = loadRunBinding(run.record_id, d)
    if (!binding) throw new Error(`--artifact ${id} is not a run with artifacts or a reply`)
    requireRunBinding(`--artifact ${id}`, binding, identity, cursorId, d)
    return { ref: String(id), exists: runOk }
  }
  throw new Error(`--artifact ${id} is not a run with artifacts or a reply`)
}

function resolveTaskArtifact(
  ref: Extract<ArtifactRef, { kind: 'task' | 'comment' }>,
  raw: string,
  identity: CursorIdentity,
  ports: FloorEvidencePorts,
): { ref: string; exists: boolean } {
  if (!ports.readTask)
    throw new Error(
      `--artifact ${raw} needs a ${PLATFORM_SLUG} task read and no reader was provided`,
    )
  const task = invokeFloorEvidencePort(ports, 'readTask', ports.readTask, ref.key, { fresh: true })
  if (
    identity.workflowTaskRecordId
      ? task.recordId !== identity.workflowTaskRecordId
      : Boolean(identity.workflowKey) && ref.key !== identity.workflowKey
  )
    throw new Error(`--artifact ${raw} task is not this cursor's ${identity.workflowKey}`)
  if (ref.kind === 'task') return { ref: raw, exists: task.key === ref.key }
  if (task.commentsVerifiable === false)
    throw new Error(
      `--artifact ${raw} cannot be verified because this tracker's task read does not report comment ids; use --artifact task:${ref.key} to verify the task instead`,
    )
  if (!task.commentIds.map(String).includes(ref.id))
    throw new Error(`--artifact ${raw} is not a comment on ${ref.key}`)
  return { ref: raw, exists: true }
}

function resolveArtifact(
  ref: ArtifactRef,
  raw: string,
  identity: CursorIdentity,
  binding: { cursorId: string; stepOrdinal: number; stepSlug: string },
  d: Database,
  ports: FloorEvidencePorts,
  resolveCheckout: FloorEvidencePorts['resolveCheckout'],
): { ref: string; exists: boolean } {
  if (ref.kind === 'attached-text') {
    const row = d
      .query<
        {
          id: string
          cursor_record_id: string
          step_ordinal: number
          step_slug: string
          body: string
        },
        [string]
      >(
        `SELECT record_id id,cursor_record_id,step_ordinal,step_slug,body
           FROM workflow_step_text WHERE record_id=?`,
      )
      .get(ref.id)
    const attachment: WorkflowTextRow | null = row
      ? {
          id: row.id,
          cursorId: row.cursor_record_id,
          stepOrdinal: row.step_ordinal,
          stepSlug: row.step_slug,
          body: row.body,
        }
      : null
    return {
      ref: 'attached-text',
      exists: attachedTextReferenceMeetsFloor({
        ...binding,
        attachment,
      }),
    }
  }
  if (ref.kind === 'id')
    return resolveNumericArtifact(
      ref.id,
      identity,
      binding.cursorId,
      d,
      ports.runHasArtifacts ?? runHasRecordedArtifacts,
    )
  if (ref.kind === 'doc') {
    return { ref: `doc:${resolveDocArtifact(ref.address, identity, d)}`, exists: true }
  }
  if (ref.kind === 'pull-request') return { ref: ref.url, exists: true }
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
    requireCheckout(flag, row.cwd, row.head_commit, identity, resolveCheckout, false)
    return { ref: raw, exists: true }
  }
  if (ref.kind === 'run') {
    const recordId = resolveRunArtifactIdentifier(ref.id, raw, d)
    const run = loadRunBinding(recordId, d)
    if (!run) throw new Error(`--artifact ${raw} does not exist`)
    requireRunBinding(`--artifact ${raw}`, run, identity, binding.cursorId, d)
    return {
      ref: raw,
      exists: (ports.runHasArtifacts ?? runHasRecordedArtifacts)(recordId),
    }
  }
  return resolveTaskArtifact(ref, raw, identity, ports)
}

function pullRequestEvidence(
  url: string,
  identity: CursorIdentity,
  d: Database,
  ports: FloorEvidencePorts,
  flag = `--artifact ${url}`,
): NonNullable<ValidatedEvidence['pullRequest']> {
  const project = projectByName(identity.project, d)
  if (!project) throw new Error(`project ${identity.project} is not registered`)
  const trunk = project.settings.trunk?.trim()
  if (!identity.branch || !trunk)
    throw new Error(
      `${flag} cannot be checked because this cursor has no branch or its project has no trunk`,
    )
  const fallback = productionFloorPorts().viewPullRequest!
  const view = invokeFloorEvidencePort(ports, 'viewPullRequest', fallback, identity.project, url)
  if (view.url.replace(/\/$/, '') !== url.replace(/\/$/, ''))
    throw new Error(`${flag} resolved as ${view.url}, not the supplied pull-request link`)
  const originUrl = invokeFloorEvidencePort(
    ports,
    'readOriginUrl',
    () => gitText(project.path, ['remote', 'get-url', 'origin']),
    identity.project,
  )
  return {
    url: view.url,
    repository: githubRepository(view.url.replace(/\/pull\/\d+\/?$/i, '')),
    projectRepository: githubRepository(originUrl),
    state: view.state,
    head: view.headRefName,
    base: view.baseRefName,
    cursorBranch: identity.branch,
    trunk,
  }
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

function gatherSatisfy(id: string, cursorId: string, d: Database): ValidatedEvidence['satisfy'] {
  const row = d
    .query<
      {
        id: number
        cursor_record_id: string
        floor: string
        require_pull_request: number
        operator_ruling: number
        expected_exit_code: number
        expected_status: string
        floor_deferrable: number
        satisfied_at: string | null
        abandoned_at: string | null
      },
      [string]
    >(
      `SELECT record_id id,cursor_record_id,floor,require_pull_request,operator_ruling,expected_exit_code,expected_status,floor_deferrable,
              satisfied_at,abandoned_at
         FROM workflow_obligation WHERE record_id=?`,
    )
    .get(id)
  if (!row) return { id, found: false }
  if (!isFloorKind(row.floor))
    throw new Error(`--satisfies ${id} records unknown floor kind "${row.floor}"`)
  const floor: Floor = {
    kind: row.floor,
    deferrable: row.floor_deferrable === 1,
    expectedExitCode: row.expected_exit_code ?? DEFAULT_EXPECTED_EXIT_CODE,
    expectedStatus: row.expected_status ?? DEFAULT_EXPECTED_STATUS,
    requirePullRequest: row.require_pull_request === 1,
    operatorRuling: row.operator_ruling === 1,
  }
  return {
    id,
    found: true,
    open: row.satisfied_at === null && row.abandoned_at === null,
    abandoned: row.abandoned_at !== null,
    cursorMatches: row.cursor_record_id === cursorId,
    floor,
  }
}

function gatheredCommandEvidence(
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
): Pick<ValidatedEvidence, 'probe' | 'exec' | 'pullRequest'> {
  if (kind === 'probe') return { probe: { id, exitCode: row.exit_code } }
  const session = sessionOrAdopterFor(cursorId, identity.session, row.session_id, d)
  const argv = recordedArgv(row.command)
  const commandIdentity = bottegaCommandIdentity(argv?.[0], row.cwd, d)
  const url = pullRequestCreateArgv(argv, commandIdentity)
    ? githubPullRequestUrlIn(row.output_tail)
    : undefined
  const exec: NonNullable<ValidatedEvidence['exec']> = {
    id,
    recordId,
    command: recordedCommand(row.command),
    argv,
    commandIdentity,
    exitCode: row.exit_code,
    sessionMatches: session.sessionMatches,
    sessionAdoptedCursor: session.sessionAdoptedCursor,
    createdAfterStepActivation: row.created_at >= identity.stepActivatedAt,
    checkoutBranch: checkout.branch,
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
      pullRequest: pullRequestEvidence(url, identity, d, ports, `--artifact exec:${id}`),
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
): Pick<ValidatedEvidence, 'artifactRunOffered'> {
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

function resolvedOfferedArtifact(d: Database, artifact: string): string {
  const offered = artifact.trim()
  try {
    const parsed = parseProbeArtifact(offered)
    return parsed?.identifier.kind === 'number' ? resolveProbeArtifact(d, offered)! : offered
  } catch {
    return offered
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

export function gatherValidatedEvidence(input: {
  cursorId: string
  identity: CursorIdentity
  stepOrdinal: number
  stepSlug: string
  evidence: WorkflowEvidenceInput
  ports?: FloorEvidencePorts
  d?: Database
}): ValidatedEvidence {
  const d = input.d ?? db()
  const ports = input.ports ?? {}
  const resolveCheckout = evidenceCheckoutResolver(input.identity, ports, d)
  const gathered: ValidatedEvidence = {}
  gathered.tree = gatherTreeEvidence(input.identity, ports)
  const ruling = positive(input.evidence.ruling, '--ruling')
  const review = input.evidence.review
  const gateRecordId = resolveOfferedGate(d, input.evidence.gate)
  const run = input.evidence.run
  const satisfies = input.evidence.satisfies
  if (ruling)
    gathered.ruling = gatherRuling(ruling, input.cursorId, input.stepOrdinal, input.stepSlug, d)
  if (review) gathered.review = gatherReview(resolveReviewIdentifier(d, review), input.identity, d)
  if (gateRecordId)
    gathered.gate = gatherGate(gateRecordId, input.identity, input.cursorId, resolveCheckout, d)
  if (run) {
    gathered.runOffered = run
    gathered.run = gatherRun(run, input.identity, input.cursorId, d)
  }
  if (input.evidence.artifact?.trim()) {
    const offeredArtifact = resolvedOfferedArtifact(d, input.evidence.artifact)
    const parsed = parseArtifactRef(offeredArtifact)
    if ('error' in parsed) throw new Error(parsed.error)
    gathered.artifact = resolveArtifact(
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
    )
    Object.assign(gathered, offeredArtifactRunEvidence(parsed, d))
    if (parsed.kind === 'pull-request')
      gathered.pullRequest = pullRequestEvidence(parsed.url, input.identity, d, ports)
    if (parsed.kind === 'probe' || parsed.kind === 'exec') {
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
        gathered,
        gatheredCommandEvidence(
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
  }
  if (input.evidence.task?.trim())
    gathered.task = gatherTask(input.evidence.task.trim(), input.identity, d, ports)
  if (input.evidence.defer?.trim()) gathered.deferReason = input.evidence.defer.trim()
  if (satisfies) gathered.satisfy = gatherSatisfy(satisfies, input.cursorId, d)
  return gathered
}
