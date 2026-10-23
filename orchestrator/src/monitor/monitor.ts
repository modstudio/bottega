// concern: monitor
/** Owns monitor pass composition, persistence, history, and human-readable reporting. */

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { isDatabaseLocked } from '../../../shared/database-lock-refusal.ts'
import { pidAlive } from '../../../shared/process-identity.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { boardEscalations } from '../board/board-service.ts'
import { storedPackDrift } from '../canon/canon.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { sampleHostLoad } from '../host-load-sample.ts'
import { sampleHostPressure } from '../host-pressure/host-pressure-service.ts'
import { fileIssue } from '../mcp/mcp.ts'
import { projectLockState } from '../project/project-lock.ts'
import {
  absentTreeTeardownPlan,
  isProjectRepository,
  type Project,
  projectAt,
  projectByName,
  projects,
  resolvedWorktreeTool,
} from '../project/projects.ts'
import { observeRecipeDatabaseConnections } from '../recipe/database-connection-observation.ts'
import { observeRecipeDatabases } from '../recipe/database-inventory.ts'
import { reclaimBranchesDryRun, reclaimWorktree } from '../reclaim/reclaim.ts'
import {
  classifiedDockerResources,
  dockerNetworkInventory,
  dockerRunResources,
  orchRunLabelForRun,
} from '../resources/docker-resources.ts'
import { gitLocks, shellQuote, worktreeIndexLockForPath } from '../resources/git-locks.ts'
import { currentOrphanProcesses } from '../resources/process-inventory.ts'
import { terminalDockerRetentionReasonForRun } from '../resources/resource-ownership.ts'
import type { MonitorSeverity } from '../review/review-vocabulary.ts'
import { grokTrustHeadings, grokTrustPathFromHeading } from '../sandbox/grok-trust.ts'
import { keepTreeHold } from '../worktree/keep-tree-hold.ts'
import { worktreeDirty } from '../worktree/worktree-attribution.ts'
import { missingPrunableWorktrees } from '../worktree/worktree-porcelain.ts'
import { treeDatabaseConnectionConditions } from './database-connection-conditions.ts'
import { hostPressureObservation, persistedHostPressureDetail } from './host-pressure-conditions.ts'
import { branchInventoryDecision, branchMonitorConditions } from './monitor-branches.ts'
import { observeProjectCanonDrift } from './monitor-canon-drift.ts'
import { monitorCanonSummary } from './monitor-canon-summary.ts'
import {
  abandonedBootstrapConditions,
  age,
  askingRuns,
  deadRunningProcessConditions,
  dockerConditions,
  git,
  hookTreeConditions,
  idleRunConditions,
  orphanRecipeDatabaseConditions,
  reconcileHub,
  refGuardConditions,
  retainedRefConditions,
  rulingConditions,
  sandboxDirectoryInventory,
  staleRunConditions,
  stalledRunConditions,
  terminalCloseOutRuns,
  terminalProcessAliveConditions,
  unscoredRuns,
  unsettledClaimConditions,
  unsettledClaimInventory,
  worktreeDatabaseConditions,
} from './monitor-conditions.ts'
import { staleCustomerGuideCommandConditions } from './monitor-customer-guides.ts'
import { workerGateToolingConditions } from './monitor-gate-tooling.ts'
import { observeProjectHarnessLoad } from './monitor-harness-load.ts'
import { outboxConditions } from './monitor-outbox.ts'
import { observeRecordTunnel } from './monitor-record-tunnel.ts'
import { finishMonitorResult as finish } from './monitor-result.ts'
import { observeRetrievalPins } from './monitor-retrieval-pins.ts'
import { strayWorktreeConditions } from './monitor-stray-worktrees.ts'
import type {
  AddressedMonitorCondition,
  HumanMonitorCondition,
  MonitorCondition,
  MonitorHistoryRow,
  MonitorNoticeKind,
  MonitorResult,
  UnaddressedMonitorCondition,
} from './monitor-types.ts'
import { observedOrphanComposeConditions } from './orphan-compose-observation.ts'
import {
  orphanDockerNetworkConditions,
  orphanSandboxDirectoryConditions,
  staleTrustEntryConditions,
} from './orphan-inventory-conditions.ts'
import { orphanProcessConditions } from './orphan-processes.ts'
import { observeRatchetedRuleRefills } from './ratcheted-rule-conditions.ts'
import { observeProjectReleaseLive } from './release-live-observation.ts'
import { diskPressureObservation } from './storage-report.ts'

