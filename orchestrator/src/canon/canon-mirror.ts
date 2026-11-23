// concern: canon-mirror
/** Owns the scheduled store-to-repository canon publication lifecycle. */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { inspectCheckout } from '../../../shared/git.ts'
import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { redactSecretShaped } from '../../../shared/secret-shaped.ts'
import {
  assertBranchRefMayBeCreated,
  assertBranchRefMayBeDeleted,
} from '../branch/branch-ref-guard.ts'
import {
  type CloseOutResult,
  closeOutRunPrepared,
  persistCloseOutDetail,
} from '../close/close-out.ts'
import {
  type CloseOutPreparation,
  prepareCloseOut,
  prepareCursorWorktreeClear,
} from '../close/close-out-preparation.ts'
import { closeTerminalChainQuestions } from '../close/close-out-questions.ts'
import { completePreparedTreeNaming } from '../close/close-out-tree-naming.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { runWithGitFetchRetry } from '../git/fetch-retry.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { fileNote, listHubNotes } from '../mcp/hub-notes.ts'
import { withWorktreeCreateLock } from '../project/project-lock.ts'
import { type Project, projects, stackAt } from '../project/projects.ts'
import { createPullRequestAdmittedWithPolicy } from '../pull-request/pr-admission.ts'
import { assertPullRequestTaskCursorAdmission } from '../pull-request/task-cursor-admission.ts'
import { recordCreatedWorktreeClaims, settleClaims } from '../resources/resource-claims.ts'
import { acquireRunLease } from '../run/run-lease.ts'
import { nextRunNumber } from '../run/run-number.ts'
import { CANON_MIRROR_JOB, canonMirrorBranchName } from '../run/synthetic-lifecycle-job.ts'
import { resolveProjectAutonomy } from '../workflow/autonomy-scopes.ts'
import { productionWorkflowTree } from '../workflow/workflow-tree-store.ts'
import {
  cleanRunTree,
  inspectTreeOwnership,
  readWorktreeMarker,
} from '../worktree/worktree-attribution.ts'
import { attributeWorktree } from '../worktree/worktree-create.ts'
import { applyHydration } from './canon-apply.ts'
import { EMPTY_PROJECT_CANON_STORE_REFUSAL } from './canon-empty-store-refusal.ts'
import { collectCanonLintInput, collectCanonTreeAtRef } from './canon-files.ts'
import { emptyStoreHydrationRefusal, hydrationDrift, planHydration } from './canon-hydrate.ts'
import { introducedCanonFindings, lintCanon } from './canon-lint.ts'
import {
  type CanonMirrorRows,
  canonMirrorAuthoritativeSnapshot,
  type VersionedReviewFunnelPolicy,
} from './canon-mirror-authoritative-snapshot.ts'
import { appendMirrorFailure, mirrorFailureText } from './canon-mirror-failure.ts'
import { decideLeftoverDisposition, leftoverDispositionMessage } from './canon-mirror-leftover.ts'
import { canonMirrorLintDecision } from './canon-mirror-lint-decision.ts'
import {
  type ChecksState,
  canonMirrorMergeArgs,
  decideCanonMirrorMerge,
} from './canon-mirror-merge-decision.ts'
import {
  assertHydrationDoesNotRevertBranchCanon,
  type CanonMirrorRevisionSnapshot,
  canonMirrorCommitBody,
  revisionRows,
} from './canon-mirror-revisions.ts'

type PullRequest = {
  number: number
  url: string
  headSha: string
  headRef?: string
  baseRef?: string
  checks: ChecksState
}
export type CanonMirrorPort = {
  acquireLease(runId: string): ReturnType<typeof acquireRunLease>
  fetch(project: Project): void
  localBranch(project: Project, branch: string): boolean
  remoteBranchTip(project: Project, branch: string): string | null
  remoteTrunkTip(project: Project, trunk: string): string | null
  refTip(project: Project, ref: string): string
  treeDirty(path: string): boolean | 'indeterminate'
  unpushedCommitCount(path: string, refs: string[]): number
  resetTree(path: string, base: string): void
  lastPathCommit(path: string, base: string, file: string): { sha: string; at: string } | null
  createTree(input: {
    project: Project
    path: string
    branch: string
    base: string
    runId: string
    record(base: string): void
  }): string
  changedPaths(path: string): string[]
  stage(path: string): void
  commit(path: string, subject: string, body: string): string
  push(path: string, branch: string, expected: string | null): void
  pullRequest(path: string, branch: string): PullRequest | null
  admitPullRequest(project: Project, branch: string): Promise<void>
  openPullRequest(
    path: string,
    title: string,
    bodyFile: string,
    policy: VersionedReviewFunnelPolicy,
  ): PullRequest
  refreshPullRequest(path: string, number: number, title: string, bodyFile: string): PullRequest
  merge(path: string, number: number, commit: string): void
  releaseBranch(project: Project, branch: string, expected: string): void
  prepareRelease(): Promise<CloseOutPreparation>
  releaseRun(
    runId: string,
    preparation: CloseOutPreparation,
  ): {
    outcome: string
    detail: string
    questionRootIds?: readonly string[]
    clearedCursorClaims?: string[]
    cursorCleanup?: Promise<CloseOutResult>
  }
}

