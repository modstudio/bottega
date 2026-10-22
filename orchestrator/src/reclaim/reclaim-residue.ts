// concern: reclaim-residue
/** Observes and releases one explicitly named piece of monitor residue. */
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { pidAlive } from '../../../shared/process-identity.ts'
import { concernStateDirectory } from '../../../shared/state-directory.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db, nowIso, writableDb } from '../database/db.ts'
import { settleRunEvidence } from '../evidence/unjudged-expiry.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { runHasLiveDescendants } from '../idle-kill.ts'
import { processStartTime, projectGitCommonDir } from '../project/project-lock.ts'
import { isProjectRepository, projectByName, projects } from '../project/projects.ts'
import { gitLockOwnerPids, shellQuote } from '../resources/git-locks.ts'
import { runAlive } from '../run/run-alive.ts'
import { RUNS_DIR } from '../run/run-artifacts.ts'
import { runLeaseState } from '../run/run-lease.ts'
import { processTable } from '../run/run-process.ts'
import {
  grokTrustHeadings,
  grokTrustPathFromHeading,
  grokTrustStorePath,
  removeGrokTrustHeading,
} from '../sandbox/grok-trust.ts'
import {
  gitLockReleaseDecision,
  processReleaseDecision,
  type ReleaseDecision,
  refGuardReleaseDecision,
  retainedRefReleaseDecision,
  sandboxReleaseDecision,
  staleRunReleaseDecision,
  trustReleaseDecision,
} from './reclaim-residue-policy.ts'

export type ResidueKind =
  | 'git-lock'
  | 'ref-guard'
  | 'sandbox'
  | 'retained-ref'
  | 'trust'
  | 'process'
  | 'stale-run'

type Options = { dryRun?: boolean; allowSignal?: boolean; absentSatisfies?: boolean }
const terminal = (status: string) => ['ok', 'failed', 'stale', 'stopped'].includes(status)
const denied = (decision: Extract<ReleaseDecision, { allowed: false }>) => ({
  ok: false,
  action: decision.refusal,
})

function runSubject(subject: string): string {
  return subject
}

function gitLockProjects(): { name: string; gitCommonDir: string }[] {
  return projects()
    .filter(isProjectRepository)
    .map((project) => ({
      name: project.name,
      gitCommonDir: projectGitCommonDir(project.path),
    }))
}

type GitLockIdentity = { dev: number; ino: number; mtimeMs: number }

function gitLockIdentity(path: string): GitLockIdentity | null {
  try {
    const stat = lstatSync(path)
    return stat.isFile() ? { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs } : null
  } catch {
    return null
  }
}

function sameGitLockIdentity(left: GitLockIdentity, right: GitLockIdentity | null): boolean {
  return Boolean(
    right && left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs,
  )
}

function sanitizedGitLockRelativePath(path: string): string {
  return path
    .split(sep)
    .join('-')
    .replaceAll(/[^A-Za-z0-9._-]/g, '-')
}

function reclaimGitLock(subject: string, options: Options) {
  const clock = Date.now()
  const observedPath = isAbsolute(subject) ? canonical(subject) : subject
  const identity = gitLockIdentity(subject)
  const ownerPids = identity ? gitLockOwnerPids(subject) : null
  const decision = gitLockReleaseDecision({
    path: observedPath,
    projects: gitLockProjects(),
    exists: identity !== null,
    ownerPids,
    ageMs: identity ? Math.max(0, clock - identity.mtimeMs) : null,
  })
  if (!decision.allowed) return denied(decision)
  const timestamp = new Date(clock).toISOString().replaceAll(':', '-')
  const archive = join(
    concernStateDirectory('orchestrator', process.env),
    'reclaimed-git-locks',
    decision.projectName,
    `${timestamp}-${sanitizedGitLockRelativePath(decision.relativePath)}`,
  )
  if (!options.dryRun) {
    mkdirSync(resolve(archive, '..'), { recursive: true, mode: 0o700 })
    renameSync(subject, archive)
    const archivedIdentity = gitLockIdentity(archive)
    const archivedOwnerPids = archivedIdentity ? gitLockOwnerPids(archive) : null
    if (
      !sameGitLockIdentity(identity!, archivedIdentity) ||
      archivedOwnerPids === null ||
      archivedOwnerPids.length > 0
    ) {
      renameSync(archive, subject)
      return {
        ok: false,
        action: `refused; invariant: the archived lock is the ownerless file that was classified; fix: a replacement or owner raced reclamation, retry after concurrent Git activity stops`,
      }
    }
  }
  const restore = `mv -- ${shellQuote(archive)} ${shellQuote(subject)}`
  return {
    ok: true,
    action: `${options.dryRun ? 'would archive' : 'archived'} git lock ${subject} at ${archive}; restore with: ${restore}`,
  }
}

