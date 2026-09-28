// concern: canon-mirror
/** Owns the scheduled store-to-repository canon publication lifecycle. */

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { closeOutRun } from '../close/close-out.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { fileNote, listHubNotes } from '../mcp/hub-notes.ts'
import { type Project, projects, stackAt } from '../project/projects.ts'
import { createPullRequest } from '../pull-request/pr-admission.ts'
import { recordCreatedWorktreeClaims } from '../resources/resource-claims.ts'
import { acquireRunLease } from '../run/run-lease.ts'
import { CANON_MIRROR_JOB } from '../run/synthetic-lifecycle-job.ts'
import { resolveProjectStageAutonomy } from '../workflow/autonomy-scopes.ts'
import { productionWorkflowTree } from '../workflow/workflow-tree-store.ts'
import { attributeWorktree } from '../worktree/worktree-create.ts'
import { applyHydration } from './canon-apply.ts'
import { collectCanonLintInput, collectCanonTreeAtRef } from './canon-files.ts'
import { hydrationDrift, planHydration } from './canon-hydrate.ts'
import { lintCanon } from './canon-lint.ts'
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
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(
      (row) =>
        `${row.path}\nRevision: ${row.revision}\nOperation: ${row.op}\nReason: ${row.reason}`,
    )
    .join('\n\n')
}

type PullRequest = { number: number; url: string; headSha: string; checks: ChecksState }

export type CanonMirrorPort = {
  fetch(project: Project): void
  createTree(input: {
    project: Project
    path: string
    branch: string
    base: string
    runId: number
  }): string
  changedPaths(path: string): string[]
  stage(path: string): void
  commit(path: string, subject: string, body: string): string
  push(path: string, branch: string): void
  pullRequest(path: string, branch: string): PullRequest | null
  openPullRequest(path: string, title: string, bodyFile: string): PullRequest
  refreshPullRequest(path: string, number: number, title: string, bodyFile: string): PullRequest
  remoteTip(project: Project, ref: string): string
  merge(path: string, number: number): void
  releaseRun(runId: number): { outcome: string; detail: string }
}

function command(cwd: string, args: string[]): string {
  const child = Bun.spawnSync(args, {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (child.exitCode !== 0) {
    throw new Error(
      `${args.join(' ')} failed: ${child.stderr.toString().trim() || `exit ${child.exitCode}`}`,
    )
  }
  return child.stdout.toString().trim()
}

function parsePullRequest(text: string): PullRequest | null {
  const rows = JSON.parse(text) as Array<{
    number: number
    url: string
    headRefOid: string
    statusCheckRollup?: Array<{ status?: string; conclusion?: string }>
  }>
  const row = rows[0]
  if (!row) return null
  const checks = row.statusCheckRollup ?? []
  const state: ChecksState = checks.some(
    (check) => check.conclusion && check.conclusion !== 'SUCCESS',
  )
    ? 'failed'
    : checks.some((check) => !check.conclusion || check.status !== 'COMPLETED')
      ? 'pending'
      : 'passed'
  return { number: row.number, url: row.url, headSha: row.headRefOid, checks: state }
}

export const systemCanonMirrorPort: CanonMirrorPort = {
  fetch: (project) => {
    command(project.path, ['git', 'fetch', 'origin', project.settings.trunk!])
  },
  createTree: ({ project, path, branch, base }) => {
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) command(project.path, ['git', 'worktree', 'remove', '--force', path])
    command(project.path, ['git', 'worktree', 'add', '-B', branch, path, base])
    return command(path, ['git', 'rev-parse', 'HEAD'])
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
  push: (path, branch) => {
    command(path, ['git', 'push', '--force-with-lease', '-u', 'origin', branch])
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
        'number,url,headRefOid,statusCheckRollup',
      ]),
    ),
  openPullRequest: (path, title, bodyFile) => {
    createPullRequest(['--title', title, '--body-file', bodyFile], {}, path)
    const branch = command(path, ['git', 'branch', '--show-current'])
    const opened = systemCanonMirrorPort.pullRequest(path, branch)
    if (!opened) throw new Error('opened pull request could not be read back')
    return opened
  },
  refreshPullRequest: (path, number, title, bodyFile) => {
    command(path, ['gh', 'pr', 'edit', String(number), '--title', title, '--body-file', bodyFile])
    const branch = command(path, ['git', 'branch', '--show-current'])
    const refreshed = systemCanonMirrorPort.pullRequest(path, branch)
    if (!refreshed) throw new Error(`pull request ${number} could not be read back`)
    return refreshed
  },
  remoteTip: (project, ref) => command(project.path, ['git', 'rev-parse', ref]),
  merge: (path, number) => {
    command(path, ['gh', 'pr', 'merge', String(number), '--squash'])
  },
  releaseRun: (runId) => closeOutRun(runId, { intent: 'tree-remove' }),
}

type MirrorResult = { project: string; text: string; failed: boolean }