export function screenCanonMirrorError(
  value: unknown,
  knownCommits: readonly string[] = [],
): string {
  const text = value instanceof Error ? value.message : String(value)
  return redactSecretShaped(text, { knownCommits }).text
}
function spawn(cwd: string, args: string[]): ReturnType<typeof startBoundedSync> {
  return startBoundedSync(args, {
    budget: 'git-plumbing',
    cwd,
    env: targetGitEnvironment(cwd),
  })
}
function command(cwd: string, args: string[]): string {
  const child = runWithGitFetchRetry(args, () => {
    const attempt = spawn(cwd, args)
    return {
      result: attempt,
      succeeded: attempt.exitCode === 0,
      stderr: attempt.stderr?.toString().trim() || `exit ${attempt.exitCode}`,
    }
  })
  if (child.exitCode !== 0) {
    const detail = child.stderr?.toString().trim() || `exit ${child.exitCode}`
    const safe = screenCanonMirrorError(detail)
    throw new Error(`${args.join(' ')} failed: ${safe}`)
  }
  return child.stdout?.toString().trim() ?? ''
}
function parsePullRequest(text: string): PullRequest | null {
  const row = (
    JSON.parse(text) as Array<{
      number: number
      url: string
      headRefOid: string
      headRefName: string
      baseRefName: string
      statusCheckRollup?: Array<{ status?: string; conclusion?: string }>
    }>
  )[0]
  if (!row) return null
  const checks = row.statusCheckRollup ?? []
  const state: ChecksState = checks.some((c) => c.conclusion && c.conclusion !== 'SUCCESS')
    ? 'failed'
    : checks.some((c) => !c.conclusion || c.status !== 'COMPLETED')
      ? 'pending'
      : 'passed'
  return {
    number: row.number,
    url: row.url,
    headSha: row.headRefOid,
    headRef: row.headRefName,
    baseRef: row.baseRefName,
    checks: state,
  }
}

