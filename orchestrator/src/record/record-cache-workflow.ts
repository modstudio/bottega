// concern: record-cache-workflow
/** Pulls and reconciles the six hosted workflow catalogue streams. */
import type { Database } from 'bun:sqlite'
import { writeTransaction } from '../database/db.ts'
import { recordApiClient } from './record-api-client.ts'
import {
  decodeRecordCursor,
  encodeRecordCursor,
  parseStoredRecordCursor,
  type RecordCursor,
} from './record-cursor.ts'
import type { RecordWorkflowKind, RecordWorkflowWriteResponse } from './record-workflow-contract.ts'
import { RECORD_WORKFLOW_TABLES, type RecordWorkflowTable } from './record-workflow-contract.ts'

const CURSOR = 'record_workflow_cursor'
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

export async function pullWorkflowCatalogue(
  local: Database,
  spaces: readonly string[],
): Promise<{ count: number; completedSpaces: ReadonlySet<string> }> {
  let count = 0
  const completedSpaces = new Set<string>()
  for (const spaceId of spaces) {
    let completed = true
    for (const table of RECORD_WORKFLOW_TABLES) {
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
  table: RecordWorkflowTable,
): Promise<{ count: number; completed: boolean }> {
  const key = `${CURSOR}:${spaceId}:${table}`
  let current = cursor(local, key),
    requestCursor = current ? encodeRecordCursor(current) : undefined,
    count = 0
  for (;;) {
    const page = await recordApiClient().listWorkflowCatalogue!(
      table,
      { limit: 100, cursor: requestCursor },
      { destinationSpaceId: spaceId },
    )
    if (!page.items.length) return { count, completed: true }
    if (page.items.some((item) => !parentPresent(local, table, item)))
      return { count, completed: false }
    writeTransaction(() => {
      for (const item of page.items) {
        applyWorkflowCatalogueRow(local, table, item)
        count++
      }
      const last = page.items.at(-1)!
      current = page.endCursor
        ? decodeRecordCursor(page.endCursor)
        : {
            at: String(last.updatedAt),
            id: String(last.record_id),
          }
      remember(local, key, current)
    }, local)
    if (!page.nextCursor) return { count, completed: true }
    requestCursor = page.nextCursor
  }
}

function names(table: RecordWorkflowTable) {
  const workflow = table.startsWith('workflow')
  return {
    identity: workflow ? 'workflow' : 'step_catalogue',
    version: workflow ? 'workflow_version' : 'step_catalogue_version',
    event: workflow ? 'workflow_event' : 'step_catalogue_event',
    foreign: workflow ? 'workflow_record_id' : 'catalogue_record_id',
    eventForeign: workflow ? 'workflow_version_record_id' : 'catalogue_version_record_id',
  }
}
function parentPresent(
  local: Database,
  table: RecordWorkflowTable,
  item: Record<string, unknown>,
): boolean {
  const n = names(table),
    spaceId = String(item.spaceId)
  if (table.endsWith('_version'))
    return Boolean(
      local
        .query(`SELECT record_id FROM ${n.identity} WHERE record_id=? AND space_id=?`)
        .get(String(item.ownerId), spaceId),
    )
  if (table.endsWith('_event'))
    return Boolean(
      local
        .query(`SELECT record_id FROM ${n.version} WHERE record_id=? AND space_id=?`)
        .get(String(item.ownerVersionId), spaceId),
    )
  return true
}

export function applyWorkflowCatalogueRow(
  local: Database,
  table: RecordWorkflowTable,
  item: Record<string, unknown>,
): void {
  applyWorkflowCatalogueRowWithResult(local, table, item)
}

function applyWorkflowCatalogueRowWithResult(
  local: Database,
  table: RecordWorkflowTable,
  item: Record<string, unknown>,
): boolean {
  const n = names(table),
    recordId = String(item.id),
    spaceId = String(item.spaceId)
  if (table === n.identity) return applyIdentity(local, n, item, recordId, spaceId)
  if (table === n.version) applyVersion(local, n, item, recordId, spaceId)
  else applyEvent(local, n, item, recordId, spaceId)
  return false
}

type Names = ReturnType<typeof names>
function applyIdentity(
  local: Database,
  n: Names,
  item: Record<string, unknown>,
  recordId: string,
  spaceId: string,
): boolean {
  const byRecordId = local
    .query<{ record_id: string; generation: number }, [string, string]>(
      `SELECT record_id,generation FROM ${n.identity} WHERE record_id=? AND space_id=?`,
    )
    .get(recordId, spaceId)
  const found =
    byRecordId ??
    local
      .query<{ record_id: string; generation: number }, [string, string]>(
        `SELECT record_id,generation FROM ${n.identity} WHERE space_id=? AND slug=?`,
      )
      .get(spaceId, String(item.slug))
  const generation = Number(item.generation ?? 1)
  const reconciled = Boolean(found && (generation !== found.generation || !byRecordId))
  if (found) {
    if (reconciled) {
      deleteIdentityHistory(local, n, spaceId, found.record_id)
      resetIdentityHistoryCursors(local, n, spaceId)
    }
    local
      .query(
        `UPDATE ${n.identity} SET record_id=?,slug=?,generation=?,created_at=? WHERE record_id=?`,
      )
      .run(recordId, String(item.slug), generation, String(item.createdAt), found.record_id)
  } else
    local
      .query(
        `INSERT INTO ${n.identity} (record_id,space_id,slug,generation,created_at) VALUES (?,?,?,?,?)`,
      )
      .run(recordId, spaceId, String(item.slug), generation, String(item.createdAt))
  return reconciled
}

function resetIdentityHistoryCursors(local: Database, n: Names, spaceId: string): void {
  local
    .query('DELETE FROM schema_meta WHERE key=? OR key=?')
    .run(`${CURSOR}:${spaceId}:${n.version}`, `${CURSOR}:${spaceId}:${n.event}`)
}

function deleteIdentityHistory(local: Database, n: Names, spaceId: string, parentId: string): void {
  if (n.event === 'workflow_event') {
    local
      .query(
        'DELETE FROM workflow_event WHERE space_id=? AND workflow_version_record_id IN (SELECT record_id FROM workflow_version WHERE workflow_record_id=?)',
      )
      .run(spaceId, parentId)
    local
      .query('DELETE FROM workflow_version WHERE space_id=? AND workflow_record_id=?')
      .run(spaceId, parentId)
  } else {
    local
      .query(
        'DELETE FROM step_catalogue_event WHERE space_id=? AND catalogue_version_record_id IN (SELECT record_id FROM step_catalogue_version WHERE catalogue_record_id=?)',
      )
      .run(spaceId, parentId)
    local
      .query('DELETE FROM step_catalogue_version WHERE space_id=? AND catalogue_record_id=?')
      .run(spaceId, parentId)
  }
}

function applyVersion(
  local: Database,
  n: Names,
  item: Record<string, unknown>,
  recordId: string,
  spaceId: string,
): void {
  const parent = local
    .query<{ record_id: string }, [string, string]>(
      `SELECT record_id FROM ${n.identity} WHERE record_id=? AND space_id=?`,
    )
    .get(String(item.ownerId), spaceId)!
  const byRecordId = local
    .query<{ record_id: string }, [string, string]>(
      `SELECT record_id FROM ${n.version} WHERE record_id=? AND space_id=?`,
    )
    .get(recordId, spaceId)
  const found =
    byRecordId ??
    local
      .query<{ record_id: string }, [string, number]>(
        `SELECT record_id FROM ${n.version} WHERE ${n.foreign}=? AND n=?`,
      )
      .get(parent.record_id, Number(item.n))
  const values = [
    recordId,
    spaceId,
    parent.record_id,
    Number(item.n),
    String(item.status),
    String(item.definition),
    String(item.author),
    String(item.reason),
    String(item.createdAt),
    item.promotedAt == null ? null : String(item.promotedAt),
    item.retiredAt == null ? null : String(item.retiredAt),
  ]
  if (found) {
    if (!byRecordId)
      deleteReplacedVersionEvents(local, n, spaceId, parent.record_id, Number(item.n))
    local
      .query(
        `UPDATE ${n.version} SET record_id=?,space_id=?,${n.foreign}=?,n=?,status=?,definition=?,author=?,reason=?,created_at=?,promoted_at=?,retired_at=? WHERE record_id=?`,
      )
      .run(...values, found.record_id)
  } else
    local
      .query(
        `INSERT INTO ${n.version} (record_id,space_id,${n.foreign},n,status,definition,author,reason,created_at,promoted_at,retired_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(...values)
}

function deleteReplacedVersionEvents(
  local: Database,
  n: Names,
  spaceId: string,
  parentId: string,
  version: number,
): void {
  if (n.event === 'workflow_event')
    local
      .query(
        'DELETE FROM workflow_event WHERE space_id=? AND workflow_version_record_id IN (SELECT record_id FROM workflow_version WHERE workflow_record_id=? AND n=?)',
      )
      .run(spaceId, parentId, version)
  else
    local
      .query(
        'DELETE FROM step_catalogue_event WHERE space_id=? AND catalogue_version_record_id IN (SELECT record_id FROM step_catalogue_version WHERE catalogue_record_id=? AND n=?)',
      )
      .run(spaceId, parentId, version)
}

function applyEvent(
  local: Database,
  n: Names,
  item: Record<string, unknown>,
  recordId: string,
  spaceId: string,
): void {
  const version = local
    .query<Record<string, unknown>, [string, string]>(
      `SELECT * FROM ${n.version} WHERE record_id=? AND space_id=?`,
    )
    .get(String(item.ownerVersionId), spaceId)!
  const found = local
    .query<{ record_id: string }, [string, string]>(
      `SELECT record_id FROM ${n.event} WHERE record_id=? AND space_id=?`,
    )
    .get(recordId, spaceId)
  const values = [
    recordId,
    spaceId,
    String(version.record_id),
    Number(version.n),
    String(item.event),
    String(item.author),
    String(item.reason),
    item.sessionId == null ? null : String(item.sessionId),
    String(item.at),
  ]
  if (found)
    local
      .query(
        `UPDATE ${n.event} SET record_id=?,space_id=?,${n.eventForeign}=?,version_n=?,event=?,author=?,reason=?,session_id=?,at=? WHERE record_id=?`,
      )
      .run(...values, found.record_id)
  else
    local
      .query(
        `INSERT INTO ${n.event} (record_id,space_id,${n.eventForeign},version_n,event,author,reason,session_id,at) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(...values)
}

export async function applyWorkflowWriteResponse(
  local: Database,
  kind: RecordWorkflowKind,
  response: RecordWorkflowWriteResponse,
): Promise<void> {
  const prefix = kind === 'workflow' ? 'workflow' : 'step_catalogue'
  let reconciled = false
  writeTransaction(() => {
    reconciled = applyWorkflowCatalogueRowWithResult(local, prefix, response.identity)
    for (const version of response.versions)
      applyWorkflowCatalogueRow(local, `${prefix}_version`, version)
    for (const event of response.events) applyWorkflowCatalogueRow(local, `${prefix}_event`, event)
  }, local)
  if (reconciled) await pullWorkflowCatalogue(local, [String(response.identity.spaceId)])
}
