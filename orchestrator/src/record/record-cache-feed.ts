// concern: record-cache
/** Advances the local record mirror from the ordered hosted change feed. */
import type { Database } from 'bun:sqlite'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { nowIso, writeTransaction } from '../database/db.ts'
import { projectRowByName } from '../project/projects.ts'
import { rememberActiveRecordSpace } from '../project-space.ts'
import { applySubjectRecord, deleteSubjectRecord, purgeSubjectSpace } from '../subject/subjects.ts'
import { type RecordApiClient, recordApiClient } from './record-api-client.ts'
import type { RecordChangePage } from './record-api-client-changes.ts'
import type { RecordIdentity } from './record-auth.ts'
import { readCursor, writeCursor } from './record-cache-cursor.ts'
import {
  applyLensCatalogueRow,
  deleteLensCatalogueRow,
  lensCatalogueParentPresent,
  pullLensCatalogue,
  purgeLensCatalogueSpace,
} from './record-cache-lens.ts'
import { recordCacheSpaceOwnsAddress } from './record-cache-ownership.ts'
import {
  applyPortCatalogueRow,
  deletePortCatalogueRow,
  portCatalogueParentPresent,
  pullPortCatalogue,
  purgePortCatalogueSpace,
} from './record-cache-port.ts'
import { type ProjectRegisterPullResult, pullProjectRegister } from './record-cache-projects.ts'
import {
  applyWorkflowCatalogueRow,
  deleteWorkflowCatalogueRow,
  pullWorkflowCatalogue,
  purgeWorkflowCatalogueSpace,
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
import {
  deleteRoutingPoolRow,
  purgeRoutingPoolSpace,
  type RoutingPoolPullResult,
  upsertPoolRun,
} from './record-routing-pool.ts'
import { rememberSignedInRecordUser } from './record-session.ts'
import { RECORD_WORKFLOW_TABLES, type RecordWorkflowTable } from './record-workflow-contract.ts'

const CURSOR = 'record_change_cursor'
const SPACES = 'record_change_spaces'
const PULL_SPACES = 'record_change_pull_spaces'
const FALLBACKS = 'record_change_fallbacks'

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
  deletesBlocked: 0,
  purgeKept: 0,
  purgeWarning: null as string | null,
  reset: false,
})
export type RecordCachePullResult = ReturnType<typeof emptyRecordCachePullResult>

type KeysetResult = Omit<
  RecordCachePullResult,
  'changes' | 'orphans' | 'deletesBlocked' | 'purgeKept' | 'purgeWarning' | 'reset'
>
type Dependencies = {
  cacheSpaces(
    identity: RecordIdentity,
    local: Database,
  ): { spaces: string[]; projectSpaces: ReadonlyMap<string, string | null> }
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
  deleteDoc(local: Database, recordId: string): boolean
  prepareDocSpacePurge(local: Database, spaceId: string): void
  purgeDocSpace(local: Database, spaceId: string): number
  applyScore(local: Database, row: Record<string, unknown>): void
}
type Change = RecordChangePage['changes'][number]
type UpsertChange = Extract<Change, { op: 'upsert' }>
type FallbackFamily = 'doc' | 'subject' | 'lens' | 'workflow' | 'port'

const pendingFallbacks = (local: Database): Set<string> => new Set(storedSpaces(local, FALLBACKS))

const writePendingFallbacks = (local: Database, values: ReadonlySet<string>): void =>
  writeCursor(local, FALLBACKS, JSON.stringify([...values].sort()))

const fallbackSpace = (value: string): string => value.slice(value.indexOf(':') + 1)

