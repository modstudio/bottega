// concern: session close-out
/** Gathers one session's lifecycle inventory and delegates release to each existing owner. */

import type { Database } from 'bun:sqlite'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { branchesReport, pruneBranch } from '../branch/branches.ts'
import { observeTaskStatus } from '../branch/task-status-observation.ts'
import { reconcileAbsentClaims } from '../cleanup/claim-reconciliation.ts'
import type { CleanupPresentation } from '../cleanup/cleanup.ts'
import { closeOutRun } from '../close/close-out.ts'
import { sessionId as callingSessionId, db, writableDb } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { projectByName } from '../project/projects.ts'
import { currentOrphanProcesses } from '../resources/process-inventory.ts'
import { refGuardDirectory } from '../resources/ref-guard.ts'
import { parseRetainedRef } from '../resources/resource-inventory.ts'
import { isSyntheticLifecycleJob } from '../run/synthetic-lifecycle-job.ts'
import { observeGrokTrustHeadings } from '../sandbox/grok-trust.ts'
import { shipCleanup } from '../ship-cleanup/ship-cleanup.ts'
import {
  classifySessionCloseOut,
  plannedTreeOwnerMatches,
  type SessionHeldRunResources,
  type SessionMechanicalAction,
  type SessionOwnedBranch,
  type SessionOwnedRun,
  type SessionOwnershipFacts,
  sessionCloseOutVerdict,
  sessionOwnedRunIds,
} from './session-close-out-decision.ts'

export const SESSION_CLOSE_OUT_RESIDUE_EXIT_CODE = 1

type OwnedClaim = { id: number; kind: string; allocation_key: string; state: string }
type ActiveLanding = { record_id: string; project: string; branch: string; status: string }
type IncompleteReview = { record_id: string; number: number }

type UnprovedBranchEvidence = {
  project: string
  branch: string
  taskKey: string | null
  taskStatus: string
  commitsAhead: number
  patchEquivalence: string
  lastActivity: string | null
  liveRun: boolean
  liveTree: string | null
  remedy: string
}

export type SessionCloseOutReport = {
  session: string
  dryRun: boolean
  owned: {
    runs: SessionOwnedRun[]
    branches: SessionOwnedBranch[]
    claims: OwnedClaim[]
    landings: ActiveLanding[]
    reviews: IncompleteReview[]
  }
  mechanical: string[]
  process: { item: string; reason: string; evidence: string; remedy: string }[]
  errors: { item: string; detail: string; retry: string }[]
  verdict: { clean: boolean; residue: number }
}

type RunRow = {
  record_id: string
  parent_run_record_id: string | null
  number: number
  status: string
  job: string
  worktree: string | null
  project: string | null
  launch_key: string | null
  minted_branch: string | null
  session_id: string | null
}

function ownedRuns(database: Database, session: string): SessionOwnedRun[] {
  const identities = database
    .query('SELECT record_id,parent_run_record_id,session_id FROM run ORDER BY number')
    .all() as {
    record_id: string
    parent_run_record_id: string | null
    session_id: string | null
  }[]
  const ownedIds = sessionOwnedRunIds(
    session,
    identities.map((row) => ({
      recordId: row.record_id,
      parentRecordId: row.parent_run_record_id,
      sessionId: row.session_id,
    })),
  )
  if (!ownedIds.length) return []
  const placeholders = ownedIds.map(() => '?').join(',')
  const rows = database
    .query(
      `SELECT r.record_id,r.parent_run_record_id,r.number,r.status,r.job,r.worktree,r.session_id,
              p.name project,r.launch_key,r.minted_branch
         FROM run r LEFT JOIN project p ON p.record_id=r.project_record_id
        WHERE r.record_id IN (${placeholders})
        ORDER BY r.number`,
    )
    .all(...ownedIds) as RunRow[]
  return rows.map((row) => ({
    recordId: row.record_id,
    rootRecordId: row.parent_run_record_id ?? row.record_id,
    sessionId: row.session_id,
    number: row.number,
    status: row.status,
    architectTree: isSyntheticLifecycleJob(row.job),
    worktree: row.worktree,
    project: row.project,
    taskKey: row.launch_key,
    mintedBranch: row.minted_branch,
    dirty: row.worktree ? worktreeDirty(row.worktree) : false,
  }))
}