function createLifecycleRun(project: Project, key: string): number {
  writableDb()
  const startedAt = nowIso()
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
        startedAt,
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
        `UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=?,worktree_source='git'
         WHERE id=?`,
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

function revisionRows(paths: string[], database: Database = db()): MirrorRevision[] {
  return paths.map((path) => {
    const row = database
      .query(
        `SELECT record_id revision,op,reason FROM doc_revision
         WHERE scope='canon' AND slug=? AND owner IS NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(path) as { revision: string | null; op: string; reason: string } | null
    return {
      path,
      revision: row?.revision ?? 'unrecorded',
      op: row?.op ?? 'link',
      reason: row?.reason ?? 'generated canon link',
    }
  })
}

function setRunTerminal(runId: number, started: number, error?: string): void {
  db()
    .query(`UPDATE run SET status=?,latency_ms=?,exit_code=?,error=?,pid=NULL WHERE id=?`)
    .run(error ? 'failed' : 'ok', Date.now() - started, error ? 1 : 0, error ?? null, runId)
}

function releaseLifecycle(
  port: CanonMirrorPort,
  runId: number,
  started: number,
  outcome: MirrorResult | null,
): void {
  let cleanupFailure: string | null = null
  try {
    const closed = port.releaseRun(runId)
    if (!['released', 'absent'].includes(closed.outcome)) {
      cleanupFailure = `canon mirror cleanup ${closed.outcome}: ${closed.detail}`
    }
  } catch (cause) {
    cleanupFailure = `canon mirror cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`
  }
  if (!cleanupFailure) return
  setRunTerminal(runId, started, cleanupFailure)
  if (outcome) {
    outcome.failed = true
    outcome.text = `failed, ${cleanupFailure}`
  }
}

async function mirrorProject(
  project: Project,
  dryRun: boolean,
  port: CanonMirrorPort,
): Promise<MirrorResult> {
  const key = project.settings.canonMirrorKey?.trim()
  if (!key) {
    return {
      project: project.name,
      failed: true,
      text: `failed, missing canonMirrorKey; remedy: orch project set ${project.name} --settings '{"canonMirrorKey":"<KEY>"}'`,
    }
  }
  const started = Date.now()
  const runId = createLifecycleRun(project, key)
  let lease = acquireRunLease(runId)
  let outcome: MirrorResult | null = null
  const finish = (result: MirrorResult): MirrorResult => {
    outcome = result
    return result
  }
  try {
    const trunk = project.settings.trunk?.trim()
    if (!trunk) throw new Error('registered project has no landing branch in settings.trunk')
    port.fetch(project)
    const ref = `origin/${trunk}`
    const landed = collectCanonTreeAtRef(project.path, ref)
    const plan = planHydration({ rows: storedRepositoryCanonRows(project.name), tree: landed.tree })
    if (hydrationDrift(plan).length === 0) {
      setRunTerminal(runId, started)
      return finish({ project: project.name, failed: false, text: 'nothing to do' })
    }
    if (dryRun) {
      setRunTerminal(runId, started)
      return finish({
        project: project.name,
        failed: false,
        text: `left open, dry-run: ${hydrationDrift(plan).length} paths differ`,
      })
    }
    const branch = `${key}-canon-mirror`
    const path = join(project.path, '.claude', 'worktrees', 'canon-mirror')
    const base = port.createTree({ project, path, branch, base: ref, runId })
    attributeWorktree(
      { path, branch, base, repoRoot: project.path, source: 'git', mintedBranch: branch },
      runId,
      () => recordTree(runId, project, path, branch, base),
    )
    applyHydration(path, plan)
    port.stage(path)
    const findings = lintCanon(collectCanonLintInput(path)).findings
    if (findings.length)
      throw new Error(
        `canon lint found ${findings.length} findings: ${findings.map((finding) => `${finding.file}:${finding.line} ${finding.message}`).join('; ')}`,
      )
    const changed = port.changedPaths(path)
    const commit = port.commit(
      path,
      `${key} sync canon from the store`,
      canonMirrorCommitBody(revisionRows(changed)),
    )
    port.push(path, branch)
    const prBody = join(tmpdir(), `canon-mirror-${runId}-pr.md`)
    writeFileSync(
      prBody,
      `Automated canon hydration from the managed store.\n\nCommit: ${commit}\n`,
    )
    const existing = port.pullRequest(path, branch)
    const title = `${key} sync canon from the store`
    const pr = existing
      ? port.refreshPullRequest(path, existing.number, title, prBody)
      : port.openPullRequest(path, title, prBody)
    rmSync(prBody, { force: true })
    const autonomy = await resolveProjectStageAutonomy(
      project.name,
      productionWorkflowTree().steps,
      ['ship'],
    )
    const decision = decideCanonMirrorMerge({
      shipLevel: autonomy.stages?.ship?.value ?? 'ask',
      headMatches: pr.headSha === commit,
      baseUnchanged: port.remoteTip(project, ref) === base,
      checks: pr.checks,
    })
    setRunTerminal(runId, started)
    if (decision.merge) {
      port.merge(path, pr.number)
      return finish({ project: project.name, failed: false, text: `merged, ${pr.url}` })
    }
    return finish({
      project: project.name,
      failed: false,
      text: `${existing ? 'PR updated' : 'PR opened'}, ${pr.url}; left open, ${decision.reason}`,
    })
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    setRunTerminal(runId, started, reason)
    return finish({ project: project.name, failed: true, text: `failed, ${reason}` })
  } finally {
    lease.release()
    lease = null as never
    releaseLifecycle(port, runId, started, outcome)
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
    (project) =>
      project.settings.managedContext === true &&
      (!input.project || project.name === input.project),
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
        result.text += `; note filing failed: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    }
  }
  return results
}