function projectRunSubject(subject: string): { projectName: string; runId: string } {
  const match = /^([^:]+):(.+)$/.exec(subject)
  if (!match) throw new Error(`subject must be <project>:<run-id>; received ${subject}`)
  return { projectName: match[1]!, runId: match[2]! }
}

function recordedRunProject(runId: string): string | null {
  return (
    (
      db()
        .query(
          `SELECT COALESCE(project.name,r.repo) project
           FROM run r LEFT JOIN project ON project.record_id=r.project_record_id WHERE r.record_id=?`,
        )
        .get(runId) as { project: string | null } | null
    )?.project ?? null
  )
}

function projectMatchesRun(projectName: string, runId: string) {
  const recorded = recordedRunProject(runId)
  return recorded === projectName
    ? null
    : {
        ok: false,
        action: `refused; invariant: run ${runId} belongs to project ${projectName}; fix: use its recorded project ${recorded ?? '(missing)'}`,
      }
}

function conversationRows(runId: string) {
  const owner = db()
    .query('SELECT record_id,parent_run_record_id FROM run WHERE record_id=?')
    .get(runId) as {
    record_id: string
    parent_run_record_id: string | null
  } | null
  if (!owner) return []
  const root = owner.parent_run_record_id ?? owner.record_id
  return db()
    .query(
      'SELECT record_id,status,worktree,pid,agent_pid,agent_pgid FROM run WHERE record_id=? OR parent_run_record_id=?',
    )
    .all(root, root) as {
    record_id: string
    status: string
    worktree: string | null
    pid: number | null
    agent_pid: number | null
    agent_pgid: number | null
  }[]
}

