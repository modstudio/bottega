// concern: reclaim-residue
/** Observes and releases one explicitly named piece of monitor residue. */
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pidAlive } from '../../../shared/process-identity.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { runHasLiveDescendants } from '../idle-kill.ts'
import { processStartTime, projectGitCommonDir } from '../project/project-lock.ts'
import { projectByName, projects } from '../project/projects.ts'
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
  processReleaseDecision,
  type ReleaseDecision,
  refGuardReleaseDecision,
  retainedRefReleaseDecision,
  sandboxReleaseDecision,
  staleRunReleaseDecision,
  trustReleaseDecision,
} from './reclaim-residue-policy.ts'

export type ResidueKind =
  | 'ref-guard'
  | 'sandbox'
  | 'retained-ref'
  | 'trust'
  | 'process'
  | 'stale-run'

type Options = { dryRun?: boolean }
const terminal = (status: string) => ['ok', 'failed', 'stale', 'stopped'].includes(status)
const denied = (decision: Extract<ReleaseDecision, { allowed: false }>) => ({
  ok: false,
  action: decision.refusal,
})

function numericSubject(subject: string): number {
  if (!/^[1-9]\d*$/.test(subject))
    throw new Error(`run subject must be a positive id; received ${subject}`)
  return Number(subject)
}

function projectRunSubject(subject: string): { projectName: string; runId: number } {
  const match = /^([^:]+):([1-9]\d*)$/.exec(subject)
  if (!match) throw new Error(`subject must be <project>:<run-id>; received ${subject}`)
  return { projectName: match[1]!, runId: Number(match[2]) }
}

function conversationRows(runId: number) {
  const owner = db().query('SELECT id,parent_run_id FROM run WHERE id=?').get(runId) as {
    id: number
    parent_run_id: number | null
  } | null
  if (!owner) return []
  const root = owner.parent_run_id ?? owner.id
  return db()
    .query(
      'SELECT id,status,worktree,pid,agent_pid,agent_pgid FROM run WHERE id=? OR parent_run_id=?',
    )
    .all(root, root) as {
    id: number
    status: string
    worktree: string | null
    pid: number | null
    agent_pid: number | null
    agent_pgid: number | null
  }[]
}

function gitUpdateRef(projectPath: string, ref: string, tip: string): boolean {
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
  const project = projectByName(projectName)
  if (!project)
    return {
      ok: false,
      action: `refused; invariant: project is registered; fix: check ${projectName}`,
    }
  const path = join(projectGitCommonDir(project.path), 'orch-guards', String(runId))
  const rows = conversationRows(runId)
  const decision = refGuardReleaseDecision({
    exists: existsSync(path),
    worktreeExists: rows.some((row) => Boolean(row.worktree && existsSync(row.worktree))),
    conversationLive: rows.some((row) =>
      runAlive({
        status: row.status,
        lease: runLeaseState(row.id),
        pidAlive: pidAlive(row.pid),
      }),
    ),
  })
  if (!decision.allowed) return denied(decision)
  if (!options.dryRun) rmSync(path, { recursive: true })
  return {
    ok: true,
    action: `${options.dryRun ? 'would reclaim' : 'reclaimed'} ref-guard ${subject}`,
  }
}

function reclaimSandbox(subject: string, options: Options) {
  const runId = numericSubject(subject)
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
  const project = projectByName(projectName)
  if (!project)
    return {
      ok: false,
      action: `refused; invariant: project is registered; fix: check ${projectName}`,
    }
  const ref = `refs/orch/retained/${runId}`
  const tip = refTip(project.path, ref)
  const row = db().query('SELECT status FROM run WHERE id=?').get(runId) as {
    status: string
  } | null
  const decision = retainedRefReleaseDecision({
    exists: tip !== null,
    runExists: row !== null,
    terminal: Boolean(row && terminal(row.status)),
  })
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
  const runId = numericSubject(subject)
  const row = db().query('SELECT mcp_trust_path FROM run WHERE id=?').get(runId) as {
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
  const runId = numericSubject(subject)
  const row = db()
    .query('SELECT status,agent,agent_pid,agent_start_time FROM run WHERE id=?')
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
  })
  if (!decision.allowed) return { ok: false, action: decision.refusal }
  if (!options.dryRun) {
    if (decision.action === 'signal' && row?.agent_pid) process.kill(row.agent_pid, 'SIGTERM')
    writableDb()
    db()
      .query(
        'UPDATE run SET pid=NULL,agent_pid=NULL,agent_pgid=NULL,agent_start_time=NULL WHERE id=?',
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
  const runId = numericSubject(subject)
  const row = db().query('SELECT status,evidence_excluded FROM run WHERE id=?').get(runId) as {
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
    writeTransaction(() =>
      db()
        .query('UPDATE run SET evidence_excluded=? WHERE id=?')
        .run(`settled by orch reclaim stale-run at ${nowIso()}`, runId),
    )
  }
  return {
    ok: true,
    action: `${options.dryRun ? 'would settle' : 'settled'} stale run ${runId} as evidence-excluded`,
  }
}

export function reclaimResidue(kind: ResidueKind, subject: string, options: Options = {}) {
  if (kind === 'ref-guard') return reclaimRefGuard(subject, options)
  if (kind === 'sandbox') return reclaimSandbox(subject, options)
  if (kind === 'retained-ref') return reclaimRetainedRef(subject, options)
  if (kind === 'trust') return reclaimTrust(subject, options)
  if (kind === 'process') return reclaimProcess(subject, options)
  return reclaimStaleRun(subject, options)
}
