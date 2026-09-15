// concern: monitor
/** Owns monitor pass composition, persistence, history, and human-readable reporting. */

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { allInjectChecks, storedPackDrift } from './canon.ts'
import { db, nowIso, writableDb, writeTransaction } from './db.ts'
import {
  classifiedDockerResources,
  dockerNetworkInventory,
  dockerRunResources,
} from './docker-resources.ts'
import { gitLocks } from './git-locks.ts'
import { grokTrustHeadings } from './grok-trust.ts'
import { fileIssue } from './mcp.ts'
import {
  age,
  askingRuns,
  deadRunningProcessConditions,
  dockerConditions,
  git,
  idleRunConditions,
  orphanDockerNetworkConditions,
  orphanSandboxDirectoryConditions,
  reconcileHub,
  refGuardConditions,
  retainedRefConditions,
  rulingConditions,
  staleTrustEntryConditions,
  terminalCloseOutRuns,
  terminalProcessAliveConditions,
  unscoredRuns,
  unsettledClaimConditions,
  unsettledClaimInventory,
  worktreeDatabaseConditions,
} from './monitor-conditions.ts'
import type {
  HumanMonitorCondition,
  MonitorCondition,
  MonitorHistoryRow,
  MonitorResult,
} from './monitor-types.ts'
import { pidAlive } from './process-liveness.ts'
import { projectLockState } from './project-lock.ts'
import { projectAt, projects } from './projects.ts'
import { reclaimBranch, reclaimWorktree } from './reclaim.ts'
import { terminalDockerRetentionReasonForRun } from './resource-ownership.ts'
import type { MonitorSeverity } from './review-vocabulary.ts'
import { RUNS_DIR } from './run-artifacts.ts'
import { worktreeDirty } from './worktree-attribution.ts'

const TERMINAL_STATUSES = new Set(['ok', 'failed', 'stale', 'stopped'])

function directorySize(path: string): number {
  const entry = lstatSync(path)
  if (!entry.isDirectory()) return entry.size
  return readdirSync(path).reduce((total, name) => total + directorySize(join(path, name)), 0)
}

function sandboxDirectoryInventory(database: ReturnType<typeof db>) {
  try {
    const directories = existsSync(RUNS_DIR)
      ? readdirSync(RUNS_DIR, { withFileTypes: true }).flatMap((entry) => {
          const match = entry.isDirectory() ? /^sandbox-([1-9]\d*)$/.exec(entry.name) : null
          if (!match) return []
          const path = join(RUNS_DIR, entry.name)
          return [{ rootId: Number(match[1]), path, sizeBytes: directorySize(path) }]
        })
      : []
    const rows = database.query('SELECT id, parent_run_id, status FROM run').all() as {
      id: number
      parent_run_id: number | null
      status: string
    }[]
    const statuses = new Map<number, string[]>()
    for (const row of rows) {
      const rootId = row.parent_run_id ?? row.id
      statuses.set(rootId, [...(statuses.get(rootId) ?? []), row.status])
    }
    return {
      ascertainable: true as const,
      directories,
      conversations: [...statuses].map(([rootId, values]) => ({
        rootId,
        terminal: values.length > 0 && values.every((status) => TERMINAL_STATUSES.has(status)),
      })),
    }
  } catch (error) {
    return {
      ascertainable: false as const,
      reason: `sandbox directory inventory unavailable: ${(error as Error).message}`,
    }
  }
}

