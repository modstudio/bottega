import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { db, EVIDENCE_CLOSED_SQL, chainScoreJoin, pidAlive, SESSION_LIVE_MS, sessionId, writableDb, writeTransaction } from './db.ts'
import { projectAt, projectByName } from './projects.ts'
import {
  branchTip, removeBranch, removeFor, targetGitEnvironment, withCleanupLock, withWorktreeLease,
  type Worktree,
} from './worktree.ts'

export type ReclaimResult = { ok: boolean; action: string }

type ReclaimRun = {
  id: number
  root_id: number
  repo: string | null
  worktree: string
  branch: string | null
  minted_branch: string | null
  base_commit: string | null
  worktree_source: Worktree['source'] | null
  status: string
  pid: number | null
  agent_pid: number | null
  session_id: string | null
  session_last_seen: string | null
  scored: number
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(['git', ...args], {
    cwd, env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
  })
  return {
    ok: result.exitCode === 0,
    out: (result.exitCode === 0 ? result.stdout : result.stderr).toString().trim(),
  }
}

function refuse(missing: string): ReclaimResult {
  return { ok: false, action: `refused; ${missing}` }
}

function runRows(path: string): ReclaimRun[] {
  const rows = db().query(
    `SELECT r.id, COALESCE(r.parent_run_id, r.id) root_id, r.repo, r.worktree,
            r.branch, r.minted_branch, r.base_commit, r.worktree_source, r.status,
            r.pid, r.agent_pid, r.session_id, seen.last_seen session_last_seen,
            ${EVIDENCE_CLOSED_SQL} AS scored
       FROM run r ${chainScoreJoin('r', 's')}
       LEFT JOIN session_seen seen ON seen.session_id=r.session_id
      WHERE r.worktree IS NOT NULL ORDER BY r.id`,
  ).all() as ReclaimRun[]
  const canonical = (candidate: string) => {
    try { return existsSync(candidate) ? realpathSync(candidate) : resolve(candidate) }
    catch { return resolve(candidate) }
  }
  const wanted = canonical(path)
  return rows.filter((row) => canonical(row.worktree) === wanted)
}

function liveOwner(row: ReclaimRun, clock: number): string | null {
  if (row.pid && pidAlive(row.pid)) return `run ${row.id} worker pid ${row.pid} is live`
  if (row.agent_pid && pidAlive(row.agent_pid)) return `run ${row.id} agent pid ${row.agent_pid} is live`
  if (row.session_id && row.session_last_seen) {
    const seen = Date.parse(row.session_last_seen)
    if (Number.isFinite(seen) && clock - seen <= SESSION_LIVE_MS) {
      return `run ${row.id} session ${row.session_id} was last seen at ${row.session_last_seen}`
    }
  }
  return null
}

function absentCommits(repoRoot: string, subject: string, trunk: string): string[] | null {
  const result = git(repoRoot, ['rev-list', subject, '--not', trunk])
  return result.ok ? result.out.split('\n').filter(Boolean) : null
}