const TERMINAL_STATUSES = new Set(['ok', 'failed', 'stale', 'stopped'])
const TERMINAL_CLOSE_OUT_NOTICE_KINDS = {
  held: 'terminal-close-out-held',
  failed: 'terminal-close-out-failed',
} as const satisfies Record<'held' | 'failed', MonitorNoticeKind>

function monitorBranchReclaimActions(
  scopeProject: string | null,
  project: string,
  branches: readonly string[],
): Map<string, string> {
  if (scopeProject === project) return reclaimBranchesDryRun(project, branches)
  const action = `reported; reclaim refused by monitor scope: ${project} is outside invoked project ${scopeProject ?? 'unknown'}`
  return new Map(branches.map((branch) => [branch, action]))
}

async function initialMonitorObservations(
  database: ReturnType<typeof writableDb>,
  clock: number,
): Promise<{
  conditions: MonitorCondition[]
  errors: string[]
  hostPressure: MonitorResult['hostPressure']
}> {
  const diskPressure = await diskPressureObservation(clock)
  const hostPressure = hostPressureObservation(database, clock)
  return {
    conditions: [
      ...hostPressure.conditions,
      ...staleCustomerGuideCommandConditions(),
      ...diskPressure.conditions,
    ],
    errors: diskPressure.errors,
    hostPressure: hostPressure.report,
  }
}

function recipeDatabaseObservations(
  project: Project,
  database: ReturnType<typeof db>,
): { conditions: MonitorCondition[]; errors: string[] } {
  const recipePath = resolvedWorktreeTool(project)?.recipePath
  if (!recipePath) return { conditions: [], errors: [] }
  const inventory = observeRecipeDatabases({
    project: project.name,
    projectRoot: project.path,
    recipePath,
  })
  const claims = (
    database
      .query(
        `SELECT allocation_key,state FROM resource_claim
         WHERE project_record_id=? AND kind='database'`,
      )
      .all(project.recordId) as { allocation_key: string; state: string }[]
  ).map((claim) => ({ allocationKey: claim.allocation_key, state: claim.state }))
  const connectionInventory = observeRecipeDatabaseConnections({
    project: project.name,
    projectRoot: project.path,
    recipePath,
  })
  const owners = (
    database
      .query(
        `SELECT allocation_key,root_run_record_id FROM resource_claim
         WHERE project_record_id=? AND kind='database' AND state IN ('claimed','retained')`,
      )
      .all(project.recordId) as { allocation_key: string; root_run_record_id: string }[]
  )
    .filter((claim) => claim.allocation_key.startsWith('postgres:'))
    .map((claim) => ({
      database: claim.allocation_key.slice('postgres:'.length),
      ownerLabel: orchRunLabelForRun(claim.root_run_record_id),
    }))
  return {
    conditions: [
      ...inventory.observations.flatMap((namespace) =>
        orphanRecipeDatabaseConditions(namespace, claims),
      ),
      ...connectionInventory.observations.flatMap((observation) =>
        treeDatabaseConnectionConditions({ ...observation, owners }),
      ),
    ],
    errors: [...inventory.errors, ...connectionInventory.errors],
  }
}

export function prunableWorktreeAction(
  projectPath: string,
  worktreePath: string,
  commonDir: string,
): string {
  const lock = worktreeIndexLockForPath(commonDir, worktreePath)
  return lock
    ? `resolve ${lock} before running git -C ${projectPath} worktree prune`
    : `git -C ${projectPath} worktree prune`
}