function trustEntryInventory(database: ReturnType<typeof db>) {
  try {
    const rows = database
      .query(
        'SELECT id, worktree, mcp_trust_path FROM run WHERE worktree IS NOT NULL AND mcp_trust_path IS NOT NULL',
      )
      .all() as { id: number; worktree: string; mcp_trust_path: string }[]
    const present = new Set(grokTrustHeadings())
    const entries = rows.flatMap((row) => {
      const headings = JSON.parse(row.mcp_trust_path) as unknown
      if (!Array.isArray(headings) || headings.some((heading) => typeof heading !== 'string')) {
        throw new Error(`run ${row.id} mcp_trust_path is not a JSON string array`)
      }
      return (headings as string[])
        .filter((heading) => present.has(heading))
        .map((heading) => ({
          runId: row.id,
          heading: heading as string,
          worktreeExists: existsSync(row.worktree),
        }))
    })
    return { ascertainable: true as const, entries }
  } catch (error) {
    return {
      ascertainable: false as const,
      reason: `Grok trust inventory unavailable: ${(error as Error).message}`,
    }
  }
}

function observedDockerNetworkInventory(database: ReturnType<typeof db>) {
  const inventory = dockerNetworkInventory()
  if (!inventory.ascertainable) return inventory
  const ownership = new Map<number, { statuses: string[]; worktrees: string[] }>()
  const rows = database.query('SELECT id, parent_run_id, status, worktree FROM run').all() as {
    id: number
    parent_run_id: number | null
    status: string
    worktree: string | null
  }[]
  for (const row of rows) {
    const rootId = row.parent_run_id ?? row.id
    const owner = ownership.get(rootId) ?? { statuses: [], worktrees: [] }
    owner.statuses.push(row.status)
    if (row.worktree) owner.worktrees.push(row.worktree)
    ownership.set(rootId, owner)
  }
  return {
    ascertainable: true as const,
    networks: inventory.networks.map((network) => ({
      ...network,
      workingDirExists: network.workingDir !== null && existsSync(network.workingDir),
    })),
    owners: [...ownership].map(([rootId, owner]) => ({
      rootId,
      terminal:
        owner.statuses.length > 0 &&
        owner.statuses.every((status) => TERMINAL_STATUSES.has(status)),
      hasWorktree: owner.worktrees.some((worktree) => existsSync(worktree)),
    })),
  }
}

/** Format one monitor pass identically wherever its human-readable history is printed. */
export function formatMonitorPass(heading: string, conditions: HumanMonitorCondition[]): string[] {
  const lines = [heading]
  if (conditions.some((condition) => condition.kind === 'observation-error')) {
    lines.push('PARTIAL: the condition list is incomplete because one or more observations failed.')
  }
  for (const condition of conditions) {
    const old =
      condition.ageMs == null ? 'age unknown' : `${Math.round(condition.ageMs / 60_000)}m old`
    const sev = condition.severity ? `  ${condition.severity}` : ''
    const owner = condition.ownerSession ? `  owner ${condition.ownerSession}` : ''
    lines.push(
      `  ${condition.kind}${sev}  ${condition.subject}  ${old}${owner}\n    ${condition.detail}\n    ${condition.action}${condition.issueKey ? `; ${condition.issueKey}` : ''}`,
    )
  }
  return lines
}

