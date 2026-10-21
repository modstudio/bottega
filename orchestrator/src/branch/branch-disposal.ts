// concern: branch disposal
/** Archives unique commits, deletes one ruled branch, and records the reversible ruling. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { withWorktreeCreateLock } from '../project/project-lock.ts'
import { projectByName } from '../project/projects.ts'
import { machineId } from '../record/machine-identity.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'
import {
  BRANCH_DISPOSAL_REASONS,
  type BranchDisposalReason,
  decideBranchDisposal,
  disposalTaskState,
} from './branch-disposal-decision.ts'
import { settleDeletedBranch } from './branch-settlement.ts'
import { branchesReport } from './branches.ts'
import { observeTaskStatus } from './task-status-observation.ts'

const BRANCH_DISPOSAL_ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

export type BranchDisposalResult = {
  recordId: string
  project: string
  branch: string
  tip: string
  archiveRef: string
  archiveExpiresAt: string
}

type DisposalPlan = Omit<BranchDisposalResult, 'project'> & {
  projectName: string
  actor: string
  project: NonNullable<ReturnType<typeof projectByName>>
  taskKey: string | null
  reason: string
  note: string
  disposedAt: string
}

type ExpiredArchive = {
  archive_ref: string
  tip: string
  branch: string
  project: string
}

function pruneExpiredArchive(
  row: ExpiredArchive,
  input: Parameters<typeof pruneExpiredBranchDisposalArchives>[0],
): 'removed' | 'failed' {
  const project = projectByName(row.project, input.dryRun ? db() : writableDb())
  if (!project) {
    input.error(
      `branch disposal archive ${row.archive_ref}: project ${row.project} is not registered`,
    )
    return 'failed'
  }
  try {
    const current = git(project.path, ['rev-parse', '--verify', row.archive_ref])
    if (current !== row.tip)
      throw new Error(`archive ref moved from recorded tip ${row.tip} to ${current}`)
    if (!input.dryRun) git(project.path, ['update-ref', '-d', row.archive_ref, row.tip])
    input.log(
      `${input.dryRun ? 'would expire' : 'expired'} branch disposal archive ${row.archive_ref} for ${row.project}:${row.branch}`,
    )
    return 'removed'
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    if (detail.includes('Needed a single revision')) return 'removed'
    input.error(`branch disposal archive ${row.archive_ref}: ${detail}`)
    return 'failed'
  }
}

/** Expire recoverability refs after their recorded retention window. */
export function pruneExpiredBranchDisposalArchives(input: {
  dryRun: boolean
  project?: string
  now?: string
  log: (line: string) => void
  error: (line: string) => void
}): { removed: number; failed: boolean } {
  const database = input.dryRun ? db() : writableDb()
  const rows = database
    .query(
      `SELECT disposal.archive_ref,disposal.tip,disposal.branch,project.name project
         FROM branch_disposal disposal JOIN project ON project.record_id=disposal.project_record_id
        WHERE disposal.archive_expires_at<=? AND (? IS NULL OR project.name=?)
        ORDER BY disposal.archive_expires_at`,
    )
    .all(input.now ?? nowIso(), input.project ?? null, input.project ?? null) as ExpiredArchive[]
  let removed = 0
  let failed = false
  for (const row of rows) {
    const outcome = pruneExpiredArchive(row, input)
    removed += Number(outcome === 'removed')
    failed ||= outcome === 'failed'
  }
  return { removed, failed }
}

function git(cwd: string, args: string[], input?: string): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdin: input === undefined ? undefined : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0)
    throw new Error(
      result.stderr.toString().trim() || `git ${args.join(' ')} exited ${result.exitCode}`,
    )
  return result.stdout.toString().trim()
}

function refusalRemedy(
  reason: Exclude<ReturnType<typeof decideBranchDisposal>, { eligible: true }>['reason'],
  project: string,
  branch: string,
): string {
  if (reason === 'not-run-minted')
    return `use git's own branch lifecycle; ${PLATFORM_SLUG} records disposal only for run-minted branches`
  if (reason === 'live-owner')
    return `finish or stop the owning run and remove its tree, then retry ${PLATFORM_SLUG} tree branch dispose ${project}:${branch}`
  if (reason === 'open-task')
    return `close or drop the task, or repeat with --operator after the operator rules that its unique work may be disposed`
  if (reason === 'superseded-target-missing')
    return 'repeat with --note "superseded by <branch or PR>: <why>"'
  return `${PLATFORM_SLUG} tree branch prune --project ${project} --key <KEY>`
}