/** Reclaim one worktree only after its run rows and git state prove it reconstructible. */
export function reclaimWorktree(
  requestedPath: string, options: { dryRun?: boolean; clock?: number } = {},
): ReclaimResult {
  const path = existsSync(requestedPath) ? realpathSync(requestedPath) : resolve(requestedPath)
  if (!existsSync(path)) return refuse(`worktree ${path} does not exist`)
  const rows = runRows(path)
  if (!rows.length) return refuse(`no run row records worktree ${path}`)
  const row = rows[0]!
  const project = row.repo ? projectByName(row.repo) : projectAt(path)
  if (!project) return refuse(`worktree ${path} has no registered project`)
  const owner = { session: sessionId(), what: `reclaim worktree ${path}` }
  return withWorktreeLease(project.path, path, owner, () =>
    withCleanupLock(project.path, owner, () => {
      const lockedRows = runRows(path)
      if (!lockedRows.length) return refuse(`no run row records worktree ${path}`)
      const clock = options.clock ?? Date.now()
      for (const lockedRow of lockedRows) {
        const live = liveOwner(lockedRow, clock)
        if (live) return refuse(live)
        if (!['ok', 'failed', 'stale', 'stopped'].includes(lockedRow.status)) {
          return refuse(`run ${lockedRow.id} status ${lockedRow.status} is not terminal`)
        }
        if (!lockedRow.scored) return refuse(`run ${lockedRow.root_id} is unscored; its diff is still evidence`)
        if (!lockedRow.worktree_source) return refuse(`run ${lockedRow.id} records no worktree creation source`)
        if (!lockedRow.base_commit) return refuse(`run ${lockedRow.id} records no base commit`)
      }
      const lockedRow = lockedRows[0]!
      const trunk = typeof project.settings.trunk === 'string' && project.settings.trunk.trim()
        ? project.settings.trunk : null
      if (!trunk) return refuse(`project ${project.name} records no landing branch`)
      const base = git(project.path, ['cat-file', '-e', `${lockedRow.base_commit}^{commit}`])
      if (!base.ok) return refuse(`recorded base commit ${lockedRow.base_commit} is unavailable`)

      const status = git(path, ['status', '--porcelain', '--untracked-files=all'])
      if (!status.ok) return refuse(`git status could not inspect ${path}: ${status.out || 'unknown error'}`)
      const dirty = status.out.split('\n').filter(Boolean).map((line) => line.slice(3))
      if (dirty.length) return refuse(`uncommitted paths block reclaim: ${dirty.join(', ')}`)

      const absent = absentCommits(project.path, 'HEAD', trunk)
      if (absent === null) return refuse(`reachability from landing branch ${trunk} could not be inspected`)
      if (absent.length) return refuse(`commits unreachable from landing branch ${trunk}: ${absent.join(', ')}`)
      if (options.dryRun) {
        return { ok: true, action: `would reclaim worktree ${path}; run recipe/base and clean reachable git state proved reconstructibility` }
      }

      writableDb()
      const minted = lockedRow.minted_branch ?? lockedRow.branch ?? ''
      const removed = removeFor({
        path, branch: minted, mintedBranch: lockedRow.minted_branch,
        base: lockedRow.base_commit!, repoRoot: project.path,
        source: lockedRow.worktree_source ?? undefined,
      }, project.path, false, false, lockedRow.id)
      if (!removed.removed) return refuse(removed.detail)
      const clear = db().query('UPDATE run SET worktree=NULL WHERE id=?')
      writeTransaction(() => lockedRows.forEach((record) => clear.run(record.id)))
      return { ok: true, action: `reclaimed worktree ${path}; ${removed.detail}` }
    }, 5 * 60_000), 5 * 60_000)
}

/** Reclaim one local branch only when its commits remain reachable or its exact kept tip is recorded. */
export function reclaimBranch(
  subject: string, options: { dryRun?: boolean } = {},
): ReclaimResult {
  const colon = subject.indexOf(':')
  if (colon < 1 || colon === subject.length - 1) {
    return refuse(`branch subject must be <project>:<branch>; received ${subject}`)
  }
  const projectName = subject.slice(0, colon)
  const branch = subject.slice(colon + 1)
  const project = projectByName(projectName)
  if (!project) return refuse(`project ${projectName} is not registered`)
  const tip = branchTip(project.path, branch)
  if (!tip) return refuse(`branch ${projectName}:${branch} does not exist`)
  const trunk = typeof project.settings.trunk === 'string' && project.settings.trunk.trim()
    ? project.settings.trunk : null
  if (!trunk) return refuse(`project ${projectName} records no landing branch`)

  const kept = db().query(
    `SELECT id, branch_kept_tip FROM run
      WHERE repo=? AND (branch=? OR branch_kept=?) AND branch_kept_tip IS NOT NULL ORDER BY id`,
  ).all(projectName, branch, branch) as { id: number; branch_kept_tip: string | null }[]
  const recorded = kept.some((row) => row.branch_kept_tip === tip)
  const absent = absentCommits(project.path, branch, trunk)
  if (absent === null) return refuse(`reachability from landing branch ${trunk} could not be inspected`)
  if (absent.length && !recorded) {
    return refuse(`commits unreachable from landing branch ${trunk}: ${absent.join(', ')}`)
  }
  if (options.dryRun) {
    const proof = recorded ? `tip ${tip} is recorded in branch_kept_tip` : `every commit is reachable from ${trunk}`
    return { ok: true, action: `would reclaim branch ${projectName}:${branch}; ${proof}` }
  }

  writableDb()
  try {
    if (!removeBranch(project.path, branch)) return refuse(`git did not delete branch ${projectName}:${branch}`)
  } catch (cause) {
    return refuse(`git did not delete branch ${projectName}:${branch}: ${String((cause as Error).message ?? cause)}`)
  }
  db().query(
    'UPDATE run SET branch_kept=NULL, branch_kept_tip=NULL WHERE repo=? AND branch_kept=?',
  ).run(projectName, branch)
  return { ok: true, action: `reclaimed branch ${projectName}:${branch}` }
}