/** Observe machine state, record the pass, and make no judgement-shaped repair. */
export async function monitor(
  trigger: 'invoked' | 'backstop' = 'invoked',
  clock = Date.now(),
): Promise<MonitorResult> {
  const database = writableDb()
  const startedAt = new Date(clock).toISOString()
  const invocationRow = database
    .query('INSERT INTO monitor_invocation (started_at, trigger) VALUES (?,?) RETURNING id')
    .get(startedAt, trigger) as { id: number }
  const invocation = invocationRow.id
  const conditions: MonitorCondition[] = []
  const errors: string[] = []
  const canonRows = allInjectChecks()
  const canon = {
    findings: canonRows.reduce(
      (n, row) => n + row.findings.filter((finding) => finding.kind !== 'unchecked').length,
      0,
    ),
    docs: canonRows.filter((row) => row.findings.some((finding) => finding.kind !== 'unchecked'))
      .length,
  }
  const add = (condition: Omit<MonitorCondition, 'ageMs'> & { ageMs?: number | null }) =>
    conditions.push({ ...condition, ageMs: condition.ageMs ?? age(condition.since, clock) })
  const reclaimProject = projectAt(process.cwd())

  const asking = askingRuns(database)
  for (const run of asking)
    add({
      kind: 'asking-run',
      subject: `run:${run.id}`,
      since: run.started_at,
      detail: `run ${run.id} is waiting on a ruling; session ${run.session_id ?? 'unknown'}`,
      action: 'reported; abandoning or resuming is an intent decision',
      ownerSession: run.session_id,
    })

  conditions.push(...deadRunningProcessConditions(clock))
  conditions.push(...idleRunConditions(clock))

  const closeOuts = terminalCloseOutRuns(database)
  for (const run of closeOuts)
    add({
      kind: `terminal-close-out-${run.close_out_outcome}`,
      subject: `run:${run.id}`,
      since: run.close_out_attempted_at,
      detail: run.close_out_detail ?? `terminal run ${run.id} close-out ${run.close_out_outcome}`,
      action: `run orch close-out ${run.id}`,
      ownerSession: run.session_id,
    })

  const runDocker = dockerRunResources()
  if (!runDocker.ascertainable) errors.push(runDocker.reason)
  const runDockerResources = runDocker.ascertainable ? runDocker.resources : []
  const dockerOwnerIds = new Set(runDockerResources.map(({ runId }) => runId))
  const dockerOwners = (
    database.query('SELECT id, repo, worktree, status FROM run').all() as {
      id: number
      repo: string | null
      worktree: string | null
      status: string
    }[]
  ).map((owner) => ({
    ...owner,
    retentionReason: dockerOwnerIds.has(owner.id)
      ? terminalDockerRetentionReasonForRun(database, owner.id)
      : null,
  }))
  for (const item of classifiedDockerResources(runDockerResources, dockerOwners)) {
    if (item.condition !== 'retained-worktree-resources') continue
    add({
      kind: 'retained-worktree-docker-resource',
      subject: item.resource.name,
      since: null,
      severity: 'informational',
      detail:
        `${item.resource.kind} belongs to terminal run ${item.resource.runId}; ` +
        (item.reason
          ? `removal could not be ascertained: ${item.reason}`
          : 'its worktree is retained'),
      action: 'informational; retained resources require review before any removal',
      affectedProject: item.project,
    })
  }

  const stale = database
    .query(`SELECT id, started_at, error, session_id FROM run WHERE status='stale'`)
    .all() as { id: number; started_at: string; error: string | null; session_id: string | null }[]
  for (const run of stale)
    add({
      kind: 'stale-run',
      subject: `run:${run.id}`,
      since: run.started_at,
      detail: run.error ?? `run ${run.id} is stale`,
      action: 'reported; disposition requires intent',
      ownerSession: run.session_id,
    })

  conditions.push(...terminalProcessAliveConditions(clock))

  const unscored = unscoredRuns(database)
  for (const run of unscored)
    add({
      kind: 'unscored-run',
      subject: `run:${run.id}`,
      since: run.started_at,
      detail: `completed run ${run.id} has no score`,
      action: 'reported; only its owning reader may score it',
      ownerSession: run.session_id,
    })

  for (const project of projects()) {
    for (const lockName of ['create', 'cleanup']) {
      try {
        const state = projectLockState(project.path, lockName)
        if (state.holder && !pidAlive(state.holder.pid))
          add({
            kind: 'dead-lock',
            subject: state.path,
            since: state.holder.since,
            detail: `${project.name} ${lockName} lock belongs to dead pid ${state.holder.pid}`,
            action: 'reported; no standalone reclaim command exists',
            affectedProject: project.name,
          })
      } catch (cause) {
        errors.push(`${project.name} lock inventory: ${String((cause as Error).message ?? cause)}`)
      }
    }

    try {
      for (const lock of gitLocks(project.path, clock)) {
        const owner =
          lock.ownerPids === null
            ? 'owner pid could not be inspected'
            : lock.ownerPids.length
              ? `owner pid ${lock.ownerPids.join(', ')} is alive`
              : 'no owning pid is alive'
        const resolved = lock.contentRefs.length
          ? `; resolves to ${lock.contentRefs.join(', ')}`
          : ''
        add({
          kind: lock.ownerPids === null || lock.ownerPids.length ? 'git-lock' : 'dead-lock',
          subject: lock.path,
          since: lock.since,
          detail:
            `${project.name} git lock targets ${lock.target ?? 'an unknown primitive'}; ` +
            `contents ${lock.contents || '(empty)'}${resolved}; ${owner}`,
          action: 'reported; lock and its recoverable contents were not removed',
          affectedProject: project.name,
        })
      }
    } catch (cause) {
      errors.push(
        `${project.name} git lock inventory: ${String((cause as Error).message ?? cause)}`,
      )
    }

    const root = join(project.path, '.claude', 'worktrees')
    if (existsSync(root))
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const path = realpathSync(join(root, entry.name))
        const live = database
          .query(`SELECT 1 FROM run WHERE worktree=? AND status IN ('running','asking') LIMIT 1`)
          .get(path)
        const since = new Date(statSync(path).mtimeMs).toISOString()
        if (!live) {
          let action: string
          if (reclaimProject?.name !== project.name) {
            action = `reported; reclaim refused by monitor scope: ${project.name} is outside invoked project ${reclaimProject?.name ?? 'unknown'}`
          } else {
            try {
              action = reclaimWorktree(path, { clock, dryRun: true }).action
            } catch (cause) {
              action = `reported; reclaim errored: ${String((cause as Error).message ?? cause)}`
            }
          }
          add({
            kind: 'worktree-without-live-run',
            subject: path,
            since,
            detail: `${project.name} worktree has no running or asking run`,
            action,
            affectedProject: project.name,
          })
        }
      }

    const heldTrees = database
      .query(
        `SELECT MIN(id) id, worktree, MAX(keep_tree) keep_tree, MIN(started_at) started_at
         FROM run WHERE repo=? AND worktree IS NOT NULL
          AND status IN ('ok','failed','stale','stopped')
        GROUP BY worktree`,
      )
      .all(project.name) as {
      id: number
      worktree: string
      keep_tree: number
      started_at: string
    }[]
    for (const held of heldTrees) {
      if (!existsSync(held.worktree)) continue
      const dirty = held.keep_tree ? null : worktreeDirty(held.worktree)
      if (!held.keep_tree && !dirty?.dirty) continue
      const ageMs = age(held.started_at, clock)
      const explicit = Boolean(held.keep_tree)
      add({
        kind: explicit ? 'explicitly-held-worktree' : 'held-worktree',
        subject: held.worktree,
        since: held.started_at,
        detail: explicit
          ? `run ${held.id} retained by explicit --keep-tree`
          : `run ${held.id} ${dirty!.detail}`,
        action: explicit
          ? `clear with orch discard ${held.id}`
          : `commit or remove the work, then run orch close-out ${held.id}`,
        severity: ageMs !== null && ageMs >= 48 * 60 * 60 * 1000 ? 'attention' : 'informational',
      })
    }

    const worktreeRefs = new Set(
      (git(project.path, ['worktree', 'list', '--porcelain']) ?? '')
        .split('\n')
        .filter((line) => line.startsWith('branch refs/heads/'))
        .map((line) => line.slice(18)),
    )
    const branches = database
      .query(
        `SELECT minted_branch branch, MIN(started_at) started_at FROM run
        WHERE repo=? AND minted_branch IS NOT NULL GROUP BY minted_branch`,
      )
      .all(project.name) as { branch: string; started_at: string }[]
    for (const branch of branches) {
      if (worktreeRefs.has(branch.branch)) continue
      if (
        git(project.path, ['show-ref', '--verify', '--quiet', `refs/heads/${branch.branch}`]) ===
        null
      )
        continue
      const subject = `${project.name}:${branch.branch}`
      let action: string
      if (reclaimProject?.name !== project.name) {
        action = `reported; reclaim refused by monitor scope: ${project.name} is outside invoked project ${reclaimProject?.name ?? 'unknown'}`
      } else {
        try {
          action = reclaimBranch(subject, { dryRun: true }).action
        } catch (cause) {
          action = `reported; reclaim errored: ${String((cause as Error).message ?? cause)}`
        }
      }
      add({
        kind: 'branch-without-worktree',
        subject,
        since: branch.started_at,
        detail: `${project.name} branch ${branch.branch} has no worktree`,
        action,
        affectedProject: project.name,
      })
    }
  }

  const hub = reconcileHub(clock)
  conditions.push(...hub.conditions)
  errors.push(...hub.errors)
  const rulings = rulingConditions(clock)
  conditions.push(...rulings.conditions)
  errors.push(...rulings.errors)
  const docker = dockerConditions(clock)
  conditions.push(...docker.conditions)
  errors.push(...docker.errors)
  const networkConditions = orphanDockerNetworkConditions(
    observedDockerNetworkInventory(database),
    clock,
  )
  conditions.push(...networkConditions.conditions)
  errors.push(...networkConditions.errors)

  const sandboxDirectories = orphanSandboxDirectoryConditions(sandboxDirectoryInventory(database))
  conditions.push(...sandboxDirectories.conditions)
  errors.push(...sandboxDirectories.errors)

  const unsettledClaims = unsettledClaimConditions(unsettledClaimInventory(database), clock)
  conditions.push(...unsettledClaims.conditions)
  errors.push(...unsettledClaims.errors)

  const trustEntries = staleTrustEntryConditions(trustEntryInventory(database))
  conditions.push(...trustEntries.conditions)
  errors.push(...trustEntries.errors)
  const worktreeDatabases = worktreeDatabaseConditions(clock)
  conditions.push(...worktreeDatabases.conditions)
  errors.push(...worktreeDatabases.errors)
  const retainedRefs = retainedRefConditions(clock)
  conditions.push(...retainedRefs.conditions)
  errors.push(...retainedRefs.errors)
  const refGuards = refGuardConditions(clock)
  conditions.push(...refGuards.conditions)
  errors.push(...refGuards.errors)

  for (const drift of storedPackDrift())
    add({
      kind: 'canon-pack-drift',
      subject: `${drift.job}/${drift.project ?? '_'}`,
      since: null,
      detail: `${drift.removed.length} docs removed; ${drift.bytesDelta} bytes versus stored pack`,
      action: 'reported; dispatch is not blocked by pack drift',
    })

  // A tool that could not look has not established emptiness. Persist the
  // exact refusal beside findings so history is useful after launchd's process
  // log has rotated away.
  errors.forEach((detail, index) => {
    add({
      kind: 'observation-error',
      subject: `invocation:${invocation}:${index + 1}`,
      since: startedAt,
      detail,
      action: 'reported; no state was inferred from the unavailable observation',
    })
  })

  // Delivery inheritance is one atomic read/write unit. Two monitor passes may
  // otherwise both observe no prior delivery and create duplicate pending rows.
  writeTransaction(() => {
    const insert = database.query(
      `INSERT INTO monitor_condition
        (invocation_id,kind,subject,condition_since,age_ms,detail,action,issue_key,severity,
         owner_session_id,delivered_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const priorDelivery = database.query(
      `SELECT delivered_at FROM monitor_condition
        WHERE kind=? AND subject=? AND condition_since IS ? AND owner_session_id IS ?
          AND delivered_at IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
    )
    for (const c of conditions) {
      const owner = c.ownerSession ?? null
      const prior = owner
        ? (priorDelivery.get(c.kind, c.subject, c.since, owner) as { delivered_at: string } | null)
        : null
      insert.run(
        invocation,
        c.kind,
        c.subject,
        c.since,
        c.ageMs,
        c.detail,
        c.action,
        c.issueKey ?? null,
        c.severity ?? null,
        owner,
        prior?.delivered_at ?? null,
      )
    }
  }, database)

  const unavailable = conditions.filter(
    (c) => c.kind === 'detector-unavailable' || c.kind === 'dead-lock',
  )
  for (const condition of unavailable) {
    const prior = database
      .query(
        `SELECT issue_key FROM monitor_condition
        WHERE kind=? AND subject=? AND issue_key IS NOT NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(condition.kind, condition.subject) as { issue_key: string } | null
    if (prior) {
      condition.issueKey = prior.issue_key
      continue
    }
    try {
      const filed = await fileIssue(
        {
          kind: 'defect',
          title: `Monitor cannot safely handle ${condition.subject}`,
          what_happened: `Monitor cannot safely handle ${condition.subject}: ${condition.detail}`,
          expected:
            'The monitor needs a machine-readable detector or an established command so it can report or repair this condition without inference or direct database writes.',
          reproduce_command: 'orch monitor',
          environment: `monitor invocation ${invocation}; affected machine/project is named in the evidence`,
          evidence: `monitor invocation ${invocation}; ${condition.kind} ${condition.subject}; ${condition.detail}`,
          not_established:
            'The missing interface design and remediation policy are not established by the monitor.',
        },
        {
          kind: 'monitor',
          invocationId: invocation,
          affectedProject: condition.affectedProject ?? PLATFORM_SLUG,
        },
        PLATFORM_SLUG,
      )
      condition.issueKey = filed.key
      database
        .query(
          'UPDATE monitor_condition SET issue_key=? WHERE invocation_id=? AND kind=? AND subject=?',
        )
        .run(filed.key, invocation, condition.kind, condition.subject)
    } catch (cause) {
      errors.push(
        `could not file ${condition.kind} issue: ${String((cause as Error).message ?? cause)}`,
      )
    }
  }

  const finishedAt = nowIso()
  database
    .query('UPDATE monitor_invocation SET finished_at=?, findings=?, errors=? WHERE id=?')
    .run(finishedAt, conditions.length, errors.length, invocation)
  return { id: invocation, startedAt, finishedAt, trigger, conditions, errors, canon }
}

export function monitorHistory(limit = 20): MonitorHistoryRow[] {
  return (
    db()
      .query(
        `SELECT i.*, (SELECT json_group_array(json_object(
       'kind',c.kind,'subject',c.subject,'condition_since',c.condition_since,
       'age_ms',c.age_ms,'detail',c.detail,'action',c.action,'issue_key',c.issue_key,
       'severity',c.severity
       ,'owner_session_id',c.owner_session_id,'delivered_at',c.delivered_at
     )) FROM monitor_condition c WHERE c.invocation_id=i.id) conditions
       FROM monitor_invocation i ORDER BY i.id DESC LIMIT ?`,
      )
      .all(limit) as (Omit<MonitorHistoryRow, 'conditions'> & { conditions: string | null })[]
  ).map((row) => ({ ...row, conditions: JSON.parse(row.conditions ?? '[]') as unknown[] }))
}

/**
 * Map one stored history row's snake_case condition onto the printable shape.
 * Lives beside monitorHistory so the persisted column names are normalised in
 * one place rather than at each call site that wants to print them.
 */
export function displayConditions(conditions: unknown[]): HumanMonitorCondition[] {
  return conditions.map((raw): HumanMonitorCondition => {
    const condition = raw as {
      kind: string
      subject: string
      age_ms: number | null
      detail: string
      action: string
      issue_key?: string | null
      severity?: MonitorSeverity | null
      owner_session_id?: string | null
    }
    return {
      kind: condition.kind,
      subject: condition.subject,
      ageMs: condition.age_ms,
      detail: condition.detail,
      action: condition.action,
      issueKey: condition.issue_key,
      severity: condition.severity,
      ownerSession: condition.owner_session_id,
    }
  })
}
