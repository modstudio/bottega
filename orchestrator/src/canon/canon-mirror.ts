// concern: canon-mirror
/** Owns the scheduled store-to-repository canon publication lifecycle. */
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { closeOutRun } from '../close/close-out.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { fileNote, listHubNotes } from '../mcp/hub-notes.ts'
import { withWorktreeCreateLock } from '../project/project-lock.ts'
import { type Project, projects, stackAt } from '../project/projects.ts'
import { createPullRequest, recordPullRequestRefresh } from '../pull-request/pr-admission.ts'
import { recordCreatedWorktreeClaims, settleClaims } from '../resources/resource-claims.ts'
import { acquireRunLease } from '../run/run-lease.ts'
import { CANON_MIRROR_JOB } from '../run/synthetic-lifecycle-job.ts'
import { resolveProjectAutonomy } from '../workflow/autonomy-scopes.ts'
import { productionWorkflowTree } from '../workflow/workflow-tree-store.ts'
import { inspectTreeOwnership, ORCH_RUN_MARKER } from '../worktree/worktree-attribution.ts'
import { attributeWorktree } from '../worktree/worktree-create.ts'
import { applyHydration } from './canon-apply.ts'
import { collectCanonLintInput, collectCanonTreeAtRef } from './canon-files.ts'
import { hydrationDrift, planHydration } from './canon-hydrate.ts'
import { introducedCanonFindings, lintCanon } from './canon-lint.ts'
import { storedRepositoryCanonRows } from './canon-stored-rows.ts'

export type ChecksState = 'passed' | 'failed' | 'pending'
export type MergeDecision = { merge: true } | { merge: false; reason: string }
export function decideCanonMirrorMerge(input: {
  shipLevel: string
  headMatches: boolean
  baseUnchanged: boolean
  checks: ChecksState
}): MergeDecision {
  if (input.shipLevel !== 'auto')
    return { merge: false, reason: `ship autonomy is ${input.shipLevel}` }
  if (!input.headMatches)
    return { merge: false, reason: 'pull-request head does not match the pushed commit' }
  if (!input.baseUnchanged)
    return { merge: false, reason: 'the landing branch changed after hydration was planned' }
  if (input.checks !== 'passed')
    return { merge: false, reason: `GitHub checks are ${input.checks}` }
  return { merge: true }
}

export type MirrorRevision = { path: string; revision: string; op: string; reason: string }
export function canonMirrorCommitBody(rows: MirrorRevision[]): string {
  return rows
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((r) => `${r.path}\nRevision: ${r.revision}\nOperation: ${r.op}\nReason: ${r.reason}`)
    .join('\n\n')
}

type PullRequest = {
  number: number
  url: string
  headSha: string
  headRef?: string
  baseRef?: string
  checks: ChecksState
}
export type CanonMirrorPort = {
  acquireLease(runId: number): ReturnType<typeof acquireRunLease>
  fetch(project: Project): void
  localBranch(project: Project, branch: string): boolean
  remoteBranchTip(project: Project, branch: string): string | null
  refTip(project: Project, ref: string): string
  createTree(input: {
    project: Project
    path: string
    branch: string
    base: string
    runId: number
    record(base: string): void
  }): string
  changedPaths(path: string): string[]
  stage(path: string): void
  commit(path: string, subject: string, body: string): string
  push(path: string, branch: string, expected: string | null): void
  pullRequest(path: string, branch: string): PullRequest | null
  openPullRequest(path: string, title: string, bodyFile: string): PullRequest
  recordPullRequest(path: string, number: number): void
  refreshPullRequest(path: string, number: number, title: string, bodyFile: string): PullRequest
  merge(path: string, number: number, commit: string): void
  releaseBranch(project: Project, branch: string): void
  releaseRun(runId: number): { outcome: string; detail: string }
}

