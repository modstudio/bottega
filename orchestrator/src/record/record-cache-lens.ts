// concern: record-cache-lens
/** Pulls and reconciles the six hosted lens catalogue streams. */
import type { Database } from 'bun:sqlite'
import { writeTransaction } from '../database/db.ts'
import { recordApiClient } from './record-api-client.ts'
import {
  decodeRecordCursor,
  encodeRecordCursor,
  parseStoredRecordCursor,
  type RecordCursor,
} from './record-cursor.ts'
import { RECORD_LENS_TABLES, type RecordLensTable } from './record-lens-contract.ts'

const LENS_CURSOR = 'record_lens_cursor'
const PROJECT_LENS_SPACES = 'record_project_lens_spaces'
function readCursor(local: Database, key: string): string | undefined {
  return local
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(key)?.value
}
function writeCursor(local: Database, key: string, value: string): void {
  local
    .query(
      'INSERT INTO schema_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, value)
}
function readRecordCursor(local: Database, key: string): RecordCursor | undefined {
  const value = readCursor(local, key)
  if (value === undefined) return undefined
  const parsed = parseStoredRecordCursor(value, false)
  if ('cursor' in parsed) return parsed.cursor
  throw new Error(`invalid record cache cursor for ${key}`)
}
function writeRecordCursor(local: Database, key: string, cursor: RecordCursor): void {
  writeCursor(local, key, JSON.stringify(cursor))
}

export function rememberProjectLensSpaces(
  local: Database,
  spaces: ReadonlyMap<string, string | null>,
): void {
  writeCursor(local, PROJECT_LENS_SPACES, JSON.stringify(Object.fromEntries(spaces)))
}

export function rememberProjectLensSpace(
  local: Database,
  project: string,
  spaceId: string | null,
): void {
  let spaces: Record<string, string | null> = {}
  const stored = readCursor(local, PROJECT_LENS_SPACES)
  try {
    if (stored) spaces = JSON.parse(stored) as Record<string, string | null>
  } catch {
    spaces = {}
  }
  spaces[project] = spaceId
  writeCursor(local, PROJECT_LENS_SPACES, JSON.stringify(spaces))
}

export function effectiveProjectLensSpace(local: Database, project: string | null): string | null {
  if (!project) return null
  const stored = readCursor(local, PROJECT_LENS_SPACES)
  if (!stored) return null
  try {
    const spaces = JSON.parse(stored) as Record<string, unknown>
    return typeof spaces[project] === 'string' ? spaces[project] : null
  } catch {
    return null
  }
}

export async function pullLensCatalogue(
  local: Database,
  spaces: readonly string[],
): Promise<number> {
  let count = 0
  for (const spaceId of spaces)
    for (const table of RECORD_LENS_TABLES) count += await pullLensTable(local, spaceId, table)
  return count
}

async function pullLensTable(local: Database, spaceId: string, table: RecordLensTable) {
  const cursorKey = `${LENS_CURSOR}:${spaceId}:${table}`
  let cursor = readRecordCursor(local, cursorKey)
  let requestCursor = cursor ? encodeRecordCursor(cursor) : undefined
  let count = 0
  for (;;) {
    const page = await recordApiClient().listLensCatalogue(
      table,
      { limit: 100, cursor: requestCursor },
      { destinationSpaceId: spaceId },
    )
    if (!page.items.length) break
    writeTransaction(() => {
      for (const item of page.items) {
        applyLensCatalogueRow(local, table, item)
        count++
      }
      const last = page.items.at(-1)!
      cursor = page.endCursor
        ? decodeRecordCursor(page.endCursor)
        : {
            at: String(last[table.includes('revision') ? 'at' : 'updatedAt']),
            id: String(last.id),
          }
      if (cursor) writeRecordCursor(local, cursorKey, cursor)
    }, local)
    if (!page.nextCursor) break
    requestCursor = page.nextCursor
  }
  return count
}

/** Reconcile one hosted catalogue row by record id, then natural key. */
export function applyLensCatalogueRow(
  local: Database,
  table: RecordLensTable,
  item: Record<string, unknown>,
): void {
  lensRowApplicators[table](local, item)
}

const nullableText = (value: unknown) => (value == null ? null : String(value))
const nullableNumber = (value: unknown) => (value == null ? null : Number(value))

function applyLensRow(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const spaceId = String(item.spaceId)
  const key = String(item.key)
  const row =
    local
      .query<{ id: string; record_id: string }, [string]>(
        'SELECT id,record_id FROM lens WHERE record_id=?',
      )
      .get(recordId) ??
    local
      .query<{ id: string; record_id: string }, [string, string]>(
        'SELECT id,record_id FROM lens WHERE space_id=? AND id=?',
      )
      .get(spaceId, key) ??
    local
      .query<{ id: string; record_id: string }, [string]>(
        'SELECT id,record_id FROM lens WHERE space_id IS NULL AND id=?',
      )
      .get(key)
  const values = [
    recordId,
    String(item.title),
    String(item.question),
    String(item.excludes),
    String(item.slots),
    Number(item.version),
    item.enabled ? 1 : 0,
    item.requiresExecution ? 1 : 0,
  ]
  if (row)
    local
      .query(
        'UPDATE lens SET record_id=?,space_id=?,title=?,question=?,excludes=?,slots=?,version=?,enabled=?,requires_execution=? WHERE record_id=?',
      )
      .run(recordId, spaceId, ...values.slice(1), row.record_id)
  else
    local
      .query(
        'INSERT INTO lens (record_id,space_id,id,title,question,excludes,slots,version,enabled,requires_execution) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(recordId, spaceId, key, ...values.slice(1))
}

function applyLensRevisionRow(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const spaceId = String(item.spaceId)
  const parent = local
    .query<{ id: string }, [string, string]>('SELECT id FROM lens WHERE record_id=? AND space_id=?')
    .get(String(item.lensId), spaceId)
  if (!parent) throw new Error(`record cache could not resolve lens parent ${String(item.lensId)}`)
  const found =
    local
      .query<{ id: number }, [string]>('SELECT id FROM lens_revision WHERE record_id=?')
      .get(recordId) ??
    local
      .query<{ id: number }, [string, string, number]>(
        'SELECT id FROM lens_revision WHERE space_id=? AND lens_id=? AND version=?',
      )
      .get(spaceId, parent.id, Number(item.version))
  if (found)
    local
      .query(
        'UPDATE lens_revision SET record_id=?,space_id=?,prior_body=?,reason=?,session_id=?,at=? WHERE id=?',
      )
      .run(
        recordId,
        spaceId,
        String(item.priorBody),
        String(item.reason),
        nullableText(item.sessionId),
        String(item.at),
        found.id,
      )
  else
    local
      .query(
        'INSERT INTO lens_revision (record_id,space_id,lens_id,version,prior_body,reason,session_id,at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        recordId,
        spaceId,
        parent.id,
        Number(item.version),
        String(item.priorBody),
        String(item.reason),
        nullableText(item.sessionId),
        String(item.at),
      )
}

function applyLensProfileRow(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const spaceId = String(item.spaceId)
  const lens = local
    .query<{ id: string }, [string, string]>('SELECT id FROM lens WHERE record_id=? AND space_id=?')
    .get(String(item.lensId), spaceId)
  if (!lens) throw new Error(`record cache could not resolve lens parent ${String(item.lensId)}`)
  const found =
    local
      .query<{ id: number }, [string]>('SELECT id FROM lens_profile WHERE record_id=?')
      .get(recordId) ??
    local
      .query<{ id: number }, [string, string, string, string]>(
        'SELECT id FROM lens_profile WHERE space_id=? AND lens_id=? AND axis=? AND name=?',
      )
      .get(spaceId, lens.id, String(item.axis), String(item.name)) ??
    local
      .query<{ id: number }, [string, string, string]>(
        'SELECT id FROM lens_profile WHERE space_id IS NULL AND lens_id=? AND axis=? AND name=?',
      )
      .get(lens.id, String(item.axis), String(item.name))
  if (found)
    local
      .query(
        'UPDATE lens_profile SET record_id=?,space_id=?,lens_id=?,version=?,body=?,enabled=? WHERE id=?',
      )
      .run(
        recordId,
        spaceId,
        lens.id,
        Number(item.version),
        String(item.body),
        item.enabled ? 1 : 0,
        found.id,
      )
  else
    local
      .query(
        'INSERT INTO lens_profile (record_id,space_id,lens_id,axis,name,version,body,enabled) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        recordId,
        spaceId,
        lens.id,
        String(item.axis),
        String(item.name),
        Number(item.version),
        String(item.body),
        item.enabled ? 1 : 0,
      )
}

function applyLensProfileRevisionRow(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const spaceId = String(item.spaceId)
  const parent = local
    .query<{ id: number }, [string, string]>(
      'SELECT id FROM lens_profile WHERE record_id=? AND space_id=?',
    )
    .get(String(item.profileId), spaceId)
  if (!parent)
    throw new Error(`record cache could not resolve lens profile parent ${String(item.profileId)}`)
  const found =
    local
      .query<{ id: number }, [string]>('SELECT id FROM lens_profile_revision WHERE record_id=?')
      .get(recordId) ??
    local
      .query<{ id: number }, [string, number, number]>(
        'SELECT id FROM lens_profile_revision WHERE space_id=? AND profile_id=? AND version=?',
      )
      .get(spaceId, parent.id, Number(item.version))
  if (found)
    local
      .query(
        'UPDATE lens_profile_revision SET record_id=?,space_id=?,prior_body=?,reason=?,session_id=?,at=? WHERE id=?',
      )
      .run(
        recordId,
        spaceId,
        String(item.priorBody),
        String(item.reason),
        nullableText(item.sessionId),
        String(item.at),
        found.id,
      )
  else
    local
      .query(
        'INSERT INTO lens_profile_revision (record_id,space_id,profile_id,version,prior_body,reason,session_id,at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        recordId,
        spaceId,
        parent.id,
        Number(item.version),
        String(item.priorBody),
        String(item.reason),
        nullableText(item.sessionId),
        String(item.at),
      )
}

function applyProjectLensProfileRow(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const spaceId = String(item.spaceId)
  const project = local
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE record_id=?')
    .get(String(item.projectId))
  if (!project)
    throw new Error(`record cache could not resolve project parent ${String(item.projectId)}`)
  const lens =
    item.lensId == null
      ? null
      : local
          .query<{ id: string }, [string, string]>(
            'SELECT id FROM lens WHERE record_id=? AND space_id=?',
          )
          .get(String(item.lensId), spaceId)
  if (item.lensId != null && !lens)
    throw new Error(`record cache could not resolve lens parent ${String(item.lensId)}`)
  const found =
    local
      .query<{ id: number }, [string]>('SELECT id FROM project_lens_profile WHERE record_id=?')
      .get(recordId) ??
    local
      .query<{ id: number }, [string, string, string | null, string]>(
        'SELECT id FROM project_lens_profile WHERE space_id=? AND project_record_id=? AND lens_id IS ? AND axis=?',
      )
      .get(spaceId, project.record_id, lens?.id ?? null, String(item.axis))
  if (found)
    local
      .query(
        'UPDATE project_lens_profile SET record_id=?,space_id=?,profile_name=?,selected_version=?,selection_version=? WHERE id=?',
      )
      .run(
        recordId,
        spaceId,
        String(item.profileName),
        nullableNumber(item.selectedVersion),
        Number(item.selectionVersion),
        found.id,
      )
  else
    local
      .query(
        'INSERT INTO project_lens_profile (record_id,space_id,project_record_id,lens_id,axis,profile_name,selected_version,selection_version) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        recordId,
        spaceId,
        project.record_id,
        lens?.id ?? null,
        String(item.axis),
        String(item.profileName),
        nullableNumber(item.selectedVersion),
        Number(item.selectionVersion),
      )
}

function applyProjectLensProfileRevisionRow(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const spaceId = String(item.spaceId)
  const parent = local
    .query<{ id: number }, [string, string]>(
      'SELECT id FROM project_lens_profile WHERE record_id=? AND space_id=?',
    )
    .get(String(item.selectionId), spaceId)
  if (!parent)
    throw new Error(
      `record cache could not resolve project lens selection parent ${String(item.selectionId)}`,
    )
  const found = local
    .query<{ id: number }, [string]>(
      'SELECT id FROM project_lens_profile_revision WHERE record_id=?',
    )
    .get(recordId)
  if (found)
    local
      .query(
        'UPDATE project_lens_profile_revision SET space_id=?,prior_profile_name=?,prior_selected_version=?,reason=?,session_id=?,at=? WHERE id=?',
      )
      .run(
        spaceId,
        nullableText(item.priorProfileName),
        nullableNumber(item.priorSelectedVersion),
        String(item.reason),
        nullableText(item.sessionId),
        String(item.at),
        found.id,
      )
  else
    local
      .query(
        'INSERT INTO project_lens_profile_revision (record_id,space_id,selection_id,prior_profile_name,prior_selected_version,reason,session_id,at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        recordId,
        spaceId,
        parent.id,
        nullableText(item.priorProfileName),
        nullableNumber(item.priorSelectedVersion),
        String(item.reason),
        nullableText(item.sessionId),
        String(item.at),
      )
}

const lensRowApplicators: Record<
  RecordLensTable,
  (local: Database, item: Record<string, unknown>) => void
> = {
  lens: applyLensRow,
  lens_revision: applyLensRevisionRow,
  lens_profile: applyLensProfileRow,
  lens_profile_revision: applyLensProfileRevisionRow,
  project_lens_profile: applyProjectLensProfileRow,
  project_lens_profile_revision: applyProjectLensProfileRevisionRow,
}