function worktreeDirty(path: string): boolean {
  if (!existsSync(path)) return false
  const result = Bun.spawnSync(['git', 'status', '--porcelain'], {
    cwd: path,
    env: targetGitEnvironment(path),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return result.exitCode !== 0 || result.stdout.length > 0
}

function ownedClaims(database: Database, roots: readonly string[]): OwnedClaim[] {
  if (!roots.length) return []
  const placeholders = roots.map(() => '?').join(',')
  return database
    .query(
      `SELECT id,kind,allocation_key,state FROM resource_claim
        WHERE root_run_record_id IN (${placeholders}) AND state='claimed' ORDER BY id`,
    )
    .all(...roots) as OwnedClaim[]
}

function activeLandings(database: Database, session: string): ActiveLanding[] {
  return database
    .query(
      `SELECT record_id,project,branch,status FROM landing
        WHERE session_id=? AND status IN ('queued','running') ORDER BY started_at`,
    )
    .all(session) as ActiveLanding[]
}

function incompleteReviews(database: Database, session: string): IncompleteReview[] {
  return database
    .query(
      `SELECT DISTINCT review.record_id,review.number FROM review
       JOIN review_lens lens ON lens.review_record_id=review.record_id
       JOIN run ON run.record_id=lens.run_record_id
       WHERE run.session_id=? AND
        (review.completed_at IS NULL OR EXISTS
          (SELECT 1 FROM review_finding finding
            WHERE finding.review_record_id=review.record_id AND finding.disposition IS NULL))
       ORDER BY review.number`,
    )
    .all(session) as IncompleteReview[]
}

function observeOwnedBranch(
  item: { project: string; branch: string; taskKey: string | null },
  runs: readonly SessionOwnedRun[],
  projectReport: ReturnType<typeof branchesReport>['projects'][number],
): { branch: SessionOwnedBranch; evidence: UnprovedBranchEvidence | null } | null {
  const row = projectReport.keys
    .flatMap((key) => key.branches)
    .find((branch) => branch.branch === item.branch)
  if (!row) return null
  const branch: SessionOwnedBranch = { ...item, state: row.state }
  if (row.state !== 'unlanded' && row.state !== 'unknown') return { branch, evidence: null }
  const project = projectByName(item.project)
  const lastActivity = project
    ? Bun.spawnSync(['git', 'show', '-s', '--format=%cI', row.tip], {
        cwd: project.path,
        env: targetGitEnvironment(project.path),
        stdout: 'pipe',
        stderr: 'pipe',
      })
        .stdout.toString()
        .trim() || null
    : null
  return {
    branch,
    evidence: {
      ...item,
      taskStatus: observeTaskStatus(item.taskKey, item.project).detail,
      commitsAhead: row.commitsNotOnTrunk,
      patchEquivalence:
        row.state === 'unknown' ? `unknown${row.error ? `: ${row.error}` : ''}` : 'none found',
      lastActivity,
      liveRun: row.liveRun,
      liveTree: row.checkedOut
        ? (runs.find(
            (run) =>
              run.project === item.project && run.mintedBranch === item.branch && run.worktree,
          )?.worktree ?? 'checked out')
        : null,
      remedy: `${PLATFORM_SLUG} tree branch dispose ${item.project}:${item.branch} --reason <abandoned|superseded|throwaway> --note "<why>"`,
    },
  }
}

function branchFacts(runs: readonly SessionOwnedRun[], dryRun: boolean) {
  const wanted = new Map<string, { project: string; branch: string; taskKey: string | null }>()
  for (const run of runs) {
    if (run.project && run.mintedBranch)
      wanted.set(`${run.project}\0${run.mintedBranch}`, {
        project: run.project,
        branch: run.mintedBranch,
        taskKey: run.taskKey,
      })
  }
  const branches: SessionOwnedBranch[] = []
  const evidence: UnprovedBranchEvidence[] = []
  const byProject = Map.groupBy(wanted.values(), (item) => item.project)
  for (const [project, items] of byProject) {
    const projectReport = branchesReport({
      project,
      repairLandings: !dryRun,
      dryRunLandingRepair: dryRun,
    }).projects[0]!
    for (const item of items) {
      const observation = observeOwnedBranch(item, runs, projectReport)
      if (!observation) continue
      branches.push(observation.branch)
      if (observation.evidence) evidence.push(observation.evidence)
    }
  }
  return { branches, evidence }
}

type ResourceObservationError = SessionCloseOutReport['errors'][number]
type ProjectRootResources = {
  rootRecordId: string
  memberRecordIds: string[]
}

function observeProjectHeldResources(
  name: string,
  projectRoots: readonly ProjectRootResources[],
): { guardRoots: string[]; retainedRoots: string[] } {
  const project = projectByName(name)
  if (!project) throw new Error('project is not registered')
  const guardDirectory = refGuardDirectory(project.path)
  if (!guardDirectory) throw new Error(`git common directory could not be read at ${project.path}`)
  const retained = Bun.spawnSync(
    ['git', 'for-each-ref', '--format=%(refname)', 'refs/orch/retained'],
    {
      cwd: project.path,
      env: targetGitEnvironment(project.path),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (retained.exitCode !== 0)
    throw new Error(
      `retained refs could not be read: ${retained.stderr.toString().trim() || `exit ${retained.exitCode}`}`,
    )
  const retainedIds = new Set(
    retained.stdout
      .toString()
      .split('\n')
      .flatMap((ref) => parseRetainedRef(ref) ?? []),
  )
  return {
    guardRoots: projectRoots
      .filter(({ memberRecordIds }) =>
        memberRecordIds.some((recordId) => existsSync(`${guardDirectory}/${recordId}`)),
      )
      .map(({ rootRecordId }) => rootRecordId),
    retainedRoots: projectRoots
      .filter(({ memberRecordIds }) =>
        memberRecordIds.some((recordId) => retainedIds.has(recordId.toLowerCase())),
      )
      .map(({ rootRecordId }) => rootRecordId),
  }
}

function heldGitRunResources(roots: ReadonlyMap<string, readonly SessionOwnedRun[]>): {
  guardRoots: Set<string>
  retainedRoots: Set<string>
  unknownRoots: Set<string>
  errors: ResourceObservationError[]
} {
  const guardRoots = new Set<string>()
  const retainedRoots = new Set<string>()
  const unknownRoots = new Set<string>()
  const errors: ResourceObservationError[] = []
  const byProject = Map.groupBy(
    [...roots].flatMap(([rootRecordId, members]) => {
      const name = members.find((member) => member.project)?.project
      return name
        ? [{ rootRecordId, memberRecordIds: members.map((member) => member.recordId), name }]
        : []
    }),
    (item) => item.name,
  )
  for (const [name, projectRoots] of byProject) {
    try {
      const observed = observeProjectHeldResources(name, projectRoots)
      for (const rootRecordId of observed.guardRoots) guardRoots.add(rootRecordId)
      for (const rootRecordId of observed.retainedRoots) retainedRoots.add(rootRecordId)
    } catch (cause) {
      for (const { rootRecordId } of projectRoots) unknownRoots.add(rootRecordId)
      errors.push({
        item: `project ${name}`,
        detail: `run resource state could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        retry: `${PLATFORM_SLUG} machine doctor`,
      })
    }
  }
  return { guardRoots, retainedRoots, unknownRoots, errors }
}

function heldRunResources(
  database: Database,
  runs: readonly SessionOwnedRun[],
): { resources: SessionHeldRunResources[]; errors: ResourceObservationError[] } {
  const roots = new Map<string, SessionOwnedRun[]>()
  for (const run of runs) roots.set(run.rootRecordId, [...(roots.get(run.rootRecordId) ?? []), run])
  if (!roots.size) return { resources: [], errors: [] }
  const placeholders = [...roots].map(() => '?').join(',')
  const claimedRoots = new Set(
    (
      database
        .query(
          `SELECT DISTINCT root_run_record_id FROM resource_claim
            WHERE root_run_record_id IN (${placeholders}) AND state='claimed'`,
        )
        .all(...roots.keys()) as { root_run_record_id: string }[]
    ).map((row) => row.root_run_record_id),
  )
  const { guardRoots, retainedRoots, unknownRoots, errors } = heldGitRunResources(roots)
  return {
    resources: [...roots].map(([rootRecordId, members]) => ({
      rootRecordId,
      worktree: members.some((member) => Boolean(member.worktree && existsSync(member.worktree))),
      refGuard: guardRoots.has(rootRecordId),
      retainedRef: retainedRoots.has(rootRecordId),
      claim: claimedRoots.has(rootRecordId),
      unknown: unknownRoots.has(rootRecordId),
    })),
    errors,
  }
}

function gather(database: Database, session: string, dryRun: boolean) {
  const runs = ownedRuns(database, session)
  const roots = [...new Set(runs.map((run) => run.rootRecordId))]
  const claims = ownedClaims(database, roots)
  const landings = activeLandings(database, session)
  const reviews = incompleteReviews(database, session)
  const branchInventory = branchFacts(runs, dryRun)
  const held = heldRunResources(database, runs)
  const facts: SessionOwnershipFacts = {
    session,
    runs,
    branches: branchInventory.branches,
    heldRunResources: held.resources,
    claimIds: claims.map((claim) => claim.id),
    landingIds: landings.map((landing) => landing.record_id),
    reviewIds: reviews.map((review) => review.record_id),
  }
  return {
    runs,
    claims,
    landings,
    reviews,
    observationErrors: held.errors,
    ...branchInventory,
    classification: classifySessionCloseOut(facts),
  }
}

const silentPresentation: CleanupPresentation = {
  log: () => {},
  error: () => {},
  setExitCode: () => {},
  keptBranchLine: (branch) => `kept branch ${branch}`,
}

function mechanicalLabel(action: SessionMechanicalAction): string {
  if (action.kind === 'reconcile-claims') return `reconcile claims ${action.claimIds.join(',')}`
  if (action.kind === 'close-run') return `close run ${action.runId}`
  if (action.kind === 'remove-tree') return `remove tree ${action.path}`
  return `${action.kind} ${action.project}:${action.branch}`
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function currentTreeOwners(database: Database, path: string): { runId: string; path: string }[] {
  const wanted = canonicalPath(path)
  return (
    database.query('SELECT record_id,worktree FROM run WHERE worktree IS NOT NULL').all() as {
      record_id: string
      worktree: string
    }[]
  )
    .filter((row) => canonicalPath(row.worktree) === wanted)
    .map((row) => ({ runId: row.record_id, path: wanted }))
}

function applyMechanicalAction(action: SessionMechanicalAction, database: Database): void {
  if (action.kind === 'close-run') {
    const result = closeOutRun(action.runId, { intent: 'explicit' })
    if (!['released', 'absent'].includes(result.outcome))
      throw new Error(`${result.outcome}: ${result.detail}`)
    return
  }
  if (action.kind === 'remove-tree') {
    const path = canonicalPath(action.path)
    if (!plannedTreeOwnerMatches(action.runId, path, currentTreeOwners(database, path)))
      throw new Error(
        `planned tree ${action.path} is no longer owned only by run ${action.runId}; gather again before removing it`,
      )
    const result = closeOutRun(action.runId, { intent: 'tree-remove' })
    if (!['released', 'absent'].includes(result.outcome))
      throw new Error(`${result.outcome}: ${result.detail}`)
    return
  }
  if (action.kind === 'ship-cleanup') {
    const result = shipCleanup(action.branch, { project: action.project })
    if (!result.verdict.clean)
      throw new Error(
        result.errors.map((error) => error.detail).join('; ') ||
          result.kept.map((item) => item.reason).join('; '),
      )
    return
  }
  if (action.kind === 'prune-branch') {
    const result = pruneBranch({ project: action.project, branch: action.branch })
    if (result.errors.length || result.kept.some((item) => item.branch === action.branch))
      throw new Error(
        [...result.errors, ...result.kept.map((item) => `${item.branch}: ${item.reason}`)].join(
          '; ',
        ),
      )
    return
  }
  reconcileAbsentClaims({
    dryRun: false,
    claimIds: action.claimIds,
    presentation: silentPresentation,
    trust: observeGrokTrustHeadings(),
    database,
  })
}

type ProcessReportItem = SessionCloseOutReport['process'][number]

function liveRunProcessItem(
  item: Extract<
    ReturnType<typeof gather>['classification']['process'][number],
    { kind: 'live-run' }
  >,
): ProcessReportItem {
  return {
    item: `run ${item.number}`,
    reason: `run is ${item.status}`,
    evidence: `run ${item.runId} remains alive`,
    remedy:
      item.status === 'asking'
        ? `${PLATFORM_SLUG} question answer <question> then ${PLATFORM_SLUG} run continue ${item.number}`
        : `${PLATFORM_SLUG} run stop ${item.number}`,
  }
}

function unprovedBranchProcessItem(
  inventory: ReturnType<typeof gather>,
  item: Extract<
    ReturnType<typeof gather>['classification']['process'][number],
    { kind: 'unproved-branch' }
  >,
): ProcessReportItem {
  const evidence = inventory.evidence.find(
    (row) => row.project === item.project && row.branch === item.branch,
  )
  return {
    item: `branch ${item.project}:${item.branch}`,
    reason: 'unique work is not proved landed, superseded, or empty',
    evidence: evidence
      ? `${evidence.commitsAhead} commit(s) ahead; patch equivalence ${evidence.patchEquivalence}; task ${evidence.taskKey ?? 'unkeyed'} is ${evidence.taskStatus}; last activity ${evidence.lastActivity ?? 'unknown'}; live run ${evidence.liveRun ? 'yes' : 'no'}; live tree ${evidence.liveTree ?? 'no'}`
      : 'branch proof is unavailable',
    remedy:
      evidence?.remedy ??
      `${PLATFORM_SLUG} tree branch dispose ${item.project}:${item.branch} --reason <abandoned|superseded|throwaway> --note "<why>"`,
  }
}

function processReportItem(
  inventory: ReturnType<typeof gather>,
  item: ReturnType<typeof gather>['classification']['process'][number],
): ProcessReportItem {
  switch (item.kind) {
    case 'live-run':
      return liveRunProcessItem(item)
    case 'dirty-tree':
      return {
        item: `dirty tree ${item.path}`,
        reason: 'the tree has uncommitted work and requires a disposal ruling',
        evidence: `run ${item.number} (${item.runId}) owns the tree`,
        remedy: `${PLATFORM_SLUG} run abandon ${item.number} --force --note "<why this work may be disposed>"`,
      }
    case 'unproved-branch':
      return unprovedBranchProcessItem(inventory, item)
    case 'landing': {
      const landing = inventory.landings.find((row) => row.record_id === item.landingId)!
      return {
        item: `landing ${landing.record_id}`,
        reason: `landing is ${landing.status}`,
        evidence: `${landing.project}:${landing.branch}`,
        remedy: `${PLATFORM_SLUG} pr check ${landing.branch}`,
      }
    }
    case 'review': {
      const review = inventory.reviews.find((row) => row.record_id === item.reviewId)!
      return {
        item: `review ${review.number}`,
        reason: 'review is incomplete',
        evidence: review.record_id,
        remedy: `${PLATFORM_SLUG} review triage ${review.number} <ordinal>`,
      }
    }
  }
}

function appendClassifiedProcessItems(
  report: SessionCloseOutReport,
  inventory: ReturnType<typeof gather>,
): void {
  for (const item of inventory.classification.process)
    report.process.push(processReportItem(inventory, item))
}

function appendArgumentProcesses(
  report: SessionCloseOutReport,
  inventory: ReturnType<typeof gather>,
): void {
  const projectRows = [
    ...new Set(inventory.runs.flatMap((run) => (run.project ? [run.project] : []))),
  ].flatMap((name) => {
    const project = projectByName(name)
    return project ? [project] : []
  })
  if (!projectRows.length) return
  for (const process of currentOrphanProcesses(projectRows).orphans.filter(
    (row) => row.match === 'argument',
  ))
    report.process.push({
      item: `process ${process.pid}`,
      reason: 'argument-only process match requires a ruling',
      evidence: process.command,
      remedy: `${PLATFORM_SLUG} machine reclaim process ${process.pid}`,
    })
}

function appendObservationErrors(
  report: SessionCloseOutReport,
  errors: readonly ResourceObservationError[],
): void {
  for (const error of errors) {
    if (
      !report.errors.some(
        (candidate) => candidate.item === error.item && candidate.detail === error.detail,
      )
    )
      report.errors.push(error)
  }
}

export function closeOutSession(
  options: { session?: string; dryRun?: boolean } = {},
): SessionCloseOutReport {
  const session = options.session ?? callingSessionId()
  if (!session) throw new Error(`session identity is unavailable; pass --session <id>`)
  const dryRun = options.dryRun ?? false
  const database = dryRun ? db() : writableDb()
  const initial = gather(database, session, dryRun)
  const report: SessionCloseOutReport = {
    session,
    dryRun,
    owned: {
      runs: initial.runs,
      branches: initial.branches,
      claims: initial.claims,
      landings: initial.landings,
      reviews: initial.reviews,
    },
    mechanical: [],
    process: [],
    errors: [...initial.observationErrors],
    verdict: { clean: false, residue: 0 },
  }
  for (const action of initial.classification.mechanical) {
    const label = mechanicalLabel(action)
    if (dryRun) {
      report.mechanical.push(`would ${label}`)
      continue
    }
    try {
      applyMechanicalAction(action, database)
      report.mechanical.push(label)
    } catch (cause) {
      report.errors.push({
        item: label,
        detail: cause instanceof Error ? cause.message : String(cause),
        retry: `${PLATFORM_SLUG} session close-out --session ${session}`,
      })
    }
  }
  const final =
    dryRun || initial.classification.mechanical.length === 0
      ? initial
      : gather(database, session, false)
  appendObservationErrors(report, final.observationErrors)
  appendClassifiedProcessItems(report, final)
  appendArgumentProcesses(report, final)
  const plannedRunRoots = new Set(
    dryRun
      ? initial.classification.mechanical.flatMap((action) => {
          if (action.kind === 'close-run') return [action.runId]
          if (action.kind !== 'remove-tree') return []
          const run = initial.runs.find((candidate) => candidate.recordId === action.runId)
          return run ? [run.rootRecordId] : []
        })
      : [],
  )
  const plannedClaimIds = new Set(
    dryRun
      ? initial.classification.mechanical.flatMap((action) =>
          action.kind === 'reconcile-claims' ? action.claimIds : [],
        )
      : [],
  )
  report.verdict = sessionCloseOutVerdict({
    remainingRuns: final.runs.filter((run) => run.status === 'running' || run.status === 'asking')
      .length,
    remainingTrees: final.runs.filter(
      (run) =>
        run.worktree &&
        !plannedRunRoots.has(run.rootRecordId) &&
        final.claims.some(
          (claim) => claim.kind === 'worktree' && claim.allocation_key === run.worktree,
        ),
    ).length,
    remainingBranches: final.evidence.length,
    remainingClaims: final.claims.filter((claim) => !plannedClaimIds.has(claim.id)).length,
    remainingLandings: final.landings.length,
    remainingReviews: final.reviews.length,
    processItems: report.process.length,
    errors: report.errors.length,
  })
  return report
}

export function formatSessionCloseOut(report: SessionCloseOutReport): string {
  const lines = [`session close-out ${report.session}${report.dryRun ? ' (dry run)' : ''}`]
  for (const item of report.mechanical) lines.push(`mechanical: ${item}`)
  for (const item of report.process)
    lines.push(
      `remains: ${item.item}: ${item.reason}; evidence: ${item.evidence}; remedy: ${item.remedy}`,
    )
  for (const error of report.errors)
    lines.push(`error: ${error.item}: ${error.detail}; retry: ${error.retry}`)
  if (report.dryRun && report.mechanical.length > 0) {
    lines.push(
      report.verdict.clean
        ? `owned items would be released by the ${report.mechanical.length} planned action(s); session would then be clean`
        : `owned items would be released by the ${report.mechanical.length} planned action(s); ${report.verdict.residue} owned item(s) would remain`,
    )
  } else {
    lines.push(
      report.verdict.clean
        ? 'clean: session owns nothing'
        : `not clean: ${report.verdict.residue} owned item(s) remain`,
    )
  }
  return lines.join('\n')
}