function gitUpdateRef(projectPath: string, ref: string, tip: string): boolean {
  // branch-ref-guard: non-local refs/orch/
  const result = Bun.spawnSync(['git', 'update-ref', '-d', ref, tip], {
    cwd: projectPath,
    env: targetGitEnvironment(projectPath),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return result.exitCode === 0
}

function refTip(projectPath: string, ref: string): string | null {
  const result = Bun.spawnSync(['git', 'rev-parse', '--verify', ref], {
    cwd: projectPath,
    env: targetGitEnvironment(projectPath),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

function reclaimRefGuard(subject: string, options: Options) {
  const { projectName, runId } = projectRunSubject(subject)
  const mismatch = projectMatchesRun(projectName, runId)
  if (mismatch) return mismatch
  const project = projectByName(projectName)
  if (!project)
    return {
      ok: false,
      action: `refused; invariant: project is registered; fix: check ${projectName}`,
    }
  const path = join(projectGitCommonDir(project.path), 'orch-guards', runId)
  const rows = conversationRows(runId)
  const decision = refGuardReleaseDecision({
    exists: existsSync(path),
    worktreeExists: rows.some((row) => Boolean(row.worktree && existsSync(row.worktree))),
    conversationLive: rows.some((row) =>
      runAlive({
        status: row.status,
        lease: runLeaseState(row.record_id),
        pidAlive: pidAlive(row.pid),
      }),
    ),
  })
  if (!decision.allowed && options.absentSatisfies && !existsSync(path)) {
    return { ok: true, action: `ref-guard ${subject} was already absent` }
  }
  if (!decision.allowed) return denied(decision)
  if (!options.dryRun) rmSync(path, { recursive: true })
  return {
    ok: true,
    action: `${options.dryRun ? 'would reclaim' : 'reclaimed'} ref-guard ${subject}`,
  }
}

function reclaimSandbox(subject: string, options: Options) {
  const runId = runSubject(subject)
  const path = join(RUNS_DIR, `sandbox-${runId}`)
  const rows = conversationRows(runId)
  const decision = sandboxReleaseDecision({
    exists: existsSync(path),
    conversationExists: rows.length > 0,
    conversationTerminal: rows.length > 0 && rows.every((row) => terminal(row.status)),
    processAlive: rows.some((row) => {
      const roots = [row.pid, row.agent_pid].filter((pid): pid is number => Boolean(pid && pid > 1))
      return (
        pidAlive(row.pid) ||
        pidAlive(row.agent_pid) ||
        runHasLiveDescendants(roots, [], {}, row.agent_pgid)
      )
    }),
  })
  if (!decision.allowed) return denied(decision)
  if (!options.dryRun) rmSync(path, { recursive: true })
  return { ok: true, action: `${options.dryRun ? 'would reclaim' : 'reclaimed'} sandbox ${runId}` }
}

function reclaimRetainedRef(subject: string, options: Options) {
  const { projectName, runId } = projectRunSubject(subject)
  const mismatch = projectMatchesRun(projectName, runId)
  if (mismatch) return mismatch
  const project = projectByName(projectName)
  if (!project)
    return {
      ok: false,
      action: `refused; invariant: project is registered; fix: check ${projectName}`,
    }
  const ref = `refs/orch/retained/${runId}`
  const tip = refTip(project.path, ref)
  const row = db().query('SELECT status FROM run WHERE record_id=?').get(runId) as {
    status: string
  } | null
  const decision = retainedRefReleaseDecision({
    exists: tip !== null,
    runExists: row !== null,
    terminal: Boolean(row && terminal(row.status)),
  })
  if (!decision.allowed && options.absentSatisfies && tip === null) {
    return { ok: true, action: `retained ref ${subject} was already absent` }
  }
  if (!decision.allowed) return denied(decision)
  if (!options.dryRun && !gitUpdateRef(project.path, ref, tip!)) {
    return {
      ok: false,
      action: `refused; invariant: retained ref remains at its observed tip; fix: retry after concurrent ref activity stops`,
    }
  }
  return {
    ok: true,
    action: `${options.dryRun ? 'would reclaim' : 'reclaimed'} retained ref ${subject} at ${tip}`,
  }
}

function canonical(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : resolve(path)
  } catch {
    return resolve(path)
  }
}

function orchWorktreePath(path: string): boolean {
  return projects().some((project) => {
    const root = resolve(project.path, '.claude', 'worktrees')
    const from = relative(root, path)
    return Boolean(
      from &&
        from !== '..' &&
        !from.startsWith(`..${sep}`) &&
        !isAbsolute(from) &&
        basename(path).startsWith('orch-'),
    )
  })
}

function reclaimTrust(subject: string, options: Options) {
  const runId = runSubject(subject)
  const row = db().query('SELECT mcp_trust_path FROM run WHERE record_id=?').get(runId) as {
    mcp_trust_path: string | null
  } | null
  const recorded = row?.mcp_trust_path ? (JSON.parse(row.mcp_trust_path) as unknown) : []
  const headings =
    Array.isArray(recorded) && recorded.every((item) => typeof item === 'string')
      ? (recorded as string[])
      : []
  if (headings.length !== 1)
    return {
      ok: false,
      action: `refused; invariant: run ${runId} recorded exactly one trust heading; fix: reclaim each unambiguous recorded entry manually`,
    }
  const heading = headings[0]!
  const path = grokTrustPathFromHeading(heading)
  const main = path
    ? projects().some((project) => canonical(project.path) === canonical(path))
    : false
  const decision = trustReleaseDecision({
    recorded: Boolean(row && headings.length === 1),
    pathKnown: path !== null,
    orchWorktreePath: Boolean(path && orchWorktreePath(path)),
    mainCheckout: main,
    pathExists: Boolean(path && existsSync(path)),
    headingExists: grokTrustHeadings().includes(heading),
  })
  if (!decision.allowed) return denied(decision)
  if (!options.dryRun && !removeGrokTrustHeading(grokTrustStorePath(), heading)) {
    return {
      ok: false,
      action:
        'refused; invariant: the recorded heading remains present; fix: retry after the vendor trust file stops changing',
    }
  }
  return {
    ok: true,
    action: `${options.dryRun ? 'would reclaim' : 'reclaimed'} trust heading for run ${runId}: ${heading}`,
  }
}

function reclaimProcess(subject: string, options: Options) {
  const runId = runSubject(subject)
  const row = db()
    .query('SELECT status,agent,agent_pid,agent_start_time FROM run WHERE record_id=?')
    .get(runId) as {
    status: string
    agent: string
    agent_pid: number | null
    agent_start_time: string | null
  } | null
  const alive = Boolean(row?.agent_pid && pidAlive(row.agent_pid))
  const inventory = processTable()
  const command =
    inventory.ascertainable && row?.agent_pid
      ? (inventory.rows.find((item) => item.pid === row.agent_pid)?.command ?? null)
      : null
  const expectedBin = row ? basename(AGENTS[row.agent]?.bin ?? row.agent) : ''
  const decision = processReleaseDecision({
    runExists: row !== null,
    terminal: Boolean(row && terminal(row.status)),
    alive,
    startTimeMatches: Boolean(
      row?.agent_pid &&
        row.agent_start_time &&
        processStartTime(row.agent_pid) === row.agent_start_time,
    ),
    commandMatches: Boolean(
      command &&
        new RegExp(
          `(?:^|[/\\s])${expectedBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`,
        ).test(command),
    ),
    signalAllowed: options.allowSignal,
  })
  if (!decision.allowed) return { ok: false, action: decision.refusal }
  if (!options.dryRun) {
    if (decision.action === 'signal' && row?.agent_pid) process.kill(row.agent_pid, 'SIGTERM')
    writableDb()
    db()
      .query(
        'UPDATE run SET pid=NULL,agent_pid=NULL,agent_pgid=NULL,agent_start_time=NULL WHERE record_id=?',
      )
      .run(runId)
  }
  const verb = options.dryRun ? 'would reclaim' : 'reclaimed'
  return {
    ok: true,
    action: `${verb} process for run ${runId}; ${decision.action === 'signal' ? 'verified identity and signal' : 'identity unverified, recorded pid as released without signaling'}`,
  }
}

function reclaimStaleRun(subject: string, options: Options) {
  const runId = runSubject(subject)
  const row = db()
    .query('SELECT status,evidence_excluded FROM run WHERE record_id=?')
    .get(runId) as {
    status: string
    evidence_excluded: string | null
  } | null
  const decision = staleRunReleaseDecision({
    runId,
    runExists: row !== null,
    status: row?.status ?? null,
    alreadyExcluded: Boolean(row?.evidence_excluded),
  })
  if (!decision.allowed) return denied(decision)
  if (!options.dryRun) {
    writableDb()
    const changedAt = nowIso()
    settleRunEvidence(
      runId,
      `settled by ${PLATFORM_SLUG} machine reclaim stale-run at ${changedAt}`,
      changedAt,
    )
  }
  return {
    ok: true,
    action: `${options.dryRun ? 'would settle' : 'settled'} stale run ${runId} as evidence-excluded`,
  }
}

export function reclaimResidue(kind: ResidueKind, subject: string, options: Options = {}) {
  if (kind === 'git-lock') return reclaimGitLock(subject, options)
  if (kind === 'ref-guard') return reclaimRefGuard(subject, options)
  if (kind === 'sandbox') return reclaimSandbox(subject, options)
  if (kind === 'retained-ref') return reclaimRetainedRef(subject, options)
  if (kind === 'trust') return reclaimTrust(subject, options)
  if (kind === 'process') return reclaimProcess(subject, options)
  return reclaimStaleRun(subject, options)
}
