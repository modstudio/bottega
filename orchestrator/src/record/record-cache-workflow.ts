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
): Promise<number> {
  let count = 0
  for (const spaceId of spaces)
    for (const table of RECORD_WORKFLOW_TABLES) count += await pullTable(local, spaceId, table)
  return count
}

async function pullTable(local: Database, spaceId: string, table: RecordWorkflowTable) {
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
    if (!page.items.length) break
    if (page.items.some((item) => !parentPresent(local, table, item))) break
    writeTransaction(() => {
      for (const item of page.items) {
        applyWorkflowCatalogueRow(local, table, item)
        count++
      }
      const last = page.items.at(-1)!
      current = page.endCursor
        ? decodeRecordCursor(page.endCursor)
        : { at: String(last[table.endsWith('_event') ? 'at' : 'updatedAt']), id: String(last.id) }
      remember(local, key, current)
    }, local)
    if (!page.nextCursor) break
    requestCursor = page.nextCursor
  }
  return count
}

function names(table: RecordWorkflowTable) {
  const workflow = table.startsWith('workflow')
  return {
    identity: workflow ? 'workflow' : 'step_catalogue',
    version: workflow ? 'workflow_version' : 'step_catalogue_version',
    event: workflow ? 'workflow_event' : 'step_catalogue_event',
    foreign: workflow ? 'workflow_id' : 'catalogue_id',
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
        .query(`SELECT id FROM ${n.identity} WHERE record_id=? AND space_id=?`)
        .get(String(item.ownerId), spaceId),
    )
  if (table.endsWith('_event'))
    return Boolean(
      local
        .query(`SELECT id FROM ${n.version} WHERE record_id=? AND space_id=?`)
        .get(String(item.ownerVersionId), spaceId),
    )
  return true
}

export function applyWorkflowCatalogueRow(
  local: Database,
  table: RecordWorkflowTable,
  item: Record<string, unknown>,
): void {
  const n = names(table),
    recordId = String(item.id),
    spaceId = String(item.spaceId)
  if (table === n.identity) applyIdentity(local, n, item, recordId, spaceId)
  else if (table === n.version) applyVersion(local, n, item, recordId, spaceId)
  else applyEvent(local, n, item, recordId, spaceId)
}

type Names = ReturnType<typeof names>
function applyIdentity(
  local: Database,
  n: Names,
  item: Record<string, unknown>,
  recordId: string,
  spaceId: string,
): void {
  const found =
    local
      .query<{ id: number }, [string, string]>(
        `SELECT id FROM ${n.identity} WHERE record_id=? AND space_id=?`,
      )
      .get(recordId, spaceId) ??
    local
      .query<{ id: number }, [string, string]>(
        `SELECT id FROM ${n.identity} WHERE space_id=? AND slug=?`,
      )
      .get(spaceId, String(item.slug))
  if (found)
    local
      .query(`UPDATE ${n.identity} SET record_id=?,slug=?,created_at=? WHERE id=?`)
      .run(recordId, String(item.slug), String(item.createdAt), found.id)
  else
    local
      .query(`INSERT INTO ${n.identity} (record_id,space_id,slug,created_at) VALUES (?,?,?,?)`)
      .run(recordId, spaceId, String(item.slug), String(item.createdAt))
}

function applyVersion(
  local: Database,
  n: Names,
  item: Record<string, unknown>,
  recordId: string,
  spaceId: string,
): void {
  const parent = local
    .query<{ id: number }, [string, string]>(
      `SELECT id FROM ${n.identity} WHERE record_id=? AND space_id=?`,
    )
    .get(String(item.ownerId), spaceId)!
  const found =
    local
      .query<{ id: number }, [string, string]>(
        `SELECT id FROM ${n.version} WHERE record_id=? AND space_id=?`,
      )
      .get(recordId, spaceId) ??
    local
      .query<{ id: number }, [number, number]>(
        `SELECT id FROM ${n.version} WHERE ${n.foreign}=? AND n=?`,
      )
      .get(parent.id, Number(item.n))
  const values = [
    recordId,
    spaceId,
    parent.id,
    Number(item.n),
    String(item.status),
    String(item.definition),
    String(item.author),
    String(item.reason),
    String(item.createdAt),
    item.promotedAt == null ? null : String(item.promotedAt),
    item.retiredAt == null ? null : String(item.retiredAt),
  ]
  if (found)
    local
      .query(
        `UPDATE ${n.version} SET record_id=?,space_id=?,${n.foreign}=?,n=?,status=?,definition=?,author=?,reason=?,created_at=?,promoted_at=?,retired_at=? WHERE id=?`,
      )
      .run(...values, found.id)
  else
    local
      .query(
        `INSERT INTO ${n.version} (record_id,space_id,${n.foreign},n,status,definition,author,reason,created_at,promoted_at,retired_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(...values)
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
    .query<{ id: number }, [string, string]>(
      `SELECT id FROM ${n.event} WHERE record_id=? AND space_id=?`,
    )
    .get(recordId, spaceId)
  const values = [
    recordId,
    spaceId,
    Number(version[n.foreign]),
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
        `UPDATE ${n.event} SET record_id=?,space_id=?,${n.foreign}=?,version_n=?,event=?,author=?,reason=?,session_id=?,at=? WHERE id=?`,
      )
      .run(...values, found.id)
  else
    local
      .query(
        `INSERT INTO ${n.event} (record_id,space_id,${n.foreign},version_n,event,author,reason,session_id,at) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(...values)
}

export function applyWorkflowWriteResponse(
  local: Database,
  kind: RecordWorkflowKind,
  response: RecordWorkflowWriteResponse,
): void {
  const prefix = kind === 'workflow' ? 'workflow' : 'step_catalogue'
  writeTransaction(() => {
    applyWorkflowCatalogueRow(local, prefix, response.identity)
    for (const version of response.versions)
      applyWorkflowCatalogueRow(local, `${prefix}_version`, version)
    for (const event of response.events) applyWorkflowCatalogueRow(local, `${prefix}_event`, event)
  }, local)
}
