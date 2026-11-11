// concern: local-project-purge
/** Derives and executes complete local project removal from the live SQLite schema. */
import type { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RemovalReport } from '../../../shared/removal-report.ts'
import { resolveRunsDirectory } from '../../../shared/state-directory.ts'
import { writeTransaction } from '../database/db.ts'
import { TERMINAL_RUN_STATUS_SQL } from '../run/run-status.ts'

type ForeignKey = {
  table: string
  id: number
  seq: number
  parent: string
  from: string
  to: string
  onDelete: string
}
type PurgeStep = { table: string; predicate: string; key: 'record-id' | 'name' }

const ORCHESTRATOR_PROJECT_PURGE_EXCLUSIONS = {
  project: 'the register row is deleted by the final composite part',
} as const

const LOCAL_CATALOGUE_TABLES = new Set([
  'port_pair',
  'port_ref',
  'port_ref_source',
  'project_lens_profile',
])

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

function tables(database: Database): string[] {
  return database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name)
}

function foreignKeys(database: Database, names: readonly string[]): ForeignKey[] {
  return names.flatMap((table) =>
    database
      .query(`PRAGMA foreign_key_list(${quote(table)})`)
      .all()
      .map((row) => {
        const fk = row as Record<string, unknown>
        return {
          table,
          id: Number(fk.id),
          seq: Number(fk.seq),
          parent: String(fk.table),
          from: String(fk.from),
          to: String(fk.to),
          onDelete: String(fk.on_delete),
        }
      }),
  )
}

function projectPredicate(
  table: string,
  keys: readonly ForeignKey[],
  memo: Map<string, string | null>,
  active = new Set<string>(),
): string | null {
  if (memo.has(table)) return memo.get(table) ?? null
  if (active.has(table)) return null
  const nextActive = new Set(active).add(table)
  const groups = Map.groupBy(
    keys.filter((key) => key.table === table),
    (key) => `${key.table}:${key.id}`,
  )
  const clauses: string[] = []
  for (const group of groups.values()) {
    const parent = group[0]!.parent
    if (parent === 'project' && group.some((key) => key.to === 'record_id')) {
      clauses.push(group.map((key) => `${quote(key.from)}=?`).join(' AND '))
      continue
    }
    const parentPredicate = projectPredicate(parent, keys, memo, nextActive)
    if (!parentPredicate) continue
    const alias = `purge_${parent}_${clauses.length}`
    const join = group
      .sort((a, b) => a.seq - b.seq)
      .map((key) => `${quote(table)}.${quote(key.from)}=${quote(alias)}.${quote(key.to)}`)
      .join(' AND ')
    clauses.push(
      `EXISTS (SELECT 1 FROM ${quote(parent)} AS ${quote(alias)} WHERE ${join} AND ${parentPredicate.replaceAll(`${quote(parent)}.`, `${quote(alias)}.`)})`,
    )
  }
  const predicate = clauses.length ? `(${clauses.join(' OR ')})` : null
  memo.set(table, predicate)
  return predicate
}

