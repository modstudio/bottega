// concern: record-cache
/** Advances the local record mirror from the ordered hosted change feed. */
import type { Database } from 'bun:sqlite'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { nowIso, writeTransaction } from '../database/db.ts'
import { projectRowByName } from '../project/projects.ts'
import { rememberActiveRecordSpace } from '../project-space.ts'
import { applySubjectRecord } from '../subject/subjects.ts'
import { type RecordApiClient, recordApiClient } from './record-api-client.ts'
import type { RecordChangePage } from './record-api-client-changes.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  applyLensCatalogueRow,
  lensCatalogueParentPresent,
  pullLensCatalogue,
} from './record-cache-lens.ts'
import {
  applyPortCatalogueRow,
  portCatalogueParentPresent,
  pullPortCatalogue,
} from './record-cache-port.ts'
import { type ProjectRegisterPullResult, pullProjectRegister } from './record-cache-projects.ts'
import {
  applyWorkflowCatalogueRow,
  pullWorkflowCatalogue,
  workflowCatalogueParentPresent,
} from './record-cache-workflow.ts'
import { RECORD_LENS_TABLES, type RecordLensTable } from './record-lens-contract.ts'
import {
  RECORD_PORT_TABLES,
  type RecordPortRow,
  type RecordPortTable,
} from './record-port-contract.ts'
import { noActiveRecordSpaceRefusal } from './record-project-destination.ts'
import type { RecordRoutingEvidence } from './record-routing-evidence-contract.ts'
import { type RoutingPoolPullResult, upsertPoolRun } from './record-routing-pool.ts'
import { rememberSignedInRecordUser } from './record-session.ts'
import { RECORD_WORKFLOW_TABLES, type RecordWorkflowTable } from './record-workflow-contract.ts'

const CURSOR = 'record_change_cursor'
const SPACES = 'record_change_spaces'
const readMeta = (local: Database, key: string) =>
  local.query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?').get(key)
    ?.value ?? null
