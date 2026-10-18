// concern: record-cache-port
/** Pulls and reconciles the six hosted port item streams. */
import type { Database } from 'bun:sqlite'
import { writeTransaction } from '../database/db.ts'
import { recordApiClient } from './record-api-client.ts'
import {
  decodeRecordCursor,
  encodeRecordCursor,
  parseStoredRecordCursor,
  type RecordCursor,
} from './record-cursor.ts'
import {
  RECORD_PORT_TABLES,
  type RecordPortTable,
  type RecordPortWriteResponse,
} from './record-port-contract.ts'

const CURSOR = 'record_port_cursor'
const read = (local: Database, key: string) =>
  local.query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?').get(key)
    ?.value
const cursor = (local: Database, key: string): RecordCursor | undefined => {
  const value = read(local, key)
  if (value === undefined) return undefined
  const parsed = parseStoredRecordCursor(value, false)
  if ('cursor' in parsed) return parsed.cursor
  throw new Error(`invalid record cache cursor for ${key}`)
}
const remember = (local: Database, key: string, value: RecordCursor) =>
  local
    .query(
      'INSERT INTO schema_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, JSON.stringify(value))

export async function pullPortCatalogue(
  local: Database,
  spaces: readonly string[],
): Promise<{ count: number; completedSpaces: ReadonlySet<string> }> {
  let count = 0
  const completedSpaces = new Set<string>()
  for (const spaceId of spaces) {
    let completed = true
    for (const table of RECORD_PORT_TABLES) {
      const pulled = await pullTable(local, spaceId, table)
      count += pulled.count
      if (!pulled.completed) {
        completed = false
        break
      }
    }
    if (completed) completedSpaces.add(spaceId)
  }
  return { count, completedSpaces }
}

async function pullTable(
  local: Database,
  spaceId: string,
  table: RecordPortTable,
): Promise<{ count: number; completed: boolean }> {
  const key = `${CURSOR}:${spaceId}:${table}`
  let current = cursor(local, key)
  let requestCursor = current ? encodeRecordCursor(current) : undefined
  let count = 0
  for (;;) {
    const page = await recordApiClient().listPortCatalogue!(
      table,
      { limit: 100, cursor: requestCursor },
      { destinationSpaceId: spaceId },
    )
    if (!page.items.length) return { count, completed: true }
    if (page.items.some((item) => !parentPresent(local, table, item)))
      return { count, completed: false }
    writeTransaction(() => {
      for (const item of page.items) {
        applyPortCatalogueRow(local, table, item)
        count++
      }
      const last = page.items.at(-1)!
      const timestamp =
        table === 'port_pair' ? 'createdAt' : table === 'port_skip' ? 'skippedAt' : 'updatedAt'
      current = page.endCursor
        ? decodeRecordCursor(page.endCursor)
        : { at: String(last[timestamp]), id: String(last.id) }
      remember(local, key, current)
    }, local)
    if (!page.nextCursor) return { count, completed: true }
    requestCursor = page.nextCursor
  }
}

const hasProject = (local: Database, id: unknown) =>
  Boolean(local.query('SELECT 1 FROM project WHERE record_id=?').get(String(id)))
const hasPair = (local: Database, id: unknown, spaceId: unknown) =>
  Boolean(
    local
      .query('SELECT 1 FROM port_pair WHERE record_id=? AND space_id=?')
      .get(String(id), String(spaceId)),
  )
const hasRef = (local: Database, id: unknown, spaceId: unknown) =>
  Boolean(
    local
      .query('SELECT 1 FROM port_ref WHERE record_id=? AND space_id=?')
      .get(String(id), String(spaceId)),
  )
function parentPresent(local: Database, table: RecordPortTable, item: Record<string, unknown>) {
  switch (table) {
    case 'port_pair':
      return hasProject(local, item.sourceProjectId) && hasProject(local, item.targetProjectId)
    case 'port_baseline':
    case 'port_skip':
      return hasPair(local, item.pairId, item.spaceId)
    case 'port_ref':
      return hasProject(local, item.targetProjectId)
    case 'port_ref_source':
      return (
        (item.deletedAt != null || hasRef(local, item.refId, item.spaceId)) &&
        hasProject(local, item.sourceProjectId)
      )
    default:
      return true
  }
}

const nullable = (value: unknown) => (value == null ? null : String(value))
export function applyPortCatalogueRow(
  local: Database,
  table: RecordPortTable,
  item: Record<string, unknown>,
): void {
  applicators[table](local, item)
}
type Applicator = (local: Database, item: Record<string, unknown>) => void
const applicators: Record<RecordPortTable, Applicator> = {
  port_doctrine: applyDoctrine,
  port_pair: applyPair,
  port_baseline: applyBaseline,
  port_ref: applyRef,
  port_ref_source: applyRefSource,
  port_skip: applySkip,
}
function applyDoctrine(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const spaceId = String(item.spaceId)
  const found =
    local
      .query<{ record_id: string }, [string, string]>(
        'SELECT record_id FROM port_doctrine WHERE record_id=? AND space_id=?',
      )
      .get(recordId, spaceId) ??
    local
      .query<{ record_id: string }, [string, number]>(
        'SELECT record_id FROM port_doctrine WHERE space_id=? AND number=?',
      )
      .get(spaceId, Number(item.number))
  const values = [
    String(item.title),
    String(item.body),
    String(item.createdAt),
    nullable(item.retiredAt),
    Number(item.version),
  ]
  if (found)
    local
      .query(
        'UPDATE port_doctrine SET record_id=?,title=?,body=?,created_at=?,retired_at=?,version=? WHERE record_id=? AND space_id=?',
      )
      .run(recordId, ...values, found.record_id, spaceId)
  else
    local
      .query(
        'INSERT INTO port_doctrine (record_id,space_id,number,title,body,created_at,retired_at,version) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(recordId, spaceId, Number(item.number), ...values)
}
function applyPair(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const spaceId = String(item.spaceId)
  const found =
    local
      .query<{ id: number }, [string, string]>(
        'SELECT id FROM port_pair WHERE record_id=? AND space_id=?',
      )
      .get(recordId, spaceId) ??
    local
      .query<{ id: number }, [string, string, string]>(
        'SELECT id FROM port_pair WHERE space_id=? AND source_project_record_id=? AND target_project_record_id=?',
      )
      .get(spaceId, String(item.sourceProjectId), String(item.targetProjectId))
  const values = [
    recordId,
    spaceId,
    String(item.sourceProjectId),
    String(item.targetProjectId),
    String(item.createdAt),
  ]
  if (found)
    local
      .query(
        'UPDATE port_pair SET record_id=?,space_id=?,source_project_record_id=?,target_project_record_id=?,created_at=? WHERE id=?',
      )
      .run(...values, found.id)
  else
    local
      .query(
        'INSERT INTO port_pair (record_id,space_id,source_project_record_id,target_project_record_id,created_at) VALUES (?,?,?,?,?)',
      )
      .run(...values)
}
function portPairId(local: Database, item: Record<string, unknown>, spaceId: string): number {
  return local
    .query<{ id: number }, [string, string]>(
      'SELECT id FROM port_pair WHERE record_id=? AND space_id=?',
    )
    .get(String(item.pairId), spaceId)!.id
}
function applyBaseline(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const spaceId = String(item.spaceId)
  const pairId = portPairId(local, item, spaceId)
  const found =
    local
      .query<{ pair_id: number }, [string, string]>(
        'SELECT pair_id FROM port_baseline WHERE record_id=? AND space_id=?',
      )
      .get(recordId, spaceId) ??
    local
      .query<{ pair_id: number }, [number]>('SELECT pair_id FROM port_baseline WHERE pair_id=?')
      .get(pairId)
  const values = [
    recordId,
    spaceId,
    pairId,
    nullable(item.sourceCommit),
    nullable(item.scannedAt),
    Number(item.version),
  ]
  if (found)
    local
      .query(
        'UPDATE port_baseline SET record_id=?,space_id=?,pair_id=?,source_commit=?,scanned_at=?,version=? WHERE pair_id=?',
      )
      .run(...values, found.pair_id)
  else
    local
      .query(
        'INSERT INTO port_baseline (record_id,space_id,pair_id,source_commit,scanned_at,version) VALUES (?,?,?,?,?,?)',
      )
      .run(...values)
}
function applySkip(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const spaceId = String(item.spaceId)
  const pairId = portPairId(local, item, spaceId)
  const found =
    local
      .query<{ id: number }, [string, string]>(
        'SELECT id FROM port_skip WHERE record_id=? AND space_id=?',
      )
      .get(recordId, spaceId) ??
    local
      .query<{ id: number }, [string, number, string]>(
        'SELECT id FROM port_skip WHERE space_id=? AND pair_id=? AND candidate=?',
      )
      .get(spaceId, pairId, String(item.candidate))
  const values = [
    recordId,
    spaceId,
    pairId,
    String(item.candidate),
    String(item.reason),
    String(item.skippedAt),
  ]
  if (found)
    local
      .query(
        'UPDATE port_skip SET record_id=?,space_id=?,pair_id=?,candidate=?,reason=?,skipped_at=? WHERE id=?',
      )
      .run(...values, found.id)
  else
    local
      .query(
        'INSERT INTO port_skip (record_id,space_id,pair_id,candidate,reason,skipped_at) VALUES (?,?,?,?,?,?)',
      )
      .run(...values)
}
function applyRef(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const spaceId = String(item.spaceId)
  if (item.deletedAt != null) {
    local.query('DELETE FROM port_ref WHERE record_id=? AND space_id=?').run(recordId, spaceId)
    return
  }
  const found =
    local
      .query<{ record_id: string }, [string, string]>(
        'SELECT record_id FROM port_ref WHERE record_id=? AND space_id=?',
      )
      .get(recordId, spaceId) ??
    local
      .query<{ record_id: string }, [string, string, string]>(
        'SELECT record_id FROM port_ref WHERE space_id=? AND target_project_record_id=? AND task_key=?',
      )
      .get(spaceId, String(item.targetProjectId), String(item.taskKey))
  const values = [
    recordId,
    spaceId,
    String(item.taskKey),
    String(item.targetProjectId),
    String(item.note),
    String(item.createdAt),
    nullable(item.resolvedAt),
    Number(item.version),
  ]
  if (found)
    local
      .query(
        'UPDATE port_ref SET record_id=?,space_id=?,task_key=?,target_project_record_id=?,note=?,created_at=?,resolved_at=?,version=? WHERE record_id=? AND space_id=?',
      )
      .run(...values, found.record_id, spaceId)
  else
    local
      .query(
        'INSERT INTO port_ref (record_id,space_id,task_key,target_project_record_id,note,created_at,resolved_at,version) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(...values)
}
function applyRefSource(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const spaceId = String(item.spaceId)
  const parent = local
    .query<{ task_key: string; target_project_record_id: string }, [string, string]>(
      'SELECT task_key,target_project_record_id FROM port_ref WHERE record_id=? AND space_id=?',
    )
    .get(String(item.refId), spaceId)
  if (item.deletedAt != null) {
    local
      .query('DELETE FROM port_ref_source WHERE record_id=? AND space_id=?')
      .run(recordId, spaceId)
    return
  }
  if (!parent)
    throw new Error(`record cache could not resolve port ref parent ${String(item.refId)}`)
  const found =
    local
      .query<{ id: number }, [string, string]>(
        'SELECT id FROM port_ref_source WHERE record_id=? AND space_id=?',
      )
      .get(recordId, spaceId) ??
    local
      .query<{ id: number }, [string, string, string, string]>(
        'SELECT id FROM port_ref_source WHERE space_id=? AND target_project_record_id=? AND task_key=? AND source_project_record_id=?',
      )
      .get(spaceId, parent.target_project_record_id, parent.task_key, String(item.sourceProjectId))
  const values = [
    recordId,
    spaceId,
    parent.task_key,
    parent.target_project_record_id,
    String(item.sourceProjectId),
    String(item.commits),
    String(item.paths),
    String(item.note),
  ]
  if (found)
    local
      .query(
        'UPDATE port_ref_source SET record_id=?,space_id=?,task_key=?,target_project_record_id=?,source_project_record_id=?,commits=?,paths=?,note=? WHERE id=?',
      )
      .run(...values, found.id)
  else
    local
      .query(
        'INSERT INTO port_ref_source (record_id,space_id,task_key,target_project_record_id,source_project_record_id,commits,paths,note) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(...values)
}

export function applyPortWriteResponse(local: Database, response: RecordPortWriteResponse): void {
  writeTransaction(() => {
    if (response.doctrine) applyPortCatalogueRow(local, 'port_doctrine', response.doctrine)
    if (response.pair) applyPortCatalogueRow(local, 'port_pair', response.pair)
    if (response.baseline) applyPortCatalogueRow(local, 'port_baseline', response.baseline)
    if (response.ref) applyPortCatalogueRow(local, 'port_ref', response.ref)
    for (const source of response.sources ?? [])
      applyPortCatalogueRow(local, 'port_ref_source', source)
    if (response.skip) applyPortCatalogueRow(local, 'port_skip', response.skip)
  }, local)
}