const storedSpaces = (local: Database, key: string): string[] => {
  const value = readCursor(local, key)
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

const rememberedSpaces = (local: Database): string[] => storedSpaces(local, SPACES)
const previousPullSpaces = (local: Database, remembered: string[]): string[] =>
  readCursor(local, PULL_SPACES) === undefined ? remembered : storedSpaces(local, PULL_SPACES)

const accessSpaces = (identity: RecordIdentity): string[] =>
  [
    ...new Set([
      ...parseRecordSpaceMemberships(identity.memberships).map((membership) => membership.spaceId),
      ...(identity.activeSpaceId ? [identity.activeSpaceId] : []),
    ]),
  ].sort()

const unionSpaces = (...sets: readonly string[][]): string[] => [...new Set(sets.flat())].sort()

function purgeLostSpaces(local: Database, spaces: readonly string[], deps: Dependencies): number {
  if (!spaces.length) return 0
  return writeTransaction(() => {
    let kept = 0
    for (const space of spaces) {
      deps.prepareDocSpacePurge(local, space)
      kept += deps.purgeDocSpace(local, space)
      kept += purgeSubjectSpace(local, space)
      kept += purgeLensCatalogueSpace(local, space)
      kept += purgeWorkflowCatalogueSpace(local, space)
      kept += purgePortCatalogueSpace(local, space)
      kept += purgeRoutingPoolSpace(local, space)
    }
    const pending = pendingFallbacks(local)
    for (const value of pending) if (spaces.includes(fallbackSpace(value))) pending.delete(value)
    writePendingFallbacks(local, pending)
    return kept
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

type DeleteResult = 'deleted' | 'blocked' | 'skipped'

type SpaceProbe = (local: Database) => ReturnType<Database['query']>
/** One literal probe per catalogue contract table; a contract table without one fails to compile. */
const CATALOGUE_SPACE_PROBES: Record<
  RecordLensTable | RecordWorkflowTable | RecordPortTable,
  SpaceProbe
> = {
  lens: (local) => local.query('SELECT space_id FROM lens WHERE record_id=?'),
  lens_revision: (local) => local.query('SELECT space_id FROM lens_revision WHERE record_id=?'),
  lens_profile: (local) => local.query('SELECT space_id FROM lens_profile WHERE record_id=?'),
  lens_profile_revision: (local) =>
    local.query('SELECT space_id FROM lens_profile_revision WHERE record_id=?'),
  project_lens_profile: (local) =>
    local.query('SELECT space_id FROM project_lens_profile WHERE record_id=?'),
  project_lens_profile_revision: (local) =>
    local.query('SELECT space_id FROM project_lens_profile_revision WHERE record_id=?'),
  step_catalogue: (local) => local.query('SELECT space_id FROM step_catalogue WHERE record_id=?'),
  step_catalogue_version: (local) =>
    local.query('SELECT space_id FROM step_catalogue_version WHERE record_id=?'),
  step_catalogue_event: (local) =>
    local.query('SELECT space_id FROM step_catalogue_event WHERE record_id=?'),
  workflow: (local) => local.query('SELECT space_id FROM workflow WHERE record_id=?'),
  workflow_version: (local) =>
    local.query('SELECT space_id FROM workflow_version WHERE record_id=?'),
  workflow_event: (local) => local.query('SELECT space_id FROM workflow_event WHERE record_id=?'),
  port_doctrine: (local) => local.query('SELECT space_id FROM port_doctrine WHERE record_id=?'),
  port_pair: (local) => local.query('SELECT space_id FROM port_pair WHERE record_id=?'),
  port_baseline: (local) => local.query('SELECT space_id FROM port_baseline WHERE record_id=?'),
  port_ref: (local) => local.query('SELECT space_id FROM port_ref WHERE record_id=?'),
  port_ref_source: (local) => local.query('SELECT space_id FROM port_ref_source WHERE record_id=?'),
  port_skip: (local) => local.query('SELECT space_id FROM port_skip WHERE record_id=?'),
}

function catalogueLocalRow(
  local: Database,
  table: string,
  recordId: string,
): { space_id: string | null } | null | undefined {
  if (!Object.hasOwn(CATALOGUE_SPACE_PROBES, table)) return undefined
  const probe = CATALOGUE_SPACE_PROBES[table as keyof typeof CATALOGUE_SPACE_PROBES]
  return probe(local).get(recordId) as { space_id: string | null } | null
}

function localRowSpace(local: Database, change: Change): string | null | undefined {
  let row: { space_id: string | null } | null = null
  if (change.table === 'doc')
    row = local
      .query<{ space_id: string | null }, [string]>('SELECT space_id FROM doc WHERE record_id=?')
      .get(change.id)
  else if (change.table === 'subject')
    row = local
      .query<{ space_id: string | null }, [string]>('SELECT space_id FROM subject WHERE id=?')
      .get(change.id)
  else if (change.table === 'routing_evidence')
    row = local
      .query<{ space_id: string | null }, [string]>(
        'SELECT space_id FROM routing_pool_run WHERE record_id=?',
      )
      .get(change.id)
  else if (lensTable(change.table) || workflowTable(change.table) || portTable(change.table))
    row = catalogueLocalRow(local, change.table, change.id) ?? null
  return row?.space_id
}

function deleteChange(local: Database, change: Change, deps: Dependencies): DeleteResult {
  const space = localRowSpace(local, change)
  if (space != null && space !== change.space) return 'skipped'
  if (change.table === 'run_score' || change.table === 'project') return 'skipped'
  let deleted: boolean
  if (change.table === 'doc') {
    deleted = deps.deleteDoc(local, change.id)
  } else if (change.table === 'subject') {
    deleted = deleteSubjectRecord(local, change.id)
  } else if (change.table === 'routing_evidence') {
    deleted = deleteRoutingPoolRow(local, change.id)
  } else if (lensTable(change.table)) {
    deleted = deleteLensCatalogueRow(local, change.table, change.id)
  } else if (workflowTable(change.table)) {
    deleted = deleteWorkflowCatalogueRow(local, change.table, change.id)
  } else if (portTable(change.table)) {
    deleted = deletePortCatalogueRow(local, change.table, change.id, change.space)
  } else {
    return 'skipped'
  }
  return deleted ? 'deleted' : 'blocked'
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

type Ownership = {
  activeSpaceId: string
  projectSpaces: ReadonlyMap<string, string | null>
}

function feedEntryOwned(local: Database, change: Change, ownership: Ownership): boolean {
  if (change.table === 'doc') {
    const row =
      change.op === 'upsert'
        ? change.row
        : local
            .query<{ scope: string; subject: string | null }, [string]>(
              'SELECT scope,subject FROM doc WHERE record_id=?',
            )
            .get(change.id)
    return (
      !row ||
      recordCacheSpaceOwnsAddress({
        scope: String(row.scope),
        subject: row.subject == null ? null : String(row.subject),
        pullingSpaceId: change.space,
        ...ownership,
      })
    )
  }
  if (change.table === 'subject') {
    const project =
      change.op === 'upsert'
        ? String(change.row.project)
        : local
            .query<{ name: string }, [string]>(
              'SELECT project.name FROM subject JOIN project ON project.record_id=subject.project_record_id WHERE subject.id=?',
            )
            .get(change.id)?.name
    return project === undefined || ownership.projectSpaces.get(project) === change.space
  }
  return true
}

function applyFeedUpsert(
  local: Database,
  change: Change,
  deps: Dependencies,
  result: RecordCachePullResult,
  fallbacks: Set<string>,
  orphans: Change[],
): void {
  const orphan = orphanFamily(local, change)
  if (orphan) {
    fallbacks.add(`${orphan}:${change.space}`)
    orphans.push(change)
    return
  }
  if (change.op === 'delete') return
  upsertChange(local, change, deps, result)
  result.changes++
}

function applyPage(
  local: Database,
  after: string,
  page: RecordChangePage,
  deps: Dependencies,
  ownership: Ownership,
) {
  const result = emptyRecordCachePullResult()
  const fallbacks = new Set<string>()
  const orphans: Change[] = []
  let project = false
  const applied = writeTransaction(() => {
    if (readCursor(local, CURSOR) !== after) return false
    const owned = page.changes.filter((change) => {
      if (feedEntryOwned(local, change, ownership)) return true
      if (change.op === 'upsert' && change.table === 'doc') result.skippedDocs++
      else if (change.op === 'upsert' && change.table === 'subject') result.skippedSubjects++
      return false
    })
    project = owned.some((change) => change.table === 'project')
    for (const change of owned
      .filter((entry): entry is UpsertChange => entry.op === 'upsert')
      .sort((a, b) => order(a) - order(b)))
      applyFeedUpsert(local, change, deps, result, fallbacks, orphans)
    let pending: Change[] = owned
      .filter((entry) => entry.op === 'delete')
      .sort((a, b) => order(b) - order(a))
    for (;;) {
      const blocked: Change[] = []
      let deleted = 0
      for (const change of pending) {
        const outcome = deleteChange(local, change, deps)
        if (outcome === 'deleted') {
          result.changes++
          deleted++
        } else if (outcome === 'blocked') blocked.push(change)
      }
      pending = blocked
      if (!deleted || !pending.length) break
    }
    result.deletesBlocked += pending.length
    const scheduled = pendingFallbacks(local)
    for (const value of fallbacks) scheduled.add(value)
    writePendingFallbacks(local, scheduled)
    writeCursor(local, CURSOR, page.cursor)
    return true
  }, local)
  return { applied, result, fallbacks, orphans, project }
}

function feedRowPresent(local: Database, change: Change): boolean {
  if (change.table === 'doc')
    return Boolean(local.query('SELECT 1 FROM doc WHERE record_id=?').get(change.id))
  if (change.table === 'subject')
    return Boolean(local.query('SELECT 1 FROM subject WHERE id=?').get(change.id))
  if (change.table === 'routing_evidence')
    return Boolean(local.query('SELECT 1 FROM routing_pool_run WHERE record_id=?').get(change.id))
  const catalogue = catalogueLocalRow(local, change.table, change.id)
  if (catalogue !== undefined) return Boolean(catalogue)
  throw new Error(`record feed row presence is not defined for table ${change.table}`)
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
    'deletesBlocked',
    'purgeKept',
  ] as const)
    target[key] += value[key] ?? 0
  if (value.routingPool) {
    target.routingPool.added += value.routingPool.added
    target.routingPool.updated += value.routingPool.updated
    target.routingPool.caughtUp &&= value.routingPool.caughtUp
  }
  if (value.projectRegister) target.projectRegister = value.projectRegister
  if (value.purgeWarning) target.purgeWarning = value.purgeWarning
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
    let completed = true
    if (family === 'doc')
      addResult(result, await deps.pullDocs(local, identity, [space], cache.projectSpaces))
    else if (family === 'subject')
      addResult(result, await deps.pullSubjects(local, [space], cache.projectSpaces))
    else if (family === 'lens') result.lensCatalogue += await pullLensCatalogue(local, [space])
    else if (family === 'workflow') {
      const pulled = await pullWorkflowCatalogue(local, [space])
      result.workflowCatalogue += pulled.count
      completed = pulled.completedSpaces.has(space)
    } else {
      const pulled = await pullPortCatalogue(local, [space])
      result.portCatalogue += pulled.count
      completed = pulled.completedSpaces.has(space)
    }
    if (completed)
      writeTransaction(() => {
        const pending = pendingFallbacks(local)
        pending.delete(value)
        writePendingFallbacks(local, pending)
      }, local)
  }
  return result
}

async function resetAt(
  local: Database,
  identity: RecordIdentity,
  spaces: string[],
  remembered: string[],
  cursor: string,
  deps: Dependencies,
) {
  const result = await deps.pullKeysets(local, identity, spaces)
  writeTransaction(() => {
    writeCursor(local, CURSOR, cursor)
    writeCursor(local, SPACES, JSON.stringify(remembered))
    writeCursor(local, PULL_SPACES, JSON.stringify(spaces))
  }, local)
  return {
    ...emptyRecordCachePullResult(),
    ...result,
    reset: true,
  }
}

async function prepareFeedIdentity(
  local: Database,
  suppliedIdentity: RecordIdentity | undefined,
  client: RecordApiClient,
  deps: Dependencies,
): Promise<
  | { stopped: RecordCachePullResult }
  | {
      identity: RecordIdentity & { activeSpaceId: string }
      spaces: string[]
      remembered: string[]
      previousPull: string[]
      lost: string[]
      purgeWarning: string | null
    }
> {
  const identity = suppliedIdentity ?? (await client.whoami())
  rememberSignedInRecordUser(identity.user, local)
  if (identity.activeSpaceId) rememberActiveRecordSpace(local, identity.activeSpaceId)
  const spaces = deps.cacheSpaces(identity, local).spaces
  const remembered = rememberedSpaces(local)
  const memberships = parseRecordSpaceMemberships(identity.memberships)
  if (!identity.activeSpaceId && !memberships.length && remembered.length) {
    const stopped = emptyRecordCachePullResult()
    stopped.purgeWarning = 'record spaces could not be confirmed; remembered spaces were not purged'
    return { stopped }
  }
  if (!identity.activeSpaceId) throw new Error(noActiveRecordSpaceRefusal())
  const purgeWarning =
    !memberships.length && remembered.length
      ? 'record spaces could not be confirmed; remembered spaces were not purged'
      : null
  const access = accessSpaces(identity)
  return {
    identity: identity as RecordIdentity & { activeSpaceId: string },
    spaces,
    remembered,
    previousPull: previousPullSpaces(local, remembered),
    lost: purgeWarning ? [] : remembered.filter((space) => !access.includes(space)),
    purgeWarning,
  }
}

export async function pullRecordCacheFeed(
  local: Database,
  suppliedIdentity: RecordIdentity | undefined,
  deps: Dependencies,
): Promise<RecordCachePullResult> {
  if (!local.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'").get())
    return emptyRecordCachePullResult()
  const client: RecordApiClient = recordApiClient()
  const prepared = await prepareFeedIdentity(local, suppliedIdentity, client, deps)
  if ('stopped' in prepared) return prepared.stopped
  const { identity, spaces, remembered, previousPull, lost, purgeWarning } = prepared
  const cache = deps.cacheSpaces(identity, local)
  const result = emptyRecordCachePullResult()
  result.purgeWarning = purgeWarning
  result.purgeKept += purgeLostSpaces(local, lost, deps)
  const nextRemembered = unionSpaces(
    remembered.filter((space) => !lost.includes(space)),
    spaces,
  )
  let cursor = readCursor(local, CURSOR)
  if (!cursor) {
    const first = await client.listChanges({ wait: 0 })
    if ('reset' in first) {
      addResult(
        result,
        await resetAt(local, identity, spaces, nextRemembered, first.reset.cursor, deps),
      )
      result.reset = true
      return result
    }
    throw new Error('record change feed did not provide a reset cursor for an uninitialized cache')
  }
  const joined = spaces.filter((space) => !previousPull.includes(space))
  if (joined.length) addResult(result, await deps.pullKeysets(local, identity, joined))
  addResult(result, await runFallbacks(local, pendingFallbacks(local), identity, deps))
  writeTransaction(() => {
    writeCursor(local, SPACES, JSON.stringify(nextRemembered))
    writeCursor(local, PULL_SPACES, JSON.stringify(spaces))
  }, local)
  for (;;) {
    const response = await client.listChanges({ after: cursor, wait: 0 })
    if ('reset' in response) {
      addResult(
        result,
        await resetAt(local, identity, spaces, nextRemembered, response.reset.cursor, deps),
      )
      result.reset = true
      return result
    }
    const page = applyPage(local, cursor, response, deps, {
      activeSpaceId: identity.activeSpaceId,
      projectSpaces: cache.projectSpaces,
    })
    if (!page.applied) {
      cursor = readCursor(local, CURSOR) ?? cursor
      continue
    }
    addResult(result, page.result)
    addResult(result, await runFallbacks(local, page.fallbacks, identity, deps))
    result.orphans += page.orphans.filter((change) => !feedRowPresent(local, change)).length
    if (page.project) result.projectRegister = await pullProjectRegister(local, spaces, client)
    cursor = response.cursor
    if (!response.changes.length) return result
  }
}