function prunableWorktreeConditions(project: Pick<Project, 'name' | 'path'>): MonitorCondition[] {
  const porcelain = git(project.path, ['worktree', 'list', '--porcelain']) ?? ''
  const commonValue = git(project.path, ['rev-parse', '--git-common-dir'])
  const commonDir = commonValue ? resolve(project.path, commonValue) : null
  return missingPrunableWorktrees(porcelain, existsSync).map((worktree) => ({
    kind: 'prunable-worktree',
    subject: worktree.path,
    since: null,
    ageMs: null,
    detail: `${project.name} has a missing worktree entry; Git reports ${worktree.reason}`,
    action: commonDir
      ? prunableWorktreeAction(project.path, worktree.path, commonDir)
      : `git -C ${project.path} worktree prune`,
    affectedProject: project.name,
  }))
}

function gitLockConditions(
  project: Pick<Project, 'name' | 'path'>,
  clock: number,
): MonitorCondition[] {
  const conditions = prunableWorktreeConditions(project)
  for (const lock of gitLocks(project.path, clock)) {
    const owner =
      lock.ownerPids === null
        ? 'owner pid could not be inspected'
        : lock.ownerPids.length
          ? `owner pid ${lock.ownerPids.join(', ')} is alive`
          : 'no owning pid is alive'
    const resolved = lock.contentRefs.length ? `; resolves to ${lock.contentRefs.join(', ')}` : ''
    conditions.push({
      kind: lock.ownerPids === null || lock.ownerPids.length ? 'git-lock' : 'reclaimable-git-lock',
      subject: lock.path,
      since: lock.since,
      ageMs: age(lock.since, clock),
      detail:
        `${project.name} git lock targets ${lock.target ?? 'an unknown primitive'}; ` +
        `contents ${lock.contents || '(empty)'}${resolved}; ${owner}`,
      action:
        lock.ownerPids !== null && lock.ownerPids.length === 0
          ? `run ${PLATFORM_SLUG} machine reclaim git-lock ${shellQuote(lock.path)}`
          : 'reported; lock and its recoverable contents were not removed',
      affectedProject: project.name,
    })
  }
  return conditions
}

function worktreesWithoutLiveRuns(input: {
  project: { name: string; path: string }
  reclaimProject: { name: string } | null
  database: ReturnType<typeof db>
  clock: number
}): MonitorCondition[] {
  const root = join(input.project.path, '.claude', 'worktrees')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || !existsSync(join(root, entry.name, '.git'))) return []
    const path = realpathSync(join(root, entry.name))
    const live = input.database
      .query(`SELECT 1 FROM run WHERE worktree=? AND status IN ('running','asking') LIMIT 1`)
      .get(path)
    if (live) return []
    let action: string
    if (input.reclaimProject?.name !== input.project.name) {
      action = `reported; reclaim refused by monitor scope: ${input.project.name} is outside invoked project ${input.reclaimProject?.name ?? 'unknown'}`
    } else {
      try {
        action = reclaimWorktree(path, { clock: input.clock, dryRun: true }).action
      } catch (cause) {
        action = `reported; reclaim errored: ${String((cause as Error).message ?? cause)}`
      }
    }
    const since = new Date(statSync(path).mtimeMs).toISOString()
    return [
      {
        kind: 'worktree-without-live-run',
        subject: path,
        since,
        ageMs: age(since, input.clock),
        detail: `${input.project.name} worktree has no running or asking run`,
        action,
        affectedProject: input.project.name,
      },
    ]
  })
}