function planBranchDisposal(input: {
  target: string
  reason: string
  note: string
  operator?: boolean
}): DisposalPlan {
  const separator = input.target.indexOf(':')
  if (separator < 1 || separator === input.target.length - 1)
    throw new Error('branch disposal target must be <project>:<branch>')
  const projectName = input.target.slice(0, separator)
  const branch = input.target.slice(separator + 1)
  if (!BRANCH_DISPOSAL_REASONS.includes(input.reason as BranchDisposalReason))
    throw new Error(`--reason must be ${BRANCH_DISPOSAL_REASONS.join(', ')}`)
  if (!input.note.trim()) throw new Error('--note must explain the disposal ruling')
  const actor = sessionId()
  if (!actor)
    throw new Error('branch disposal requires an attributed architect or operator session')
  const project = projectByName(projectName)
  if (!project) throw new Error(`unknown project ${projectName}`)
  const projectReport = branchesReport({ project: projectName, branch }).projects[0]!
  if (projectReport.error) throw new Error(projectReport.error)
  const keyGroup = projectReport.keys.find((group) =>
    group.branches.some((row) => row.branch === branch),
  )
  const row = keyGroup?.branches.find((candidate) => candidate.branch === branch)
  const taskStatus = observeTaskStatus(keyGroup?.key ?? null, projectName)
  const decision = decideBranchDisposal({
    runMinted: row !== undefined,
    liveRun: row?.liveRun ?? false,
    checkedOut: row?.checkedOut ?? false,
    taskStatus: disposalTaskState(taskStatus),
    uniqueWork: row ? row.commitsNotOnTrunk > 0 : false,
    operator: input.operator ?? false,
    supersededTargetNamed:
      input.reason !== 'superseded' || /^superseded by\s+\S+/i.test(input.note.trim()),
  })
  if (!decision.eligible)
    throw new Error(
      `refusing branch disposal: ${decision.reason}; cleared by: ${refusalRemedy(decision.reason, projectName, branch)}`,
    )
  if (!row) throw new Error(`branch ${branch} disappeared while checking disposal eligibility`)
  const recordId = newRecordId()
  const archiveRef = `refs/orch/archive/branch-disposal/${recordId}`
  const disposedAt = nowIso()
  const archiveExpiresAt = new Date(
    Date.parse(disposedAt) + BRANCH_DISPOSAL_ARCHIVE_RETENTION_MS,
  ).toISOString()
  return {
    recordId,
    projectName,
    branch,
    tip: row.tip,
    archiveRef,
    archiveExpiresAt,
    actor,
    project,
    taskKey: keyGroup?.key ?? null,
    reason: input.reason,
    note: input.note.trim(),
    disposedAt,
  }
}

function recordDisposal(plan: DisposalPlan, database = writableDb()): void {
  database
    .query(
      `INSERT INTO branch_disposal
              (record_id,project_record_id,branch,tip,task_key,reason,note,archive_ref,archive_expires_at,actor_session,disposed_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      plan.recordId,
      plan.project.recordId,
      plan.branch,
      plan.tip,
      plan.taskKey,
      plan.reason,
      plan.note,
      plan.archiveRef,
      plan.archiveExpiresAt,
      plan.actor,
      plan.disposedAt,
    )
  const payload = stringifyOutboxPayload('branch_disposal', {
    id: plan.recordId,
    spaceId: PLATFORM_SPACE_ID,
    projectId: plan.project.recordId,
    projectName: plan.projectName,
    machineId: machineId(),
    localId: null,
    branch: plan.branch,
    tip: plan.tip,
    taskKey: plan.taskKey,
    reason: plan.reason,
    note: plan.note,
    archiveRef: plan.archiveRef,
    archiveExpiresAt: plan.archiveExpiresAt,
    actorSession: plan.actor,
    disposedAt: plan.disposedAt,
    withheldFields: null,
    createdAt: plan.disposedAt,
    updatedAt: plan.disposedAt,
  })
  database
    .query(
      "INSERT INTO outbox (record_id,kind,row_id,payload,created_at) VALUES (?,'branch_disposal',?,?,?)",
    )
    .run(newRecordId(), plan.recordId, payload, plan.disposedAt)
}

export type BranchDisposalDependencies = {
  settle: typeof settleDeletedBranch
  record: typeof recordDisposal
}

const branchDisposalDependencies: BranchDisposalDependencies = {
  settle: settleDeletedBranch,
  record: recordDisposal,
}

export function disposeBranch(
  input: {
    target: string
    reason: string
    note: string
    operator?: boolean
  },
  dependencies: BranchDisposalDependencies = branchDisposalDependencies,
): BranchDisposalResult {
  const plan = planBranchDisposal(input)
  withWorktreeCreateLock(plan.project.path, () => {
    const currentTip = git(plan.project.path, [
      'rev-parse',
      '--verify',
      `refs/heads/${plan.branch}^{commit}`,
    ])
    if (currentTip !== plan.tip)
      throw new Error(
        `branch ${plan.branch} moved while disposal was being ruled; inspect it and retry`,
      )
    git(
      plan.project.path,
      ['update-ref', '--stdin'],
      `start\ncreate ${plan.archiveRef} ${plan.tip}\ndelete refs/heads/${plan.branch} ${plan.tip}\nprepare\ncommit\n`,
    )
    try {
      const database = writableDb()
      writeTransaction(() => {
        dependencies.settle(plan.project.name, plan.branch, {
          database,
          withinTransaction: true,
        })
        dependencies.record(plan, database)
      }, database)
    } catch (cause) {
      try {
        git(
          plan.project.path,
          ['update-ref', '--stdin'],
          `start\ncreate refs/heads/${plan.branch} ${plan.tip}\ndelete ${plan.archiveRef} ${plan.tip}\nprepare\ncommit\n`,
        )
      } catch (restoreCause) {
        const original = cause instanceof Error ? cause.message : String(cause)
        const restore = restoreCause instanceof Error ? restoreCause.message : String(restoreCause)
        throw new Error(`${original}; disposal rollback also failed: ${restore}`)
      }
      throw cause
    }
  })
  return {
    recordId: plan.recordId,
    project: plan.projectName,
    branch: plan.branch,
    tip: plan.tip,
    archiveRef: plan.archiveRef,
    archiveExpiresAt: plan.archiveExpiresAt,
  }
}
