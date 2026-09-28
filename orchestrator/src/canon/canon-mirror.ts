// concern: canon-mirror
/** Owns the scheduled store-to-repository canon publication lifecycle. */
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
export function decideCanonMirrorMerge(input: { shipLevel: string; headMatches: boolean; baseUnchanged: boolean; checks: ChecksState }): MergeDecision {
  if (input.shipLevel !== 'auto') return { merge: false, reason: `ship autonomy is ${input.shipLevel}` }
  if (!input.headMatches) return { merge: false, reason: 'pull-request head does not match the pushed commit' }
  if (!input.baseUnchanged) return { merge: false, reason: 'the landing branch changed after hydration was planned' }
  if (input.checks !== 'passed') return { merge: false, reason: `GitHub checks are ${input.checks}` }
  return { merge: true }
}

export type MirrorRevision = { path: string; revision: string; op: string; reason: string }
export function canonMirrorCommitBody(rows: MirrorRevision[]): string {
  return rows.sort((a, b) => a.path.localeCompare(b.path)).map((r) => `${r.path}\nRevision: ${r.revision}\nOperation: ${r.op}\nReason: ${r.reason}`).join('\n\n')
}

type PullRequest = { number: number; url: string; headSha: string; headRef: string; baseRef: string; checks: ChecksState }
export type CanonMirrorPort = {
  fetch(project: Project): void
  localBranch(project: Project, branch: string): boolean
  remoteBranchTip(project: Project, branch: string): string | null
  refTip(project: Project, ref: string): string
  createTree(input: { project: Project; path: string; branch: string; base: string; runId: number; record(base: string): void }): string
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
  return Bun.spawnSync(args, { cwd, env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe' })
}
function command(cwd: string, args: string[]): string {
  const child = spawn(cwd, args)
  if (child.exitCode !== 0) {
    const detail = child.stderr.toString().trim() || `exit ${child.exitCode}`
    if (containsSecretShaped(detail)) throw new Error(WITHHELD)
    throw new Error(`${args.join(' ')} failed: ${detail}`)
  }
  return child.stdout.toString().trim()
}
function parsePullRequest(text: string): PullRequest | null {
  const row = (JSON.parse(text) as Array<{ number: number; url: string; headRefOid: string; headRefName: string; baseRefName: string; statusCheckRollup?: Array<{ status?: string; conclusion?: string }> }>)[0]
  if (!row) return null
  const checks = row.statusCheckRollup ?? []
  const state: ChecksState = checks.some((c) => c.conclusion && c.conclusion !== 'SUCCESS') ? 'failed' : checks.some((c) => !c.conclusion || c.status !== 'COMPLETED') ? 'pending' : 'passed'
  return { number: row.number, url: row.url, headSha: row.headRefOid, headRef: row.headRefName, baseRef: row.baseRefName, checks: state }
}

export const systemCanonMirrorPort: CanonMirrorPort = {
  fetch: (p) => { command(p.path, ['git', 'fetch', 'origin', p.settings.trunk!]) },
  localBranch: (p, branch) => spawn(p.path, ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).exitCode === 0,
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
      const detail = child.stderr.toString().trim() || `exit ${child.exitCode}`
      if (containsSecretShaped(detail)) throw new Error(WITHHELD)
      throw new Error(`git worktree add failed: ${detail}`)
    }
    if (!existsSync(path)) throw new Error(`git worktree add did not create ${path}`)
    return base
  },
  changedPaths: (path) => command(path, ['git', 'diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean),
  stage: (path) => { command(path, ['git', 'add', '--all']) },
  commit: (path, subject, body) => { command(path, ['git', 'commit', '-m', subject, '-m', body]); return command(path, ['git', 'rev-parse', 'HEAD']) },
  push: (path, branch, expected) => { command(path, ['git', 'push', `--force-with-lease=${branch}:${expected ?? ''}`, '-u', 'origin', `HEAD:refs/heads/${branch}`]) },
  pullRequest: (path, branch) => parsePullRequest(command(path, ['gh', 'pr', 'list', '--state', 'open', '--head', branch, '--json', 'number,url,headRefOid,headRefName,baseRefName,statusCheckRollup'])),
  openPullRequest: (path, title, bodyFile) => {
    createPullRequest(['--title', title, '--body-file', bodyFile], {}, path)
    const opened = systemCanonMirrorPort.pullRequest(path, command(path, ['git', 'branch', '--show-current']))
    if (!opened) throw new Error('opened pull request could not be read back')
    return opened
  },
  recordPullRequest: (path, number) => { recordPullRequestRefresh(path, number) },
  refreshPullRequest: (path, number, title, bodyFile) => {
    command(path, ['gh', 'pr', 'edit', String(number), '--title', title, '--body-file', bodyFile])
    const refreshed = systemCanonMirrorPort.pullRequest(path, command(path, ['git', 'branch', '--show-current']))
    if (!refreshed) throw new Error(`pull request ${number} could not be read back`)
    return refreshed
  },
  merge: (path, number, commit) => {
    // gh exposes a head-SHA precondition but no corresponding base-SHA precondition.
    command(path, ['gh', 'pr', 'merge', String(number), '--squash', '--match-head-commit', commit])
  },
  releaseBranch: (p, branch) => { command(p.path, ['git', 'branch', '-D', branch]) },
  releaseRun: (runId) => closeOutRun(runId, { intent: 'tree-remove' }),
}

type MirrorResult = { project: string; text: string; failed: boolean }
function createLifecycleRun(project: Project, key: string): number {
  writableDb()
  const prompt = `canon mirror ${project.name}`
  return (db().query(
    `INSERT INTO run
     (started_at,agent,job,repo,project_id,cwd,prompt_sha,prompt_bytes,prompt_head,status,
      session_id,launch_cwd,launch_key,launch_base,stack,evidence_excluded,pid)
     VALUES (?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?) RETURNING id`,
  ).get(
    nowIso(), '(architect)', CANON_MIRROR_JOB, project.name, project.id, project.path,
    createHash('sha256').update(prompt).digest('hex').slice(0, 16), Buffer.byteLength(prompt),
    prompt, sessionId(), project.path, key, `origin/${project.settings.trunk}`,
    stackAt(project.path), 'canon mirror lifecycle row; not agent execution', process.pid,
  ) as { id: number }).id
}
function recordTree(runId: number, project: Project, path: string, branch: string, base: string): void {
  writeTransaction(() => {
    db().query(`UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=?,worktree_source='git' WHERE id=?`).run(path, path, branch, branch, base, runId)
    recordCreatedWorktreeClaims(db(), { rootRunId: runId, runId, projectId: project.id, owned: true, path, head: base, mintedBranch: branch, label: String(runId), claimedAt: nowIso() })
  })
}
export function revisionRows(project: string, paths: string[], database: Database = db()): MirrorRevision[] {
  return paths.map((path) => {
    const row = database.query(
      `SELECT record_id revision,op,reason FROM doc_revision
       WHERE scope='canon' AND slug=? AND owner IS NULL AND (subject=? OR subject IS NULL)
       ORDER BY CASE WHEN subject=? THEN 0 ELSE 1 END,id DESC LIMIT 1`,
    ).get(path, project, project) as { revision: string | null; op: string; reason: string } | null
    return { path, revision: row?.revision ?? 'unrecorded', op: row?.op ?? 'link', reason: row?.reason ?? 'generated canon link' }
  })
}
function setRunTerminal(runId: number, started: number, error?: string): void {
  const safe = error ? screenCanonMirrorError(error) : null
  db().query(`UPDATE run SET status=?,latency_ms=?,exit_code=?,error=?,pid=NULL WHERE id=?`).run(safe ? 'failed' : 'ok', Date.now() - started, safe ? 1 : 0, safe, runId)
}
function releaseLifecycle(port: CanonMirrorPort, runId: number): string | null {
  try {
    const closed = port.releaseRun(runId)
    return ['released', 'absent'].includes(closed.outcome) ? null : screenCanonMirrorError(`canon mirror cleanup ${closed.outcome}: ${closed.detail}`)
  } catch (cause) {
    return screenCanonMirrorError(`canon mirror cleanup failed: ${screenCanonMirrorError(cause)}`)
  }
}

type Publication = { tip: string; prNumber: number }
function previousPublication(project: Project, branch: string, runId: number): Publication | null {
  return db().query<Publication, [string, string, number, string, number]>(
    `SELECT snapshot.tip tip,snapshot.pr_number prNumber FROM landing_triage_snapshot snapshot
     WHERE snapshot.project=? AND snapshot.branch=? AND snapshot.pr_number IS NOT NULL
       AND EXISTS (SELECT 1 FROM run WHERE run.id<>? AND run.job=?
         AND run.minted_branch=snapshot.branch
         AND (run.project_id=? OR (run.project_id IS NULL AND run.repo=snapshot.project)))
     ORDER BY snapshot.id DESC LIMIT 1`,
  ).get(project.name, branch, runId, CANON_MIRROR_JOB, project.id) as Publication | null
}
function releaseOwnedLeftover(project: Project, path: string, port: CanonMirrorPort): void {
  if (!existsSync(path)) return
  const owners = db().query<{ id: number }, [string, string, number, string]>(
    `SELECT id FROM run WHERE job=? AND worktree=?
     AND (project_id=? OR (project_id IS NULL AND repo=?)) ORDER BY id`,
  ).all(CANON_MIRROR_JOB, path, project.id, project.name)
  const ownership = inspectTreeOwnership(path, project.path, owners.map((r) => r.id))
  let markerRun = 0
  try { markerRun = Number(readFileSync(join(path, ORCH_RUN_MARKER), 'utf8').split('\n')[0]) } catch { markerRun = 0 }
  if (ownership !== 'owned' || !owners.some((r) => r.id === markerRun)) {
    throw new Error(`refusing unowned canon mirror worktree ${path}; it was left intact`)
  }
  const closed = port.releaseRun(markerRun)
  if (!['released', 'absent'].includes(closed.outcome) || existsSync(path)) {
    throw new Error(`owned canon mirror worktree ${path} could not be released: ${closed.outcome}: ${closed.detail}`)
  }
}
function proveLocalBranchOwnership(project: Project, branch: string, runId: number, port: CanonMirrorPort): void {
  if (!port.localBranch(project, branch)) return
  const owner = db().query(
    `SELECT id FROM run WHERE id<>? AND job=? AND minted_branch=?
     AND (project_id=? OR (project_id IS NULL AND repo=?)) ORDER BY id DESC LIMIT 1`,
  ).get(runId, CANON_MIRROR_JOB, branch, project.id, project.name)
  if (!owner) throw new Error(`refusing unowned local branch ${branch}; it was left intact`)
}
function settleReleasedBranch(runId: number, branch: string): void {
  writeTransaction(() => {
    db().query('UPDATE run SET branch_kept=NULL,branch_kept_tip=NULL WHERE id=?').run(runId)
    settleClaims(db(), { rootRunId: runId, kind: 'branch', state: 'released', settledAt: nowIso(), detail: 'local branch deleted after canon mirror push', allocationKey: `refs/heads/${branch}` })
  })
}