function retainedDockerResourceAction(
  owner: {
    record_id: string
    repo: string | null
    status: string
    worktree: string | null
    worktree_source: 'recipe' | 'git' | 'clone' | 'readonly_recipe' | null
    recipe_snapshot: string | null
    resource_teardown: 'pending' | 'done' | null
  } | null,
): string {
  const terminal = owner && TERMINAL_STATUSES.has(owner.status)
  const project = owner?.repo ? projectByName(owner.repo) : null
  const teardownPlan = owner
    ? absentTreeTeardownPlan({
        recipeSnapshot: owner.recipe_snapshot,
        worktreeSource: owner.worktree_source,
        resourceTeardown: owner.resource_teardown,
        registeredRemoveCommand: Boolean(resolvedWorktreeTool(project)?.remove),
      })
    : false
  return terminal && owner.worktree && !existsSync(owner.worktree) && teardownPlan
    ? `run ${PLATFORM_SLUG} run close-out ${owner.record_id}`
    : 'informational; retained resources require review before any removal'
}

function unattributableDockerConditions(inventory: ReturnType<typeof dockerRunResources>) {
  if (!inventory.ascertainable) return []
  return (inventory.unattributable ?? []).flatMap((resource) =>
    resource.composeProject && !existsSync(resource.workingDir)
      ? []
      : [
          {
            kind: 'retained-worktree-docker-resource' as const,
            subject: resource.name,
            since: null,
            severity: 'informational' as const,
            detail: `${resource.kind} ownership cannot be established: ${resource.reason}`,
            action: 'report only; add an orchestrator run label or attributable compose identity',
          },
        ],
  )
}

function appendOrphanProcessObservations(
  conditions: MonitorCondition[],
  errors: string[],
  clock: number,
): void {
  const observed = orphanProcessConditions(
    currentOrphanProcesses(projects().filter(isProjectRepository)),
    clock,
  )
  conditions.push(...observed.conditions)
  errors.push(...observed.errors)
}

export class MonitorStoreBusyError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'MonitorStoreBusyError'
  }
}

function startMonitorInvocation(trigger: 'invoked' | 'backstop', startedAt: string) {
  try {
    const database = writableDb()
    const row = database
      .query(
        'INSERT INTO monitor_invocation (record_id,started_at,trigger) VALUES (?,?,?) RETURNING id',
      )
      .get(newRecordId(), startedAt, trigger) as { id: number }
    return { database, invocation: row.id }
  } catch (error) {
    if (isDatabaseLocked(error)) throw new MonitorStoreBusyError(error)
    throw error
  }
}

function sampleMonitorHostLoad(database: ReturnType<typeof writableDb>, invocation: number) {
  const sample = sampleHostLoad(database)
  sampleHostPressure(database, sample)
  database
    .query('UPDATE monitor_invocation SET host_load=? WHERE id=?')
    .run(JSON.stringify(sample), invocation)
  return sample
}

const observeRunDocker = () =>
  dockerRunResources(
    projects()
      .filter(isProjectRepository)
      .map(({ path }) => path),
  )