export function orchestratorProjectPurgePlan(database: Database): PurgeStep[] {
  const names = tables(database)
  const keys = foreignKeys(database, names)
  const memo = new Map<string, string | null>()
  const steps = names.flatMap((table) => {
    if (table === 'project' || table === 'outbox' || LOCAL_CATALOGUE_TABLES.has(table)) return []
    const predicate = projectPredicate(table, keys, memo)
    return predicate ? [{ table, predicate, key: 'record-id' as const }] : []
  })
  const planned = new Set(steps.map(({ table }) => table))
  const blockingParents = new Map<string, Set<string>>()
  for (const table of planned) blockingParents.set(table, new Set())
  for (const key of keys) {
    if (
      key.table !== key.parent &&
      planned.has(key.table) &&
      planned.has(key.parent) &&
      (key.onDelete === 'RESTRICT' || key.onDelete === 'NO ACTION')
    ) {
      blockingParents.get(key.table)!.add(key.parent)
    }
  }
  const preferenceDepth = (table: string, seen = new Set<string>()): number => {
    if (seen.has(table)) return 0
    const parents = keys
      .filter((key) => key.table === table && key.parent !== table && planned.has(key.parent))
      .map((key) => key.parent)
    return parents.length
      ? 1 +
          Math.max(...parents.map((parent) => preferenceDepth(parent, new Set(seen).add(table))))
      : 0
  }
  const blockingChildren = new Map([...planned].map((table) => [table, 0]))
  for (const parents of blockingParents.values())
    for (const parent of parents)
      blockingChildren.set(parent, (blockingChildren.get(parent) ?? 0) + 1)
  const ordered: PurgeStep[] = []
  const remaining = new Map(steps.map((step) => [step.table, step]))
  while (remaining.size) {
    const ready = [...remaining.keys()]
      .filter((table) => blockingChildren.get(table) === 0)
      .sort((a, b) => preferenceDepth(b) - preferenceDepth(a) || a.localeCompare(b))
    if (!ready.length)
      throw new Error(
        `project purge blocking foreign-key cycle: ${[...remaining.keys()].sort().join(', ')}`,
      )
    for (const table of ready) {
      ordered.push(remaining.get(table)!)
      remaining.delete(table)
      for (const parent of blockingParents.get(table) ?? [])
        blockingChildren.set(parent, blockingChildren.get(parent)! - 1)
    }
  }
  steps.splice(0, steps.length, ...ordered)
  for (const table of LOCAL_CATALOGUE_TABLES) {
    if (!names.includes(table)) continue
    const columns = database
      .query(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((row) => String((row as Record<string, unknown>).name))
      .filter((column) => column === 'project_record_id' || column.endsWith('_project_record_id'))
    if (columns.length)
      steps.unshift({
        table,
        predicate: `space_id IS NULL AND (${columns.map((column) => `${quote(column)}=?`).join(' OR ')})`,
        key: 'record-id',
      })
  }
  if (names.includes('board_reach_delivery'))
    steps.unshift({ table: 'board_reach_delivery', predicate: 'reader_project=?', key: 'name' })
  steps.push({
    table: 'outbox',
    predicate: "synced_at IS NULL AND (payload LIKE '%' || ? || '%' OR row_id=? OR record_id=?)",
    key: 'record-id',
  })
  return steps
}

export function uncoveredOrchestratorProjectTables(database: Database): string[] {
  const covered = new Set(orchestratorProjectPurgePlan(database).map((step) => step.table))
  const excluded = new Set(Object.keys(ORCHESTRATOR_PROJECT_PURGE_EXCLUSIONS))
  return tables(database).filter((table) => {
    const columns = database
      .query(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((row) => String((row as Record<string, unknown>).name))
    return (
      columns.some(
        (column) =>
          column === 'project' ||
          column.endsWith('_project') ||
          column === 'project_record_id' ||
          column.endsWith('_project_record_id'),
      ) &&
      !covered.has(table) &&
      !excluded.has(table)
    )
  })
}

export function localProjectPurgeRefusals(database: Database, projectRecordId: string): string[] {
  const refusals: string[] = []
  const runs = database
    .query<{ number: number }, [string]>(
      `SELECT number FROM run WHERE project_record_id=? AND status NOT IN ${TERMINAL_RUN_STATUS_SQL} ORDER BY number`,
    )
    .all(projectRecordId)
  for (const run of runs)
    refusals.push(
      `run ${run.number} is not terminal; clear it with \`${PLATFORM_SLUG} run stop ${run.number}\``,
    )
  const claims = database
    .query<{ kind: string; allocation_key: string }, [string]>(
      "SELECT kind,allocation_key FROM resource_claim WHERE project_record_id=? AND state IN ('pending','claimed','retained','stuck') ORDER BY kind,allocation_key",
    )
    .all(projectRecordId)
  for (const claim of claims)
    refusals.push(
      `${claim.kind} resource ${claim.allocation_key} is held; clear it with \`${PLATFORM_SLUG} session close-out\``,
    )
  const landings = database
    .query<{ record_id: string; branch: string }, [string]>(
      "SELECT record_id,branch FROM landing WHERE project_record_id=? AND status IN ('queued','running') ORDER BY started_at",
    )
    .all(projectRecordId)
  for (const landing of landings)
    refusals.push(
      `landing ${landing.record_id} for ${landing.branch} is in progress; clear it with \`${PLATFORM_SLUG} pr merge ${landing.branch}\``,
    )
  return refusals
}

export function purgeLocalOrchestratorProject(
  database: Database,
  projectRecordId: string,
  projectName: string,
  runsDirectory = resolveRunsDirectory(process.env),
): RemovalReport {
  const uncovered = uncoveredOrchestratorProjectTables(database)
  if (uncovered.length)
    throw new Error(`project purge plan does not cover local table(s): ${uncovered.join(', ')}`)
  const runIds = database
    .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE project_record_id=?')
    .all(projectRecordId)
    .map((row) => row.record_id)
  const report = writeTransaction(() => {
    const plan = orchestratorProjectPurgePlan(database)
    const rows: RemovalReport = plan.map((step) => {
      const predicate = step.predicate.replaceAll('?', '?1')
      const count = database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM ${quote(step.table)} WHERE ${predicate}`,
        )
        .get(step.key === 'name' ? projectName : projectRecordId)!.count
      return { table: step.table, count }
    })
    for (const step of plan) {
      const predicate = step.predicate.replaceAll('?', '?1')
      database
        .query(`DELETE FROM ${quote(step.table)} WHERE ${predicate}`)
        .run(step.key === 'name' ? projectName : projectRecordId)
    }
    return rows
  }, database)
  let artifacts = 0
  for (const runId of runIds) {
    const path = join(runsDirectory, runId)
    try {
      rmSync(path, { recursive: true, force: false })
      artifacts++
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  report.push({ table: 'run_artifact_directory', count: artifacts })
  return report
}