const writeMeta = (local: Database, key: string, value: string) =>
  local
    .query(
      'INSERT INTO schema_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, value)

const emptyProject = (): ProjectRegisterPullResult => ({
  updated: 0,
  retired: 0,
  unretired: 0,
  skipped: 0,
  warnings: [],
})
const emptyRouting = (): RoutingPoolPullResult => ({ added: 0, updated: 0, caughtUp: true })
export const emptyRecordCachePullResult = () => ({
  docs: 0,
  skippedDocs: 0,
  subjects: 0,
  skippedSubjects: 0,
  scores: 0,
  lensCatalogue: 0,
  workflowCatalogue: 0,
  portCatalogue: 0,
  projectRegister: emptyProject(),
  routingPool: emptyRouting(),
  changes: 0,
  orphans: 0,
  reset: false,
})
export type RecordCachePullResult = ReturnType<typeof emptyRecordCachePullResult>

type KeysetResult = Omit<RecordCachePullResult, 'changes' | 'orphans' | 'reset'>
type Dependencies = {
  cacheSpaces(
    identity: RecordIdentity,
    local: Database,
  ): { projectSpaces: ReadonlyMap<string, string | null> }
  pullKeysets(
    local: Database,
    identity: RecordIdentity,
    spaces?: readonly string[],
  ): Promise<KeysetResult>
  pullDocs(
    local: Database,
    identity: RecordIdentity,
    spaces: readonly string[],
    projectSpaces: ReadonlyMap<string, string | null>,
  ): Promise<{ docs: number; skippedDocs: number }>
  pullSubjects(
    local: Database,
    spaces: readonly string[],
    projectSpaces: ReadonlyMap<string, string | null>,
  ): Promise<{ subjects: number; skippedSubjects: number }>
  applyDoc(
    local: Database,
    row: Record<string, unknown>,
    unresolved: Map<string, string>,
    space?: string,
  ): void
  applyScore(local: Database, row: Record<string, unknown>): void
}
type Change = RecordChangePage['changes'][number]
type UpsertChange = Extract<Change, { op: 'upsert' }>
type FallbackFamily = 'doc' | 'subject' | 'lens' | 'workflow' | 'port'

const membershipSpaces = (identity: RecordIdentity) =>
  parseRecordSpaceMemberships(identity.memberships)
    .map((membership) => membership.spaceId)
    .sort()
const rememberedSpaces = (local: Database): string[] => {
  const value = readMeta(local, SPACES)
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function purgeLostSpaces(local: Database, spaces: readonly string[]): void {
  if (!spaces.length) return
  writeTransaction(() => {
    for (const space of spaces) {
      local.query('DELETE FROM doc WHERE space_id=?').run(space)
      local.query('DELETE FROM subject WHERE space_id=?').run(space)
      local.query('DELETE FROM lens_revision WHERE space_id=?').run(space)
      local.query('DELETE FROM lens_profile_revision WHERE space_id=?').run(space)
      local.query('DELETE FROM project_lens_profile_revision WHERE space_id=?').run(space)
      local.query('DELETE FROM project_lens_profile WHERE space_id=?').run(space)
      local.query('DELETE FROM lens_profile WHERE space_id=?').run(space)
      local.query('DELETE FROM lens WHERE space_id=?').run(space)
      local.query('DELETE FROM workflow_event WHERE space_id=?').run(space)
      local.query('DELETE FROM workflow_version WHERE space_id=?').run(space)
      local.query('DELETE FROM workflow WHERE space_id=?').run(space)
      local.query('DELETE FROM step_catalogue_event WHERE space_id=?').run(space)
      local.query('DELETE FROM step_catalogue_version WHERE space_id=?').run(space)
      local.query('DELETE FROM step_catalogue WHERE space_id=?').run(space)
      local.query('DELETE FROM port_ref_source WHERE space_id=?').run(space)
      local.query('DELETE FROM port_ref WHERE space_id=?').run(space)
      local.query('DELETE FROM port_skip WHERE space_id=?').run(space)
      local.query('DELETE FROM port_baseline WHERE space_id=?').run(space)
      local.query('DELETE FROM port_pair WHERE space_id=?').run(space)
      local.query('DELETE FROM port_doctrine WHERE space_id=?').run(space)
      local.query('DELETE FROM routing_pool_run WHERE space_id=?').run(space)
    }
  }, local)
}

function subjectOrphan(local: Database, row: Record<string, unknown>): boolean {
  const project = projectRowByName(String(row.project), local)
  if (!project) return true
  return (
    row.parentId != null &&
    !local.query('SELECT 1 FROM subject WHERE id=?').get(String(row.parentId))
  )
}

function docOrphan(local: Database, row: Record<string, unknown>): boolean {
  if (
    row.parentId != null &&
    !local.query('SELECT 1 FROM doc WHERE record_id=?').get(String(row.parentId))
  )
    return true
  const article = row.articleSubject as Record<string, unknown> | null | undefined
  const related = Array.isArray(row.relatedSubjects) ? row.relatedSubjects : []
  return [article, ...related]
    .filter((value): value is Record<string, unknown> => Boolean(value))
    .some((value) => !local.query('SELECT 1 FROM subject WHERE id=?').get(String(value.id)))
}

const lensTable = (table: string): table is RecordLensTable =>
  (RECORD_LENS_TABLES as readonly string[]).includes(table)
const workflowTable = (table: string): table is RecordWorkflowTable =>
  (RECORD_WORKFLOW_TABLES as readonly string[]).includes(table)
const portTable = (table: string): table is RecordPortTable =>
  (RECORD_PORT_TABLES as readonly string[]).includes(table)

function orphanFamily(local: Database, change: Change): FallbackFamily | null {
  if (change.op === 'delete' || !change.row || typeof change.row !== 'object') return null
  const row = change.row as Record<string, unknown>
  const direct = directOrphanFamily(local, change.table, row)
  if (direct) return direct
  if (lensTable(change.table) && !lensCatalogueParentPresent(local, change.table, row))
    return 'lens'
  if (workflowTable(change.table) && !workflowCatalogueParentPresent(local, change.table, row))
    return 'workflow'
  if (
    portTable(change.table) &&
    !portCatalogueParentPresent(local, change.table, row as RecordPortRow)
  )
    return 'port'
  return null
}

function directOrphanFamily(
  local: Database,
  table: string,
  row: Record<string, unknown>,
): FallbackFamily | null {
  if (table === 'subject' && subjectOrphan(local, row)) return 'subject'
  if (table === 'doc' && docOrphan(local, row)) return 'doc'
  return null
}

function deleteCatalogueRow(local: Database, table: string, id: string): void {
  const statements: Record<string, ReturnType<Database['query']>> = {
    lens: local.query('DELETE FROM lens WHERE record_id=?'),
    lens_revision: local.query('DELETE FROM lens_revision WHERE record_id=?'),
    lens_profile: local.query('DELETE FROM lens_profile WHERE record_id=?'),
    lens_profile_revision: local.query('DELETE FROM lens_profile_revision WHERE record_id=?'),
    project_lens_profile: local.query('DELETE FROM project_lens_profile WHERE record_id=?'),
    project_lens_profile_revision: local.query(
      'DELETE FROM project_lens_profile_revision WHERE record_id=?',
    ),
    workflow: local.query('DELETE FROM workflow WHERE record_id=?'),
    workflow_version: local.query('DELETE FROM workflow_version WHERE record_id=?'),
    workflow_event: local.query('DELETE FROM workflow_event WHERE record_id=?'),
    step_catalogue: local.query('DELETE FROM step_catalogue WHERE record_id=?'),
    step_catalogue_version: local.query('DELETE FROM step_catalogue_version WHERE record_id=?'),
    step_catalogue_event: local.query('DELETE FROM step_catalogue_event WHERE record_id=?'),
    port_doctrine: local.query('DELETE FROM port_doctrine WHERE record_id=?'),
    port_pair: local.query('DELETE FROM port_pair WHERE record_id=?'),
    port_baseline: local.query('DELETE FROM port_baseline WHERE record_id=?'),
    port_skip: local.query('DELETE FROM port_skip WHERE record_id=?'),
  }
  statements[table]?.run(id)
}

function deleteChange(local: Database, change: Change, deps: Dependencies): void {
  if (change.table === 'doc') {
    deps.applyDoc(local, { id: change.id, deletedAt: nowIso() }, new Map())
    return
  }
  if (change.table === 'subject') {
    local.query('DELETE FROM subject WHERE id=?').run(change.id)
    return
  }
  if (change.table === 'routing_evidence') {
    local.query('DELETE FROM routing_pool_run WHERE record_id=?').run(change.id)
    return
  }
  if (change.table === 'run_score' || change.table === 'project') return
  if (
    portTable(change.table) &&
    (change.table === 'port_ref' || change.table === 'port_ref_source')
  ) {
    applyPortCatalogueRow(local, change.table, {
      id: change.id,
      spaceId: change.space,
      deletedAt: nowIso(),
    } as never)
    return
  }
  if (lensTable(change.table) || workflowTable(change.table) || portTable(change.table))
    deleteCatalogueRow(local, change.table, change.id)
}

function upsertChange(
  local: Database,
  change: UpsertChange,
  deps: Dependencies,
  result: RecordCachePullResult,
) {
  const row = change.row as Record<string, unknown>
  if (change.table === 'subject') {
    applySubjectRecord(row as never, local, change.space)
    result.subjects++
  } else if (change.table === 'doc') {
    deps.applyDoc(local, row, new Map(), change.space)
    result.docs++
  } else if (lensTable(change.table)) {
    applyLensCatalogueRow(local, change.table, row)
    result.lensCatalogue++
  } else if (workflowTable(change.table)) {
    applyWorkflowCatalogueRow(local, change.table, row)
    result.workflowCatalogue++
  } else if (portTable(change.table)) {
    applyPortCatalogueRow(local, change.table, row as RecordPortRow)
    result.portCatalogue++
  } else if (change.table === 'routing_evidence') {
    const present = Boolean(
      local.query('SELECT 1 FROM routing_pool_run WHERE record_id=?').get(change.id),
    )
    upsertPoolRun(local, row as unknown as RecordRoutingEvidence, nowIso())
    if (present) result.routingPool.updated++
    else result.routingPool.added++
  } else if (change.table === 'run_score') {
    deps.applyScore(local, row)
    result.scores++
  }
}

const order = (change: Change): number => {
  if (change.table === 'subject') return 0
  if (change.table === 'doc') return 1
  const lens = (RECORD_LENS_TABLES as readonly string[]).indexOf(change.table)
  if (lens >= 0) return 10 + lens
  const workflow = (RECORD_WORKFLOW_TABLES as readonly string[]).indexOf(change.table)
  if (workflow >= 0) return 20 + workflow
  const port = (RECORD_PORT_TABLES as readonly string[]).indexOf(change.table)
  if (port >= 0) return 30 + port
  if (change.table === 'project') return 40
  if (change.table === 'routing_evidence') return 41
  return 42
}

function applyPage(local: Database, after: string, page: RecordChangePage, deps: Dependencies) {
  const result = emptyRecordCachePullResult()
  const fallbacks = new Set<string>()
  let project = false
  const applied = writeTransaction(() => {
    if (readMeta(local, CURSOR) !== after) return false
    for (const change of [...page.changes].sort((a, b) => order(a) - order(b))) {
      const orphan = orphanFamily(local, change)
      if (orphan) {
        result.orphans++
        fallbacks.add(`${orphan}:${change.space}`)
        continue
      }
      if (change.op === 'delete') deleteChange(local, change, deps)
      else upsertChange(local, change, deps, result)
      result.changes++
      if (change.table === 'project') project = true
    }
    writeMeta(local, CURSOR, page.cursor)
    return true
  }, local)
  return { applied, result, fallbacks, project }
}

function addResult(target: RecordCachePullResult, value: Partial<RecordCachePullResult>) {
  for (const key of [
    'docs',
    'skippedDocs',
    'subjects',
    'skippedSubjects',
    'scores',
    'lensCatalogue',
    'workflowCatalogue',
    'portCatalogue',
    'changes',
    'orphans',
  ] as const)
    target[key] += value[key] ?? 0
  if (value.routingPool) {
    target.routingPool.added += value.routingPool.added
    target.routingPool.updated += value.routingPool.updated
    target.routingPool.caughtUp &&= value.routingPool.caughtUp
  }
  if (value.projectRegister) target.projectRegister = value.projectRegister
}

async function runFallbacks(
  local: Database,
  fallbacks: Set<string>,
  identity: RecordIdentity,
  deps: Dependencies,
): Promise<RecordCachePullResult> {
  const result = emptyRecordCachePullResult()
  const cache = deps.cacheSpaces(identity, local)
  for (const value of fallbacks) {
    const split = value.indexOf(':')
    const family = value.slice(0, split) as FallbackFamily
    const space = value.slice(split + 1)
    if (family === 'doc')
      addResult(result, await deps.pullDocs(local, identity, [space], cache.projectSpaces))
    else if (family === 'subject')
      addResult(result, await deps.pullSubjects(local, [space], cache.projectSpaces))
    else if (family === 'lens') result.lensCatalogue += await pullLensCatalogue(local, [space])
    else if (family === 'workflow')
      result.workflowCatalogue += (await pullWorkflowCatalogue(local, [space])).count
    else result.portCatalogue += (await pullPortCatalogue(local, [space])).count
  }
  return result
}

async function resetAt(
  local: Database,
  identity: RecordIdentity,
  spaces: string[],
  cursor: string,
  deps: Dependencies,
) {
  const result = await deps.pullKeysets(local, identity, spaces)
  writeTransaction(() => {
    writeMeta(local, CURSOR, cursor)
    writeMeta(local, SPACES, JSON.stringify(spaces))
  }, local)
  return { ...result, changes: 0, orphans: 0, reset: true }
}

export async function pullRecordCacheFeed(
  local: Database,
  suppliedIdentity: RecordIdentity | undefined,
  deps: Dependencies,
): Promise<RecordCachePullResult> {
  if (!local.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'").get())
    return emptyRecordCachePullResult()
  const client: RecordApiClient = recordApiClient()
  const identity = suppliedIdentity ?? (await client.whoami())
  if (!identity.activeSpaceId) throw new Error(noActiveRecordSpaceRefusal())
  rememberSignedInRecordUser(identity.user, local)
  rememberActiveRecordSpace(local, identity.activeSpaceId)
  const spaces = membershipSpaces(identity)
  const previous = rememberedSpaces(local)
  purgeLostSpaces(
    local,
    previous.filter((space) => !spaces.includes(space)),
  )
  let cursor = readMeta(local, CURSOR)
  if (!cursor) {
    const first = await client.listChanges!({ wait: 0 })
    if ('reset' in first) return resetAt(local, identity, spaces, first.reset.cursor, deps)
    throw new Error('record change feed did not provide a reset cursor for an uninitialized cache')
  }
  const joined = spaces.filter((space) => !previous.includes(space))
  const result = emptyRecordCachePullResult()
  if (joined.length) addResult(result, await deps.pullKeysets(local, identity, joined))
  writeMeta(local, SPACES, JSON.stringify(spaces))
  for (;;) {
    const response = await client.listChanges!({ after: cursor, wait: 0 })
    if ('reset' in response) return resetAt(local, identity, spaces, response.reset.cursor, deps)
    const page = applyPage(local, cursor, response, deps)
    if (!page.applied) {
      cursor = readMeta(local, CURSOR) ?? cursor
      continue
    }
    addResult(result, page.result)
    addResult(result, await runFallbacks(local, page.fallbacks, identity, deps))
    if (page.project) result.projectRegister = await pullProjectRegister(local, spaces, client)
    cursor = response.cursor
    if (!response.changes.length) return result
  }
}