export const systemCanonMirrorPort: CanonMirrorPort = {
  acquireLease: (runId) => acquireRunLease(runId),
  fetch: (p) => {
    command(p.path, ['git', 'fetch', 'origin', p.settings.trunk!])
  },
  localBranch: (p, branch) =>
    spawn(p.path, ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).exitCode ===
    0,
  remoteBranchTip: (p, branch) => {
    const out = command(p.path, ['git', 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`])
    return out ? (out.split(/\s+/)[0] ?? null) : null
  },
  remoteTrunkTip: (p, trunk) => {
    const out = command(p.path, ['git', 'ls-remote', 'origin', `refs/heads/${trunk}`])
    return out ? (out.split(/\s+/)[0] ?? null) : null
  },
  refTip: (p, ref) => command(p.path, ['git', 'rev-parse', ref]),
  treeDirty: (path) => {
    const cleanliness = inspectCheckout(path).cleanliness
    return cleanliness === 'indeterminate' ? cleanliness : cleanliness === 'dirty'
  },
  unpushedCommitCount: (path, refs) =>
    Number(command(path, ['git', 'rev-list', '--count', 'HEAD', '--not', ...refs])),
  resetTree: (path, base) => {
    command(path, ['git', 'reset', '--hard', base])
    cleanRunTree(path)
  },
  lastPathCommit: (path, base, file) => {
    const out = command(path, ['git', 'log', '-1', '--format=%H%x00%cI', base, '--', file])
    if (!out) return null
    const [sha, at] = out.split('\0')
    return sha && at ? { sha, at } : null
  },
  createTree: ({ project, path, branch, base, record }) => {
    mkdirSync(dirname(path), { recursive: true })
    assertBranchRefMayBeCreated(project.path, branch)
    // branch-ref-guard: assertBranchRefMayBeCreated
    const child = spawn(project.path, ['git', 'worktree', 'add', '-B', branch, path, base])
    if (existsSync(path)) record(base)
    if (child.exitCode !== 0) {
      const detail = child.stderr?.toString().trim() || `exit ${child.exitCode}`
      const safe = screenCanonMirrorError(detail)
      throw new Error(`git worktree add failed: ${safe}`)
    }
    if (!existsSync(path)) throw new Error(`git worktree add did not create ${path}`)
    return base
  },
  changedPaths: (path) =>
    splitNulPaths(command(path, ['git', ...nulPathListArgs(['diff', '--cached', '--name-only'])])),
  stage: (path) => {
    command(path, ['git', 'add', '--all'])
  },
  commit: (path, subject, body) => {
    command(path, ['git', 'commit', '-m', subject, '-m', body])
    return command(path, ['git', 'rev-parse', 'HEAD'])
  },
  push: (path, branch, expected) => {
    command(path, [
      'git',
      'push',
      `--force-with-lease=${branch}:${expected ?? ''}`,
      '-u',
      'origin',
      `HEAD:refs/heads/${branch}`,
    ])
  },
  pullRequest: (path, branch) =>
    parsePullRequest(
      command(path, [
        'gh',
        'pr',
        'list',
        '--state',
        'open',
        '--head',
        branch,
        '--json',
        'number,url,headRefOid,headRefName,baseRefName,statusCheckRollup',
      ]),
    ),
  admitPullRequest: (project, branch) =>
    assertPullRequestTaskCursorAdmission({
      command: 'pr create',
      project,
      branch,
      systemJob: CANON_MIRROR_JOB,
    }),
  openPullRequest: (path, title, bodyFile, policy) => {
    createPullRequestAdmittedWithPolicy(
      ['--title', title, '--body-file', bodyFile],
      {},
      path,
      policy,
    )
    const opened = systemCanonMirrorPort.pullRequest(
      path,
      command(path, ['git', 'branch', '--show-current']),
    )
    if (!opened) throw new Error('opened pull request could not be read back')
    return opened
  },
  refreshPullRequest: (path, number, title, bodyFile) => {
    command(path, ['gh', 'pr', 'edit', String(number), '--title', title, '--body-file', bodyFile])
    const refreshed = systemCanonMirrorPort.pullRequest(
      path,
      command(path, ['git', 'branch', '--show-current']),
    )
    if (!refreshed) throw new Error(`pull request ${number} could not be read back`)
    return refreshed
  },
  merge: (path, number, commit) => {
    // gh exposes a head-SHA precondition but no corresponding base-SHA precondition.
    command(path, canonMirrorMergeArgs(number, commit))
  },
  releaseBranch: (p, branch, expected) => {
    assertBranchRefMayBeDeleted(p.path, branch)
    // branch-ref-guard: assertBranchRefMayBeDeleted
    command(p.path, ['git', 'update-ref', '-d', `refs/heads/${branch}`, expected])
  },
  prepareRelease: prepareCloseOut,
  releaseRun: (runId, preparation) => {
    const clearCursorWorktrees = prepareCursorWorktreeClear(runId, preparation)
    const result = closeOutRunPrepared(runId, { intent: 'landed' }, preparation)
    return {
      ...result,
      cursorCleanup: completePreparedTreeNaming(result, false, clearCursorWorktrees, (completed) =>
        persistCloseOutDetail(completed, 'landed'),
      ),
    }
  },
}

type MirrorResult = { project: string; text: string; failed: boolean }

function createLifecycleRun(project: Project, key: string): string {
  writableDb()
  const prompt = `canon mirror ${project.name}`
  return (
    db()
      .query(
        `INSERT INTO run
     (record_id,number,started_at,agent,job,repo,project_record_id,cwd,prompt_sha,prompt_bytes,prompt_head,status,
      session_id,launch_cwd,launch_key,launch_base,stack,evidence_excluded,pid)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?) RETURNING record_id`,
      )
      .get(
        newRecordId(),
        nextRunNumber(db()),
        nowIso(),
        '(architect)',
        CANON_MIRROR_JOB,
        project.name,
        project.recordId,
        project.path,
        createHash('sha256').update(prompt).digest('hex').slice(0, 16),
        Buffer.byteLength(prompt),
        prompt,
        sessionId(),
        project.path,
        key,
        `origin/${project.settings.trunk}`,
        stackAt(project.path),
        'canon mirror lifecycle row; not agent execution',
        process.pid,
      ) as { record_id: string }
  ).record_id
}
function recordTree(
  runId: string,
  project: Project,
  path: string,
  branch: string,
  base: string,
): void {
  writeTransaction(() => {
    db()
      .query(
        `UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=?,worktree_source='git' WHERE record_id=?`,
      )
      .run(path, path, branch, branch, base, runId)
    recordCreatedWorktreeClaims(db(), {
      rootRunId: runId,
      runId,
      projectId: project.recordId,
      owned: true,
      path,
      head: base,
      mintedBranch: branch,
      label: String(runId),
      claimedAt: nowIso(),
    })
  })
}
function setRunTerminal(runId: string, started: number, error?: string): void {
  const safe = error ? screenCanonMirrorError(error) : null
  db()
    .query(`UPDATE run SET status=?,latency_ms=?,exit_code=?,error=?,pid=NULL WHERE record_id=?`)
    .run(safe ? 'failed' : 'ok', Date.now() - started, safe ? 1 : 0, safe, runId)
}
function releaseLifecycle(
  port: CanonMirrorPort,
  runId: string,
  preparation: CloseOutPreparation,
  execution: MirrorExecution,
): string | null {
  try {
    const closed = port.releaseRun(runId, preparation)
    execution.questionRootIds.push(...(closed.questionRootIds ?? []))
    if (closed.cursorCleanup) execution.cursorCleanups.push(closed.cursorCleanup)
    return ['released', 'absent'].includes(closed.outcome)
      ? null
      : screenCanonMirrorError(`canon mirror cleanup ${closed.outcome}: ${closed.detail}`)
  } catch (cause) {
    return screenCanonMirrorError(`canon mirror cleanup failed: ${screenCanonMirrorError(cause)}`)
  }
}

type Publication = { tip: string; base: string }
function remoteOwnershipRefusal(
  branch: string,
  remoteTip: string | null,
  previous: Publication | null,
): string | null {
  if (remoteTip === null || remoteTip === previous?.tip) return null
  return previous
    ? `refusing remote branch ${branch}: expected recorded tip ${previous.tip}, found ${remoteTip ?? 'absent'}`
    : `refusing unowned remote branch ${branch} at ${remoteTip}; no prior canon-mirror publication recorded it`
}
function previousPublication(project: Project, branch: string, runId: string): Publication | null {
  return db()
    .query<Publication, [string, string, string, string]>(
      `SELECT head_commit tip,base_commit base FROM run
     WHERE record_id<>? AND job=? AND branch=? AND head_commit IS NOT NULL
       AND project_record_id=?
     ORDER BY number DESC LIMIT 1`,
    )
    .get(runId, CANON_MIRROR_JOB, branch, project.recordId) as Publication | null
}
function releaseOwnedLeftover(
  project: Project,
  path: string,
  port: CanonMirrorPort,
  preparation: CloseOutPreparation,
  execution: MirrorExecution,
  dryRun: boolean,
): string | null {
  if (!existsSync(path)) return null
  const owners = db()
    .query<{ record_id: string }, [string, string, string]>(
      `SELECT record_id FROM run WHERE job=? AND worktree=?
     AND project_record_id=? ORDER BY number`,
    )
    .all(CANON_MIRROR_JOB, path, project.recordId)
  const ownership = inspectTreeOwnership(
    path,
    project.path,
    owners.map((r) => r.record_id),
  )
  const markerRecordId = readWorktreeMarker(path).runRecordId
  const markerRun = markerRecordId
    ? (db()
        .query<{ record_id: string; branch: string | null; base_commit: string | null }, [string]>(
          'SELECT record_id,branch,base_commit FROM run WHERE record_id=?',
        )
        .get(markerRecordId) ?? null)
    : null
  if (
    markerRun === null ||
    ownership !== 'owned' ||
    !owners.some((r) => r.record_id === markerRun.record_id)
  ) {
    throw new Error(
      'refusing unowned canon mirror worktree .claude/worktrees/canon-mirror; it was left intact',
    )
  }
  if (!markerRun.branch || !markerRun.base_commit)
    throw new Error('refusing owned canon mirror worktree with no recorded branch or base')
  const remoteTip = port.remoteBranchTip(project, markerRun.branch)
  const dirty = port.treeDirty(path)
  const unpushedCommitCount = port.unpushedCommitCount(
    path,
    remoteTip ? [markerRun.base_commit, remoteTip] : [markerRun.base_commit],
  )
  const disposition = decideLeftoverDisposition({
    dirty,
    unpushedCommitCount,
    dryRun,
  })
  const message = leftoverDispositionMessage(disposition, {
    path,
    branch: markerRun.branch,
    unpushedCommitCount,
  })
  if (disposition.action === 'report') return message
  if (disposition.action === 'refuse') throw new Error(message!)
  if (disposition.action === 'reclaim') port.resetTree(path, markerRun.base_commit)
  const closed = port.releaseRun(markerRun.record_id, preparation)
  execution.questionRootIds.push(...(closed.questionRootIds ?? []))
  if (closed.cursorCleanup) execution.cursorCleanups.push(closed.cursorCleanup)
  if (!['released', 'absent'].includes(closed.outcome) || existsSync(path)) {
    throw new Error(
      `owned canon mirror worktree ${path} could not be released: ${closed.outcome}: ${closed.detail}`,
    )
  }
  return null
}

function proveLocalBranchOwnership(
  branch: string,
  previous: Publication | null,
  tip: string | null,
): void {
  if (tip === null) return
  if (previous && (tip === previous.tip || tip === previous.base)) return
  throw new Error(
    `refusing unowned local branch ${branch} at ${tip}; expected prior canon-mirror tip ${previous?.tip ?? 'none'} or base ${previous?.base ?? 'none'}; it was left intact`,
  )
}
function settleReleasedBranch(runId: string, branch: string): void {
  writeTransaction(() => {
    db().query('UPDATE run SET branch_kept=NULL,branch_kept_tip=NULL WHERE record_id=?').run(runId)
    settleClaims(db(), {
      rootRunId: runId,
      kind: 'branch',
      state: 'released',
      settledAt: nowIso(),
      detail: 'local canon mirror branch deleted at its recorded tip',
      by: { verb: 'canon-mirror:runCanonMirror', session: sessionId() },
      allocationKey: `refs/heads/${branch}`,
    })
  })
}

type MirrorExecution = {
  treeCreated: boolean
  pushed: boolean
  base: string | null
  commit: string | null
  knownCommits: string[]
  questionRootIds: string[]
  cursorCleanups: Promise<CloseOutResult>[]
}

function mirrorOwnership(
  project: Project,
  branch: string,
  runId: string,
  port: CanonMirrorPort,
  execution: MirrorExecution,
): { previous: Publication | null; remoteTip: string | null } {
  const previous = previousPublication(project, branch, runId)
  const remoteTip = port.remoteBranchTip(project, branch)
  const localTip = port.localBranch(project, branch)
    ? port.refTip(project, `refs/heads/${branch}`)
    : null
  execution.knownCommits = [remoteTip, localTip, previous?.tip, previous?.base].filter(
    (tip): tip is string => typeof tip === 'string',
  )
  proveLocalBranchOwnership(branch, previous, localTip)
  const refusal = remoteOwnershipRefusal(branch, remoteTip, previous)
  if (refusal) throw new Error(refusal)
  return { previous, remoteTip }
}

function emptyMirrorExecution(): MirrorExecution {
  return {
    treeCreated: false,
    pushed: false,
    base: null,
    commit: null,
    knownCommits: [],
    questionRootIds: [],
    cursorCleanups: [],
  }
}

async function finishMirrorCursorCleanups(
  outcome: MirrorResult,
  execution: MirrorExecution,
): Promise<MirrorResult> {
  for (const pending of execution.cursorCleanups) {
    const closed = await pending
    if (closed.cursorCleanupFailure) {
      outcome.failed = true
      outcome.text = mirrorFailureText(screenCanonMirrorError(closed.cursorCleanupFailure))
      continue
    }
    for (const notice of closed.clearedCursorClaims ?? []) outcome.text += `; ${notice}`
  }
  return outcome
}

function recordPushedTip(runId: string, commit: string): void {
  db().query('UPDATE run SET head_commit=? WHERE record_id=?').run(commit, runId)
}

function refuseEmptyStoreHydration(projectRowCount: number, deleteCount: number): void {
  if (emptyStoreHydrationRefusal({ projectRowCount, deleteCount }))
    throw new Error(EMPTY_PROJECT_CANON_STORE_REFUSAL)
}

type MirrorPublicationInput = {
  project: Project
  dryRun: boolean
  port: CanonMirrorPort
  runId: string
  key: string
  trunk: string
  branch: string
  path: string
  started: number
  shipLevel: string
  execution: MirrorExecution
  releasePreparation: CloseOutPreparation
  rows: CanonMirrorRows
  revisions: CanonMirrorRevisionSnapshot
  reviewPolicy: VersionedReviewFunnelPolicy
}

function prepareMirrorPublication(input: MirrorPublicationInput):
  | { result: MirrorResult }
  | {
      base: string
      rows: CanonMirrorRows
      plan: ReturnType<typeof planHydration>
    } {
  const { project, dryRun, port, runId, trunk, path, started, execution } = input
  port.fetch(project)
  const base = port.refTip(project, `origin/${trunk}`)
  const landed = collectCanonTreeAtRef(project.path, base)
  const { rows } = input
  const plan = planHydration({ rows, tree: landed.tree })
  const drift = hydrationDrift(plan)
  const leftoverReport = releaseOwnedLeftover(
    project,
    path,
    port,
    input.releasePreparation,
    execution,
    dryRun,
  )
  if (drift.length === 0) {
    setRunTerminal(runId, started)
    return {
      result: {
        project: project.name,
        failed: false,
        text: leftoverReport
          ? `left open, dry-run: ${leftoverReport}; nothing to do`
          : 'nothing to do',
      },
    }
  }
  if (dryRun) {
    setRunTerminal(runId, started)
    return {
      result: {
        project: project.name,
        failed: false,
        text: `left open, dry-run: ${leftoverReport ? `${leftoverReport}; ` : ''}${drift.length} paths differ`,
      },
    }
  }
  return { base, rows, plan }
}

function performMirrorPublication(input: MirrorPublicationInput): MirrorResult {
  const { project, port, runId, key, branch, path, execution } = input
  const prepared = prepareMirrorPublication(input)
  if ('result' in prepared) return prepared.result
  const { base, rows, plan } = prepared
  refuseEmptyStoreHydration(
    rows.filter((row) => row.subject === project.name).length,
    plan.deletes.length,
  )
  assertHydrationDoesNotRevertBranchCanon({
    project: project.name,
    revisions: input.revisions,
    base,
    plan,
    rows,
    lastPathCommit: (file) => port.lastPathCommit(project.path, base, file),
  })
  const { previous, remoteTip } = mirrorOwnership(project, branch, runId, port, execution)
  port.createTree({
    project,
    path,
    branch,
    base,
    runId,
    record: (createdBase) => {
      attributeWorktree(
        {
          path,
          branch,
          base: createdBase,
          repoRoot: project.path,
          source: 'git',
          mintedBranch: branch,
        },
        runId,
        () => recordTree(runId, project, path, branch, createdBase),
      )
      execution.treeCreated = true
      execution.base = createdBase
    },
  })
  const baseline = lintCanon(collectCanonLintInput(path)).findings
  applyHydration(path, plan)
  port.stage(path)
  const findings = introducedCanonFindings(
    baseline,
    lintCanon(collectCanonLintInput(path)).findings,
  )
  const lintDecision = canonMirrorLintDecision(findings)
  if (lintDecision.refusal) throw new Error(lintDecision.refusal)
  const lintWarnings = lintDecision.warnings.length ? `; ${lintDecision.warnings.join('; ')}` : ''
  const changed = port.changedPaths(path)
  const commit = port.commit(
    path,
    `${key} sync canon from the store`,
    canonMirrorCommitBody(revisionRows(input.revisions, changed)),
  )
  execution.commit = commit
  port.push(path, branch, remoteTip === null ? null : previous!.tip)
  execution.pushed = true
  recordPushedTip(runId, commit)
  return finishPullRequestPublication(input, commit, base, previous, lintWarnings)
}

function finishPullRequestPublication(
  input: MirrorPublicationInput,
  commit: string,
  base: string,
  previous: Publication | null,
  lintWarnings: string,
): MirrorResult {
  const { project, port, runId, key, trunk, branch, path, started } = input
  const existing = port.pullRequest(path, branch)
  if (
    existing &&
    (existing.headRef !== branch ||
      existing.baseRef !== trunk ||
      (existing.headSha !== previous?.tip && existing.headSha !== commit))
  ) {
    throw new Error(
      `refusing foreign pull request ${existing.number}: expected ${branch} -> ${trunk} at ${previous?.tip ?? commit} or ${commit}, found ${existing.headRef} -> ${existing.baseRef} at ${existing.headSha}`,
    )
  }
  const bodyDir = mkdtempSync(join(tmpdir(), 'canon-mirror-pr-'))
  chmodSync(bodyDir, 0o700)
  const bodyFile = join(bodyDir, 'body.md')
  try {
    writeFileSync(
      bodyFile,
      `Automated canon hydration from the managed store.\n\nCommit: ${commit}\n`,
      {
        flag: 'wx',
        mode: 0o600,
      },
    )
    const title = `${key} sync canon from the store`
    const pr = existing
      ? port.refreshPullRequest(path, existing.number, title, bodyFile)
      : port.openPullRequest(path, title, bodyFile, input.reviewPolicy)
    const decision = decideCanonMirrorMerge({
      shipLevel: input.shipLevel,
      headMatches: pr.headSha === commit,
      baseUnchanged: port.remoteTrunkTip(project, trunk) === base,
      checks: pr.checks,
    })
    if (!decision.merge) {
      setRunTerminal(runId, started)
      return {
        project: project.name,
        failed: false,
        text: `${existing ? 'PR updated' : 'PR opened'}, ${pr.url}; left open, ${decision.reason}${lintWarnings}`,
      }
    }
    // Re-read immediately before merge. gh cannot bind the base SHA atomically.
    if (port.remoteTrunkTip(project, trunk) !== base)
      throw new Error('refusing merge because the landing branch moved after checks')
    port.merge(path, pr.number, commit)
    setRunTerminal(runId, started)
    return { project: project.name, failed: false, text: `merged, ${pr.url}${lintWarnings}` }
  } finally {
    rmSync(bodyDir, { recursive: true, force: true })
  }
}

function failedMirrorResult(
  project: Project,
  runId: string,
  started: number,
  cause: unknown,
  knownCommits: readonly string[],
): MirrorResult {
  const reason = screenCanonMirrorError(cause, knownCommits)
  setRunTerminal(runId, started, reason)
  return { project: project.name, failed: true, text: mirrorFailureText(reason) }
}

async function closeMirrorQuestions(rootIds: readonly string[]): Promise<string | null> {
  try {
    for (const rootId of new Set(rootIds)) await closeTerminalChainQuestions(rootId, false)
    return null
  } catch (cause) {
    return screenCanonMirrorError(
      `canon mirror question cleanup failed: ${screenCanonMirrorError(cause)}`,
    )
  }
}

async function finishMirrorQuestionCleanup(
  runId: string,
  started: number,
  outcome: MirrorResult,
  rootIds: readonly string[],
): Promise<MirrorResult> {
  const failure = await closeMirrorQuestions(rootIds)
  if (!failure) return outcome
  appendMirrorFailure({ outcome, reason: failure, runId, started, setTerminal: setRunTerminal })
  return outcome
}

function cleanupMirrorExecution(
  input: MirrorPublicationInput,
  outcome: MirrorResult,
): string | null {
  const { execution, port, runId, releasePreparation } = input
  let cleanupFailure: string | null = null
  if (execution.treeCreated && !execution.pushed && !execution.commit && execution.base) {
    try {
      port.resetTree(input.path, execution.base)
    } catch (cause) {
      cleanupFailure = screenCanonMirrorError(
        `canon mirror cleanup reset failed: ${screenCanonMirrorError(cause)}`,
      )
    }
  }
  const lifecycleFailure = releaseLifecycle(port, runId, releasePreparation, execution)
  if (lifecycleFailure)
    cleanupFailure = cleanupFailure ? `${cleanupFailure}; ${lifecycleFailure}` : lifecycleFailure
  if (!cleanupFailure) return null
  appendMirrorFailure({
    outcome,
    reason: cleanupFailure,
    runId,
    started: input.started,
    setTerminal: setRunTerminal,
  })
  return cleanupFailure
}

function finishMirrorLifecycle(input: MirrorPublicationInput, outcome: MirrorResult): void {
  const { project, port, runId, branch, execution } = input
  const cleanupFailure = cleanupMirrorExecution(input, outcome)
  const releasableTip = execution.pushed
    ? execution.commit
    : execution.commit
      ? null
      : execution.base
  if (releasableTip && !cleanupFailure) {
    try {
      port.releaseBranch(project, branch, releasableTip)
      settleReleasedBranch(runId, branch)
    } catch (cause) {
      const reason = screenCanonMirrorError(cause, execution.knownCommits)
      appendMirrorFailure({
        outcome,
        reason: `local branch ${branch} could not be released: ${reason}`,
        runId,
        started: input.started,
        setTerminal: setRunTerminal,
      })
    }
  } else if (execution.treeCreated && !execution.pushed) {
    outcome.text += `; local branch ${branch} retained because no remote copy was proven`
  }
}

function runMirrorLocked(input: MirrorPublicationInput): MirrorResult {
  const { project, port, runId, execution } = input
  let lease: ReturnType<typeof acquireRunLease> | null = null
  let outcome: MirrorResult = {
    project: project.name,
    failed: true,
    text: mirrorFailureText('mirror did not finish'),
  }
  return withWorktreeCreateLock(project.path, () => {
    try {
      lease = port.acquireLease(runId)
      outcome = performMirrorPublication(input)
      return outcome
    } catch (cause) {
      outcome = failedMirrorResult(project, runId, input.started, cause, execution.knownCommits)
      return outcome
    } finally {
      lease?.release()
      finishMirrorLifecycle(input, outcome)
    }
  })
}

async function mirrorProject(
  project: Project,
  dryRun: boolean,
  port: CanonMirrorPort,
): Promise<MirrorResult> {
  const key = project.settings.canonMirrorKey?.trim()
  if (!key) return missingMirrorKey(project)
  const trunk = project.settings.trunk?.trim()
  if (!trunk)
    return {
      project: project.name,
      failed: true,
      text: mirrorFailureText('registered project has no landing branch in settings.trunk'),
    }
  const started = Date.now()
  const runId = createLifecycleRun(project, key)
  const branch = canonMirrorBranchName(key)
  const path = join(project.path, '.claude', 'worktrees', 'canon-mirror')
  const execution = emptyMirrorExecution()
  let releasePreparation: CloseOutPreparation | null = null
  try {
    const preparedRelease = await port.prepareRelease()
    releasePreparation = preparedRelease
    const autonomy = dryRun
      ? null
      : await resolveProjectAutonomy(
          project.name,
          undefined,
          undefined,
          productionWorkflowTree({ project: project.name }).steps,
          {},
          undefined,
          undefined,
          undefined,
          undefined,
          ['ship'],
        )
    if (!dryRun) await port.admitPullRequest(project, branch)
    const { rows, revisions, reviewPolicy } = await canonMirrorAuthoritativeSnapshot(project.name)
    const lockedOutcome = runMirrorLocked({
      project,
      dryRun,
      port,
      runId,
      key,
      trunk,
      branch,
      path,
      started,
      shipLevel: autonomy?.stages?.ship?.value ?? 'ask',
      execution,
      releasePreparation: preparedRelease,
      rows,
      revisions,
      reviewPolicy,
    })
    return await finishMirrorQuestionCleanup(
      runId,
      started,
      await finishMirrorCursorCleanups(lockedOutcome, execution),
      execution.questionRootIds,
    )
  } catch (cause) {
    const outcome = failedMirrorResult(project, runId, started, cause, execution.knownCommits)
    const cleanupFailure = releasePreparation
      ? releaseLifecycle(port, runId, releasePreparation, execution)
      : null
    if (cleanupFailure) {
      appendMirrorFailure({
        outcome,
        reason: cleanupFailure,
        runId,
        started,
        setTerminal: setRunTerminal,
      })
    }
    return await finishMirrorQuestionCleanup(
      runId,
      started,
      await finishMirrorCursorCleanups(outcome, execution),
      execution.questionRootIds,
    )
  }
}

function missingMirrorKey(project: Project): MirrorResult {
  return {
    project: project.name,
    failed: true,
    text: mirrorFailureText(
      `missing canonMirrorKey; remedy: ${PLATFORM_SLUG} project set ${project.name} --settings '{"canonMirrorKey":"<KEY>"}'`,
    ),
  }
}

async function fileFailure(result: MirrorResult, project: Project): Promise<void> {
  const text = `canon mirror: ${project.name} ${result.text}`
  const notes = await listHubNotes(project.name, { cwd: project.path })
  const same = notes.find((note) => note.text === text)
  await fileNote(same ? { text, same_as: same.record_id } : { text, new: true }, {
    cwd: project.path,
  })
}
export async function mirrorRepositoryCanon(input: {
  project?: string
  dryRun: boolean
  port?: CanonMirrorPort
  noteFailure?: (result: MirrorResult, project: Project) => Promise<void>
}): Promise<MirrorResult[]> {
  const selected = projects().filter(
    (p) => p.settings.managedContext === true && (!input.project || p.name === input.project),
  )
  if (input.project && selected.length === 0)
    throw new Error(`unknown managed project ${JSON.stringify(input.project)}`)
  const results: MirrorResult[] = []
  for (const project of selected) {
    const result = await mirrorProject(project, input.dryRun, input.port ?? systemCanonMirrorPort)
    results.push(result)
    if (result.failed && !input.dryRun) {
      try {
        await (input.noteFailure ?? fileFailure)(result, project)
      } catch (cause) {
        result.text += `; note filing failed: ${screenCanonMirrorError(cause)}`
      }
    }
  }
  return results
}