const WITHHELD = 'command failed: output withheld because it resembles a secret'
export function screenCanonMirrorError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  return containsSecretShaped(text) ? WITHHELD : text
}
function spawn(cwd: string, args: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(args, {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
}
function command(cwd: string, args: string[]): string {
  const child = spawn(cwd, args)
  if (child.exitCode !== 0) {
    const detail = child.stderr?.toString().trim() || `exit ${child.exitCode}`
    if (containsSecretShaped(detail)) throw new Error(WITHHELD)
    throw new Error(`${args.join(' ')} failed: ${detail}`)
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
  refTip: (p, ref) => command(p.path, ['git', 'rev-parse', ref]),
  createTree: ({ project, path, branch, base, record }) => {
    mkdirSync(dirname(path), { recursive: true })
    const child = spawn(project.path, ['git', 'worktree', 'add', '-B', branch, path, base])
    if (existsSync(path)) record(base)
    if (child.exitCode !== 0) {
      const detail = child.stderr?.toString().trim() || `exit ${child.exitCode}`
      if (containsSecretShaped(detail)) throw new Error(WITHHELD)
      throw new Error(`git worktree add failed: ${detail}`)
    }
    if (!existsSync(path)) throw new Error(`git worktree add did not create ${path}`)
    return base
  },
  changedPaths: (path) =>
    command(path, ['git', 'diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean),
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
  openPullRequest: (path, title, bodyFile) => {
    createPullRequest(['--title', title, '--body-file', bodyFile], {}, path)
    const opened = systemCanonMirrorPort.pullRequest(
      path,
      command(path, ['git', 'branch', '--show-current']),
    )
    if (!opened) throw new Error('opened pull request could not be read back')
    return opened
  },
  recordPullRequest: (path, number) => {
    recordPullRequestRefresh(path, number)
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
  releaseBranch: (p, branch) => {
    command(p.path, ['git', 'branch', '-D', branch])
  },
  releaseRun: (runId) => closeOutRun(runId, { intent: 'tree-remove' }),
}

export function canonMirrorMergeArgs(number: number, commit: string): string[] {
  return ['gh', 'pr', 'merge', String(number), '--squash', '--match-head-commit', commit]
}

type MirrorResult = { project: string; text: string; failed: boolean }
function createLifecycleRun(project: Project, key: string): number {
  writableDb()
  const prompt = `canon mirror ${project.name}`
  return (
    db()
      .query(
        `INSERT INTO run
     (started_at,agent,job,repo,project_id,cwd,prompt_sha,prompt_bytes,prompt_head,status,
      session_id,launch_cwd,launch_key,launch_base,stack,evidence_excluded,pid)
     VALUES (?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        nowIso(),
        '(architect)',
        CANON_MIRROR_JOB,
        project.name,
        project.id,
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
      ) as { id: number }
  ).id
}
function recordTree(
  runId: number,
  project: Project,
  path: string,
  branch: string,
  base: string,
): void {
  writeTransaction(() => {
    db()
      .query(
        `UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=?,worktree_source='git' WHERE id=?`,
      )
      .run(path, path, branch, branch, base, runId)
    recordCreatedWorktreeClaims(db(), {
      rootRunId: runId,
      runId,
      projectId: project.id,
      owned: true,
      path,
      head: base,
      mintedBranch: branch,
      label: String(runId),
      claimedAt: nowIso(),
    })
  })
}
export function revisionRows(
  project: string,
  paths: string[],
  database: Database = db(),
): MirrorRevision[] {
  return paths.map((path) => {
    const row = database
      .query(
        `SELECT record_id revision,op,reason FROM doc_revision
       WHERE scope='canon' AND slug=? AND owner IS NULL AND (subject=? OR subject IS NULL)
       ORDER BY CASE WHEN subject=? THEN 0 ELSE 1 END,id DESC LIMIT 1`,
      )
      .get(path, project, project) as { revision: string | null; op: string; reason: string } | null
    return {
      path,
      revision: row?.revision ?? 'unrecorded',
      op: row?.op ?? 'link',
      reason: row?.reason ?? 'generated canon link',
    }
  })
}
function setRunTerminal(runId: number, started: number, error?: string): void {
  const safe = error ? screenCanonMirrorError(error) : null
  db()
    .query(`UPDATE run SET status=?,latency_ms=?,exit_code=?,error=?,pid=NULL WHERE id=?`)
    .run(safe ? 'failed' : 'ok', Date.now() - started, safe ? 1 : 0, safe, runId)
}
function releaseLifecycle(port: CanonMirrorPort, runId: number): string | null {
  try {
    const closed = port.releaseRun(runId)
    return ['released', 'absent'].includes(closed.outcome)
      ? null
      : screenCanonMirrorError(`canon mirror cleanup ${closed.outcome}: ${closed.detail}`)
  } catch (cause) {
    return screenCanonMirrorError(`canon mirror cleanup failed: ${screenCanonMirrorError(cause)}`)
  }
}

type Publication = { tip: string; prNumber: number }
function previousPublication(project: Project, branch: string, runId: number): Publication | null {
  return db()
    .query<Publication, [string, string, number, string, number]>(
      `SELECT snapshot.tip tip,snapshot.pr_number prNumber FROM landing_triage_snapshot snapshot
     WHERE snapshot.project=? AND snapshot.branch=? AND snapshot.pr_number IS NOT NULL
       AND EXISTS (SELECT 1 FROM run WHERE run.id<>? AND run.job=?
         AND run.minted_branch=snapshot.branch
         AND (run.project_id=? OR (run.project_id IS NULL AND run.repo=snapshot.project)))
     ORDER BY snapshot.id DESC LIMIT 1`,
    )
    .get(project.name, branch, runId, CANON_MIRROR_JOB, project.id) as Publication | null
}
function releaseOwnedLeftover(project: Project, path: string, port: CanonMirrorPort): void {
  if (!existsSync(path)) return
  const owners = db()
    .query<{ id: number }, [string, string, number, string]>(
      `SELECT id FROM run WHERE job=? AND worktree=?
     AND (project_id=? OR (project_id IS NULL AND repo=?)) ORDER BY id`,
    )
    .all(CANON_MIRROR_JOB, path, project.id, project.name)
  const ownership = inspectTreeOwnership(
    path,
    project.path,
    owners.map((r) => r.id),
  )
  let markerRun = 0
  try {
    markerRun = Number(readFileSync(join(path, ORCH_RUN_MARKER), 'utf8').split('\n')[0])
  } catch {
    markerRun = 0
  }
  if (ownership !== 'owned' || !owners.some((r) => r.id === markerRun)) {
    throw new Error(
      'refusing unowned canon mirror worktree .claude/worktrees/canon-mirror; it was left intact',
    )
  }
  const closed = port.releaseRun(markerRun)
  if (!['released', 'absent'].includes(closed.outcome) || existsSync(path)) {
    throw new Error(
      `owned canon mirror worktree ${path} could not be released: ${closed.outcome}: ${closed.detail}`,
    )
  }
}
function proveLocalBranchOwnership(
  project: Project,
  branch: string,
  runId: number,
  port: CanonMirrorPort,
): void {
  if (!port.localBranch(project, branch)) return
  const owner = db()
    .query(
      `SELECT id FROM run WHERE id<>? AND job=? AND minted_branch=?
     AND (project_id=? OR (project_id IS NULL AND repo=?)) ORDER BY id DESC LIMIT 1`,
    )
    .get(runId, CANON_MIRROR_JOB, branch, project.id, project.name)
  if (!owner) throw new Error(`refusing unowned local branch ${branch}; it was left intact`)
}
function settleReleasedBranch(runId: number, branch: string): void {
  writeTransaction(() => {
    db().query('UPDATE run SET branch_kept=NULL,branch_kept_tip=NULL WHERE id=?').run(runId)
    settleClaims(db(), {
      rootRunId: runId,
      kind: 'branch',
      state: 'released',
      settledAt: nowIso(),
      detail: 'local branch deleted after canon mirror push',
      allocationKey: `refs/heads/${branch}`,
    })
  })
}

type MirrorExecution = { treeCreated: boolean; pushed: boolean }

function performMirrorPublication(input: {
  project: Project
  dryRun: boolean
  port: CanonMirrorPort
  runId: number
  key: string
  trunk: string
  branch: string
  path: string
  started: number
  shipLevel: string
  execution: MirrorExecution
}): MirrorResult {
  const { project, dryRun, port, runId, key, trunk, branch, path, started, execution } = input
  port.fetch(project)
  const ref = `origin/${trunk}`
  const base = port.refTip(project, ref)
  const landed = collectCanonTreeAtRef(project.path, base)
  const plan = planHydration({ rows: storedRepositoryCanonRows(project.name), tree: landed.tree })
  const drift = hydrationDrift(plan)
  if (drift.length === 0) {
    setRunTerminal(runId, started)
    return { project: project.name, failed: false, text: 'nothing to do' }
  }
  if (dryRun) {
    setRunTerminal(runId, started)
    return {
      project: project.name,
      failed: false,
      text: `left open, dry-run: ${drift.length} paths differ`,
    }
  }
  releaseOwnedLeftover(project, path, port)
  proveLocalBranchOwnership(project, branch, runId, port)
  const previous = previousPublication(project, branch, runId)
  const remoteTip = port.remoteBranchTip(project, branch)
  if (remoteTip !== (previous?.tip ?? null)) {
    throw new Error(
      previous
        ? `refusing remote branch ${branch}: expected recorded tip ${previous.tip}, found ${remoteTip ?? 'absent'}`
        : `refusing unowned remote branch ${branch} at ${remoteTip}; no prior canon-mirror publication recorded it`,
    )
  }
  port.createTree({
    project,
    path,
    branch,
    base,
    runId,
    record: (createdBase) => {
      attributeWorktree(
        { path, branch, base: createdBase, repoRoot: project.path, source: 'git', mintedBranch: branch },
        runId,
        () => recordTree(runId, project, path, branch, createdBase),
      )
      execution.treeCreated = true
    },
  })
  const baseline = lintCanon(collectCanonLintInput(path)).findings
  applyHydration(path, plan)
  port.stage(path)
  const findings = introducedCanonFindings(baseline, lintCanon(collectCanonLintInput(path)).findings)
  if (findings.length) {
    throw new Error(
      `canon lint found ${findings.length} findings: ${findings.map((f) => `${f.file}:${f.line} ${f.message}`).join('; ')}`,
    )
  }
  const changed = port.changedPaths(path)
  const commit = port.commit(
    path,
    `${key} sync canon from the store`,
    canonMirrorCommitBody(revisionRows(project.name, changed)),
  )
  const existing = port.pullRequest(path, branch)
  if (existing && (existing.headRef !== branch || existing.baseRef !== trunk)) {
    throw new Error(
      `refusing foreign pull request ${existing.number}: expected ${branch} -> ${trunk}, found ${existing.headRef} -> ${existing.baseRef}`,
    )
  }
  if (existing && (!previous || previous.prNumber !== existing.number)) {
    throw new Error(
      `refusing unowned pull request ${existing.number} on ${branch}; newest recorded canon-mirror PR is ${previous?.prNumber ?? 'none'}`,
    )
  }
  port.push(path, branch, previous?.tip ?? null)
  execution.pushed = true
  const bodyDir = mkdtempSync(join(tmpdir(), 'canon-mirror-pr-'))
  chmodSync(bodyDir, 0o700)
  const bodyFile = join(bodyDir, 'body.md')
  try {
    writeFileSync(bodyFile, `Automated canon hydration from the managed store.\n\nCommit: ${commit}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    const title = `${key} sync canon from the store`
    if (existing) port.recordPullRequest(path, existing.number)
    const pr = existing
      ? port.refreshPullRequest(path, existing.number, title, bodyFile)
      : port.openPullRequest(path, title, bodyFile)
    const decision = decideCanonMirrorMerge({
      shipLevel: input.shipLevel,
      headMatches: pr.headSha === commit,
      baseUnchanged: port.refTip(project, ref) === base,
      checks: pr.checks,
    })
    if (!decision.merge) {
      setRunTerminal(runId, started)
      return {
        project: project.name,
        failed: false,
        text: `${existing ? 'PR updated' : 'PR opened'}, ${pr.url}; left open, ${decision.reason}`,
      }
    }
    // Re-read immediately before merge. gh cannot bind the base SHA atomically.
    if (port.refTip(project, ref) !== base)
      throw new Error('refusing merge because the landing branch moved after checks')
    port.merge(path, pr.number, commit)
    setRunTerminal(runId, started)
    return { project: project.name, failed: false, text: `merged, ${pr.url}` }
  } finally {
    rmSync(bodyDir, { recursive: true, force: true })
  }
}

async function mirrorProject(
  project: Project,
  dryRun: boolean,
  port: CanonMirrorPort,
): Promise<MirrorResult> {
  const key = project.settings.canonMirrorKey?.trim()
  if (!key)
    return {
      project: project.name,
      failed: true,
      text: `failed, missing canonMirrorKey; remedy: orch project set ${project.name} --settings '{"canonMirrorKey":"<KEY>"}'`,
    }
  const trunk = project.settings.trunk?.trim()
  if (!trunk)
    return {
      project: project.name,
      failed: true,
      text: 'failed, registered project has no landing branch in settings.trunk',
    }
  const started = Date.now()
  const runId = createLifecycleRun(project, key)
  const branch = `${key}-canon-mirror`
  const path = join(project.path, '.claude', 'worktrees', 'canon-mirror')
  let lease: ReturnType<typeof acquireRunLease> | null = null
  let outcome: MirrorResult = {
    project: project.name,
    failed: true,
    text: 'failed, mirror did not finish',
  }
  const execution: MirrorExecution = { treeCreated: false, pushed: false }
  try {
    const autonomy = dryRun
      ? null
      : await resolveProjectAutonomy(
          project.name,
          undefined,
          undefined,
          productionWorkflowTree().steps,
          {},
          undefined,
          undefined,
          undefined,
          undefined,
          ['ship'],
        )
    return withWorktreeCreateLock(project.path, () => {
      try {
        lease = port.acquireLease(runId)
        outcome = performMirrorPublication({
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
        })
        return outcome
      } catch (cause) {
        const reason = screenCanonMirrorError(cause)
        setRunTerminal(runId, started, reason)
        outcome = { project: project.name, failed: true, text: `failed, ${reason}` }
        return outcome
      } finally {
        lease?.release()
        const cleanupFailure = releaseLifecycle(port, runId)
        if (cleanupFailure) {
          setRunTerminal(runId, started, cleanupFailure)
          outcome.failed = true
          outcome.text = `failed, ${cleanupFailure}`
        }
        if (execution.pushed && !cleanupFailure) {
          try {
            port.releaseBranch(project, branch)
            settleReleasedBranch(runId, branch)
          } catch (cause) {
            const reason = screenCanonMirrorError(cause)
            setRunTerminal(runId, started, reason)
            outcome.failed = true
            outcome.text = `failed, local branch ${branch} could not be released: ${reason}`
          }
        } else if (execution.treeCreated && !execution.pushed) {
          outcome.text += `; local branch ${branch} retained because no remote copy was proven`
        }
      }
    })
  } catch (cause) {
    const reason = screenCanonMirrorError(cause)
    setRunTerminal(runId, started, reason)
    outcome = { project: project.name, failed: true, text: `failed, ${reason}` }
    const cleanupFailure = releaseLifecycle(port, runId)
    if (cleanupFailure) outcome.text = `failed, ${cleanupFailure}`
    return outcome
  }
}

async function fileFailure(result: MirrorResult, project: Project): Promise<void> {
  const text = `canon mirror: ${project.name} ${result.text}`
  const notes = await listHubNotes(project.name, { cwd: project.path })
  const same = notes.find((note) => note.text === text)
  await fileNote(same ? { text, same_as: same.id } : { text, new: true }, { cwd: project.path })
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