function trustEntryInventory(database: ReturnType<typeof db>) {
  try {
    const rows = database
      .query(
        'SELECT record_id, worktree, mcp_trust_path FROM run WHERE worktree IS NOT NULL AND mcp_trust_path IS NOT NULL',
      )
      .all() as { record_id: string; worktree: string; mcp_trust_path: string }[]
    const present = new Set(grokTrustHeadings())
    const registeredProjectPaths = projects()
      .filter(isProjectRepository)
      .map((project) => project.path)
    const entries = rows.flatMap((row) => {
      const headings = JSON.parse(row.mcp_trust_path) as unknown
      if (!Array.isArray(headings) || headings.some((heading) => typeof heading !== 'string')) {
        throw new Error(`run ${row.record_id} mcp_trust_path is not a JSON string array`)
      }
      return (headings as string[])
        .filter((heading) => present.has(heading))
        .map((heading) => {
          const path = grokTrustPathFromHeading(heading)
          return {
            runId: row.record_id,
            heading,
            path,
            pathExists: path !== null && existsSync(path),
            registeredProjectPath:
              path !== null &&
              registeredProjectPaths.some((projectPath) => {
                try {
                  return realpathSync(projectPath) === realpathSync(path)
                } catch {
                  return resolve(projectPath) === resolve(path)
                }
              }),
            worktreeExists: existsSync(row.worktree),
          }
        })
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
  const ownership = new Map<string, { statuses: string[]; worktrees: string[] }>()
  const rows = database
    .query('SELECT record_id, parent_run_record_id, status, worktree FROM run')
    .all() as {
    record_id: string
    parent_run_record_id: string | null
    status: string
    worktree: string | null
  }[]
  for (const row of rows) {
    const rootId = row.parent_run_record_id ?? row.record_id
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

const conditionSemantics = (condition: MonitorCondition) =>
  JSON.stringify([
    condition.kind,
    condition.subject,
    condition.since,
    condition.detail,
    condition.action,
    condition.ownerSession ?? null,
    condition.severity ?? null,
    condition.issueKey ?? null,
  ])

/** Collapse repeated findings and turn conflicting detector output into visible anomalies. */
export function groupMonitorConditions(conditions: MonitorCondition[]): {
  conditions: MonitorCondition[]
  anomalies: MonitorCondition[]
} {
  const groups = new Map<string, { first: MonitorCondition; semantic: string; dropped: number }>()
  const grouped: MonitorCondition[] = []
  for (const condition of conditions) {
    const address = JSON.stringify([condition.kind, condition.subject])
    const existing = groups.get(address)
    if (!existing) {
      groups.set(address, {
        first: condition,
        semantic: conditionSemantics(condition),
        dropped: 0,
      })
      grouped.push(condition)
      continue
    }
    existing.dropped += 1
  }
  const anomalies = [...groups.values()].flatMap(({ first, semantic, dropped }) => {
    if (dropped === 0) return []
    const address = JSON.stringify([first.kind, first.subject])
    const variants = conditions.filter(
      (condition) =>
        JSON.stringify([condition.kind, condition.subject]) === address &&
        conditionSemantics(condition) !== semantic,
    )
    if (variants.length === 0) return []
    return [
      {
        kind: 'observation-error',
        subject: `duplicate-condition:${address}`,
        since: null,
        ageMs: null,
        detail: `${first.kind} condition for ${first.subject} differed across duplicate observations; dropped ${dropped}`,
        action: 'reported; repair the detector that emitted conflicting conditions',
      },
    ]
  })
  return { conditions: grouped, anomalies }
}

function conditionsForPersistence(conditions: MonitorCondition[]): MonitorCondition[] {
  const grouped = groupMonitorConditions(conditions)
  return [...grouped.conditions, ...grouped.anomalies]
}

function completeMonitorInvocation(
  database: ReturnType<typeof writableDb>,
  invocation: number,
  findings: number,
  errors: number,
): string {
  const finishedAt = nowIso()
  database
    .query('UPDATE monitor_invocation SET finished_at=?, findings=?, errors=? WHERE id=?')
    .run(finishedAt, findings, errors, invocation)
  return finishedAt
}

function persistMonitorConditions(
  database: ReturnType<typeof writableDb>,
  invocation: number,
  conditions: MonitorCondition[],
  observationErrorCount: number,
): MonitorCondition[] {
  const persistedConditions = conditionsForPersistence(conditions)
  try {
    writeTransaction(() => {
      const insert = database.query(
        `INSERT INTO monitor_condition
        (record_id,invocation_id,kind,subject,condition_since,age_ms,detail,action,issue_key,severity,
         owner_session_id,delivered_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      const priorDelivery = database.query(
        `SELECT delivered_at FROM monitor_condition
        WHERE kind=? AND subject=? AND condition_since IS ? AND owner_session_id IS ?
          AND delivered_at IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      )
      for (const condition of persistedConditions) {
        const owner = condition.ownerSession ?? null
        const prior = owner
          ? (priorDelivery.get(condition.kind, condition.subject, condition.since, owner) as {
              delivered_at: string
            } | null)
          : null
        condition.detail = persistedHostPressureDetail(
          database,
          condition,
          prior?.delivered_at ?? null,
        )
        insert.run(
          newRecordId(),
          invocation,
          condition.kind,
          condition.subject,
          condition.since,
          condition.ageMs,
          condition.detail,
          condition.action,
          condition.issueKey ?? null,
          condition.severity ?? null,
          owner,
          prior?.delivered_at ?? null,
        )
      }
    }, database)
  } catch (cause) {
    completeMonitorInvocation(database, invocation, 0, observationErrorCount + 1)
    throw cause
  }
  return persistedConditions
}

/** Observe machine state, record the pass, and make no judgment-shaped repair. */
function terminalCloseOutDetail(run: {
  record_id: string
  close_out_detail: string | null
  close_out_outcome: string
}): string {
  return run.close_out_detail ?? `terminal run ${run.record_id} close-out ${run.close_out_outcome}`
}

export async function monitor(
  trigger: 'invoked' | 'backstop' = 'invoked',
  clock = Date.now(),
): Promise<MonitorResult> {
  const startedAt = new Date(clock).toISOString()
  const { database, invocation } = startMonitorInvocation(trigger, startedAt)
  const load = sampleMonitorHostLoad(database, invocation)
  const { conditions, errors, hostPressure } = await initialMonitorObservations(database, clock)
  const canon = monitorCanonSummary()
  type ConditionInput =
    | (Omit<AddressedMonitorCondition, 'ageMs'> & { ageMs?: number | null })
    | (Omit<UnaddressedMonitorCondition, 'ageMs'> & { ageMs?: number | null })
  const add = (condition: ConditionInput) =>
    conditions.push({
      ...condition,
      ageMs: condition.ageMs ?? age(condition.since, clock),
    } as MonitorCondition)
  const reclaimProject = projectAt(process.cwd())
  const ratchetedRuleRefills = observeRatchetedRuleRefills(
    projects().filter(isProjectRepository),
    database,
  )
  conditions.push(...ratchetedRuleRefills.conditions)
  errors.push(...ratchetedRuleRefills.errors)
  const strayWorktrees = strayWorktreeConditions({
    projects: projects().filter(isProjectRepository),
    database,
    clock,
  })
  conditions.push(...strayWorktrees.conditions)
  errors.push(...strayWorktrees.errors)

  const asking = askingRuns(database)
  for (const run of asking)
    add({
      kind: 'asking-run',
      subject: `run:${run.record_id}`,
      since: run.started_at,
      detail: `run ${run.record_id} is marked asking but has no unanswered question (stranded)`,
      action: `run ${PLATFORM_SLUG} run abandon ${run.record_id} to close it, or ${PLATFORM_SLUG} run continue ${run.record_id} to resume it; an intent decision`,
      ownerSession: run.session_id,
    })

  conditions.push(...outboxConditions(database, clock))
  conditions.push(...boardEscalations(clock))

  conditions.push(...abandonedBootstrapConditions(clock))
  conditions.push(...deadRunningProcessConditions(clock))
  conditions.push(...idleRunConditions(clock))
  conditions.push(...stalledRunConditions(clock))
  conditions.push(...workerGateToolingConditions(database))
  const recordTunnel = await observeRecordTunnel()
  conditions.push(...recordTunnel.conditions)
  errors.push(...recordTunnel.errors)

  const closeOuts = terminalCloseOutRuns(database)
  for (const run of closeOuts)
    add({
      kind: TERMINAL_CLOSE_OUT_NOTICE_KINDS[run.close_out_outcome],
      subject: `run:${run.record_id}`,
      since: run.close_out_attempted_at,
      detail: terminalCloseOutDetail(run),
      action: `run ${PLATFORM_SLUG} run close-out ${run.record_id}`,
      ownerSession: run.session_id,
    })

  const runDocker = observeRunDocker()
  if (!runDocker.ascertainable) errors.push(runDocker.reason)
  const runDockerResources = runDocker.ascertainable ? runDocker.resources : []
  conditions.push(...observedOrphanComposeConditions(runDocker))
  unattributableDockerConditions(runDocker).forEach(add)
  const dockerOwnerIds = new Set(runDockerResources.map(({ runId }) => runId))
  const dockerOwners = (
    database
      .query(
        `SELECT r.record_id,COALESCE(root.repo,r.repo) repo,r.worktree,r.status,
                COALESCE(root.worktree_source,r.worktree_source) worktree_source,
                COALESCE(root.recipe_snapshot,r.recipe_snapshot) recipe_snapshot,
                COALESCE(root.resource_teardown,r.resource_teardown) resource_teardown
         FROM run r LEFT JOIN run root ON root.record_id=r.parent_run_record_id`,
      )
      .all() as {
      record_id: string
      repo: string | null
      worktree: string | null
      status: string
      worktree_source: 'recipe' | 'git' | 'clone' | 'readonly_recipe' | null
      recipe_snapshot: string | null
      resource_teardown: 'pending' | 'done' | null
    }[]
  ).map((owner) => ({
    ...owner,
    absentTreeTeardown:
      Boolean(owner.worktree && !existsSync(owner.worktree)) &&
      absentTreeTeardownPlan({
        recipeSnapshot: owner.recipe_snapshot,
        worktreeSource: owner.worktree_source,
        resourceTeardown: owner.resource_teardown,
        registeredRemoveCommand: Boolean(
          resolvedWorktreeTool(owner.repo ? projectByName(owner.repo) : null)?.remove,
        ),
      }),
    retentionReason: dockerOwnerIds.has(owner.record_id)
      ? terminalDockerRetentionReasonForRun(database, owner.record_id)
      : null,
  }))
  for (const item of classifiedDockerResources(runDockerResources, dockerOwners)) {
    if (item.condition !== 'retained-worktree-resources') continue
    const owner = dockerOwners.find(({ record_id }) => record_id === item.resource.runId)
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
      action: retainedDockerResourceAction(owner ?? null),
      affectedProject: item.project,
    })
  }

  conditions.push(...staleRunConditions(database, clock))

  conditions.push(...terminalProcessAliveConditions(clock))
  appendOrphanProcessObservations(conditions, errors, clock)

  const unscored = unscoredRuns(database)
  for (const run of unscored)
    add({
      kind: 'unscored-run',
      subject: `run:${run.record_id}`,
      since: run.started_at,
      detail: `completed run ${run.record_id} has no score`,
      action: 'reported; only its owning reader may score it',
      ownerSession: run.session_id,
    })

  for (const project of projects().filter(isProjectRepository)) {
    conditions.push(...observeProjectCanonDrift(project))
    conditions.push(...observeProjectHarnessLoad(project, process.env))
    const releaseLive = observeProjectReleaseLive(project)
    conditions.push(...releaseLive.conditions)
    errors.push(...releaseLive.errors)
    const recipeDatabases = recipeDatabaseObservations(project, database)
    conditions.push(...recipeDatabases.conditions)
    errors.push(...recipeDatabases.errors)
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
      conditions.push(...gitLockConditions(project, clock))
    } catch (cause) {
      errors.push(
        `${project.name} git lock inventory: ${String((cause as Error).message ?? cause)}`,
      )
    }

    conditions.push(...worktreesWithoutLiveRuns({ project, reclaimProject, database, clock }))

    const heldTrees = database
      .query(
        `SELECT MIN(number) number, worktree, MAX(keep_tree) keep_tree,
                MAX(keep_tree_until) keep_tree_until, MAX(keep_tree_reason) keep_tree_reason,
                MIN(started_at) started_at
         FROM run WHERE project_record_id=? AND worktree IS NOT NULL
          AND status IN ('ok','failed','stale','stopped')
        GROUP BY worktree`,
      )
      .all(project.recordId) as {
      number: number
      worktree: string
      keep_tree: number
      keep_tree_until: string | null
      keep_tree_reason: string | null
      started_at: string
    }[]
    for (const held of heldTrees) {
      if (!existsSync(held.worktree)) continue
      const hold = keepTreeHold({
        keepTree: held.keep_tree,
        keepTreeUntil: held.keep_tree_until,
        startedAt: held.started_at,
        now: new Date(clock).toISOString(),
      })
      const dirty = hold.held ? null : worktreeDirty(held.worktree)
      if (!hold.held && !dirty?.dirty) continue
      const ageMs = age(held.started_at, clock)
      const explicit = hold.held
      add({
        kind: explicit ? 'explicitly-held-worktree' : 'held-worktree',
        subject: held.worktree,
        since: held.started_at,
        detail: explicit
          ? `run ${held.number} retained by ${held.keep_tree_reason ?? 'explicit --keep-tree'} until ${hold.until}`
          : `run ${held.number} ${dirty!.detail}`,
        action: explicit
          ? `clear with ${PLATFORM_SLUG} run discard ${held.number}`
          : `commit or remove the work, then run ${PLATFORM_SLUG} run close-out ${held.number}`,
        severity: ageMs !== null && ageMs >= 48 * 60 * 60 * 1000 ? 'attention' : 'informational',
      })
    }

    const worktreeRefs = (git(project.path, ['worktree', 'list', '--porcelain']) ?? '')
      .split('\n')
      .filter((line) => line.startsWith('branch refs/heads/'))
      .map((line) => line.slice(18))
    const localHeads = git(project.path, [
      'for-each-ref',
      '--format=%(refname:lstrip=2)',
      'refs/heads',
    ])
    const branches = database
      .query(
        `SELECT minted_branch branch, MIN(started_at) started_at FROM run
          WHERE project_record_id=? AND minted_branch IS NOT NULL GROUP BY minted_branch`,
      )
      .all(project.recordId) as { branch: string; started_at: string }[]
    const branchInventory = branchInventoryDecision(
      project.name,
      branches,
      worktreeRefs,
      localHeads,
    )
    errors.push(...branchInventory.errors)
    const reclaimActions = monitorBranchReclaimActions(
      reclaimProject?.name ?? null,
      project.name,
      branchInventory.branches.map((branch) => branch.branch),
    )
    for (const condition of branchMonitorConditions(
      project.name,
      branchInventory.branches,
      reclaimActions,
    ))
      add(condition)
  }

  const hub = reconcileHub(clock)
  conditions.push(...hub.conditions)
  errors.push(...hub.errors)
  const retrievalPins = observeRetrievalPins()
  conditions.push(...retrievalPins.conditions)
  errors.push(...retrievalPins.errors)
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
  conditions.push(...hookTreeConditions(database, clock))

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
  const persistedConditions = persistMonitorConditions(
    database,
    invocation,
    conditions,
    errors.length,
  )
  conditions.splice(0, conditions.length, ...persistedConditions)

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
          reproduce_command: `${PLATFORM_SLUG} machine monitor`,
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

  const finished = completeMonitorInvocation(database, invocation, conditions.length, errors.length)
  return finish(
    invocation,
    startedAt,
    finished,
    trigger,
    conditions,
    errors,
    canon,
    load,
    hostPressure,
  )
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
      .all(limit) as (Omit<MonitorHistoryRow, 'conditions' | 'host_load'> & {
      conditions: string | null
      host_load: string | null
    })[]
  ).map((row) => ({
    ...row,
    conditions: JSON.parse(row.conditions ?? '[]') as unknown[],
    host_load: row.host_load ? JSON.parse(row.host_load) : null,
  }))
}

/**
 * Map one stored history row's snake_case condition onto the printable shape.
 * Lives beside monitorHistory so the persisted column names are normalized in
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
