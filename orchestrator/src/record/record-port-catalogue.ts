// concern: record-port-catalogue
/** Owns tenant-bound hosted port item reads and compare-and-set writes. */
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import {
  type RecordCursor,
  type RecordListCursorRow,
  recordCursorAt,
} from './record-cursor.ts'
import {
  RECORD_PORT_CURSORS,
  RecordPortError,
  type RecordPortRow,
  type RecordPortRowByTable,
  type RecordPortTable,
  type RecordPortWriteInput,
  type RecordPortWriteResponse,
} from './record-port-contract.ts'

type Tenant = { url: string } & TenantPrincipal
const text = (value: unknown) => String(value)
const number = (value: unknown) => Number(value)
const nullable = (value: unknown) => (value == null ? null : String(value))
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))

async function tenant<T>(input: Tenant, use: (tx: SQL) => Promise<T>): Promise<T> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      return use(tx)
    })
  } finally {
    await client.close()
  }
}

function mapped(
  table: 'port_doctrine',
  row: Record<string, unknown>,
): RecordPortRowByTable['port_doctrine']
function mapped(table: 'port_pair', row: Record<string, unknown>): RecordPortRowByTable['port_pair']
function mapped(
  table: 'port_baseline',
  row: Record<string, unknown>,
): RecordPortRowByTable['port_baseline']
function mapped(table: 'port_ref', row: Record<string, unknown>): RecordPortRowByTable['port_ref']
function mapped(
  table: 'port_ref_source',
  row: Record<string, unknown>,
): RecordPortRowByTable['port_ref_source']
function mapped(table: 'port_skip', row: Record<string, unknown>): RecordPortRowByTable['port_skip']
function mapped(table: RecordPortTable, row: Record<string, unknown>): RecordPortRow
function mapped(table: RecordPortTable, row: Record<string, unknown>): RecordPortRow {
  const common = { id: text(row.id), spaceId: text(row.space_id) }
  switch (table) {
    case 'port_doctrine':
      return {
        ...common,
        number: number(row.number),
        title: text(row.title),
        body: text(row.body),
        createdAt: iso(row.created_at),
        retiredAt: nullable(row.retired_at),
        version: number(row.version),
        updatedAt: iso(row.updated_at),
      }
    case 'port_pair':
      return {
        ...common,
        sourceProjectId: text(row.source_project_id),
        targetProjectId: text(row.target_project_id),
        createdAt: iso(row.created_at),
      }
    case 'port_baseline':
      return {
        ...common,
        pairId: text(row.pair_id),
        sourceCommit: nullable(row.source_commit),
        scannedAt: nullable(row.scanned_at),
        version: number(row.version),
        updatedAt: iso(row.updated_at),
      }
    case 'port_ref':
      return {
        ...common,
        taskKey: text(row.task_key),
        targetProjectId: text(row.target_project_id),
        note: text(row.note),
        createdAt: iso(row.created_at),
        resolvedAt: nullable(row.resolved_at),
        deletedAt: nullable(row.deleted_at),
        version: number(row.version),
        updatedAt: iso(row.updated_at),
      }
    case 'port_ref_source':
      return {
        ...common,
        refId: text(row.ref_id),
        sourceProjectId: text(row.source_project_id),
        commits: text(row.commits),
        paths: text(row.paths),
        note: text(row.note),
        deletedAt: nullable(row.deleted_at),
        updatedAt: iso(row.updated_at),
      }
    case 'port_skip':
      return {
        ...common,
        pairId: text(row.pair_id),
        candidate: text(row.candidate),
        reason: text(row.reason),
        skippedAt: iso(row.skipped_at),
      }
  }
}

export async function listRecordPortCatalogue(
  input: Tenant & { table: RecordPortTable; limit: number; cursor: RecordCursor | null },
): Promise<(RecordPortRow & RecordListCursorRow)[]> {
  return tenant(input, async (tx) => {
    const at = input.cursor?.at ?? null
    const id = input.cursor?.id ?? null
    const column = RECORD_PORT_CURSORS[input.table].column
    const rows = await tx.unsafe(
      `SELECT *,to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM ${input.table} WHERE space_id=$1::uuid AND ($2::timestamptz IS NULL OR (${column},id)>($2::timestamptz,$3::uuid)) ORDER BY ${column},id LIMIT $4`,
      [input.spaceId, at, id, input.limit + 1],
    )
    return (rows as Record<string, unknown>[]).map((row) => ({
      ...mapped(input.table, row),
      [recordCursorAt]: text(row.cursor_at),
    }))
  })
}

function stale(action: string, expected: number | null, actual: number | null): never {
  throw new RecordPortError(
    `refusing stale hosted ${action}: expected version ${expected ?? 'none'}, current version ${actual ?? 'none'}`,
  )
}
function unique(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
    throw new RecordPortError('hosted port items changed concurrently; refresh and retry')
  throw error
}
async function lockSpace(tx: SQL, spaceId: string) {
  await tx`SELECT id FROM space WHERE id=${spaceId}::uuid FOR UPDATE`
}

async function writeDoctrine(
  tx: SQL,
  input: Tenant & Extract<RecordPortWriteInput, { action: 'add_doctrine' | 'retire_doctrine' }>,
): Promise<RecordPortWriteResponse> {
  if (input.action === 'add_doctrine') {
    await lockSpace(tx, input.spaceId)
    const id = newRecordId()
    const rows =
      await tx`INSERT INTO port_doctrine (id,space_id,number,title,body,created_at,version,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${input.number},${input.title},${input.body},${input.createdAt}::timestamptz,1,${input.createdAt}::timestamptz) RETURNING *`
    return { doctrine: mapped('port_doctrine', rows[0]!) }
  }
  const rows =
    await tx`SELECT * FROM port_doctrine WHERE space_id=${input.spaceId}::uuid AND number=${input.number} FOR UPDATE`
  if (!rows[0]) throw new RecordPortError(`unknown hosted doctrine ${input.number}`, 404)
  if (number(rows[0].version) !== input.expectedVersion)
    stale('doctrine retire', input.expectedVersion, number(rows[0].version))
  const changed =
    await tx`UPDATE port_doctrine SET retired_at=${input.retiredAt}::timestamptz,version=version+1,updated_at=${input.retiredAt}::timestamptz WHERE id=${text(rows[0].id)}::uuid RETURNING *`
  return { doctrine: mapped('port_doctrine', changed[0]!) }
}

async function pair(
  tx: SQL,
  input: Tenant & { sourceProjectId: string; targetProjectId: string },
  create: boolean,
) {
  let rows =
    await tx`SELECT * FROM port_pair WHERE space_id=${input.spaceId}::uuid AND source_project_id=${input.sourceProjectId}::uuid AND target_project_id=${input.targetProjectId}::uuid FOR UPDATE`
  if (!rows[0] && create) {
    await lockSpace(tx, input.spaceId)
    const id = newRecordId()
    const now = new Date().toISOString()
    rows =
      await tx`INSERT INTO port_pair (id,space_id,source_project_id,target_project_id,created_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${input.sourceProjectId}::uuid,${input.targetProjectId}::uuid,${now}::timestamptz) RETURNING *`
  }
  if (!rows[0]) throw new RecordPortError('unknown hosted port pair', 404)
  return rows[0]!
}

async function writeBaseline(
  tx: SQL,
  input: Tenant & Extract<RecordPortWriteInput, { action: 'set_baseline' }>,
): Promise<RecordPortWriteResponse> {
  const pairRow = await pair(tx, input, true)
  let rows =
    await tx`SELECT * FROM port_baseline WHERE space_id=${input.spaceId}::uuid AND pair_id=${text(pairRow.id)}::uuid FOR UPDATE`
  const now = new Date().toISOString()
  if (!rows[0]) {
    if (input.expectedVersion !== null) stale('baseline set', input.expectedVersion, null)
    const id = newRecordId()
    rows =
      await tx`INSERT INTO port_baseline (id,space_id,pair_id,source_commit,scanned_at,version,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${text(pairRow.id)}::uuid,${input.sourceCommit},${input.scannedAt}::timestamptz,1,${now}::timestamptz) RETURNING *`
  } else {
    if (number(rows[0].version) !== input.expectedVersion)
      stale('baseline set', input.expectedVersion, number(rows[0].version))
    rows =
      await tx`UPDATE port_baseline SET source_commit=${input.sourceCommit},scanned_at=${input.scannedAt}::timestamptz,version=version+1,updated_at=${now}::timestamptz WHERE id=${text(rows[0].id)}::uuid RETURNING *`
  }
  return {
    pair: mapped('port_pair', pairRow),
    baseline: mapped('port_baseline', rows[0]!),
  }
}

async function writeSkip(
  tx: SQL,
  input: Tenant & Extract<RecordPortWriteInput, { action: 'add_skip' }>,
): Promise<RecordPortWriteResponse> {
  const pairRow = await pair(tx, input, false)
  const id = newRecordId()
  const rows =
    await tx`INSERT INTO port_skip (id,space_id,pair_id,candidate,reason,skipped_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${text(pairRow.id)}::uuid,${input.candidate},${input.reason},${input.skippedAt}::timestamptz) RETURNING *`
  return { skip: mapped('port_skip', rows[0]!) }
}

async function writeRefSet(
  tx: SQL,
  input: Tenant & Extract<RecordPortWriteInput, { action: 'set_ref' }>,
): Promise<RecordPortWriteResponse> {
  await lockSpace(tx, input.spaceId)
  let refs =
    await tx`SELECT * FROM port_ref WHERE space_id=${input.spaceId}::uuid AND target_project_id=${input.targetProjectId}::uuid AND task_key=${input.taskKey} FOR UPDATE`
  const now = new Date().toISOString()
  if (!refs[0]) {
    if (input.expectedVersion !== null) stale('ref set', input.expectedVersion, null)
    const id = newRecordId()
    refs =
      await tx`INSERT INTO port_ref (id,space_id,task_key,target_project_id,note,created_at,version,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${input.taskKey},${input.targetProjectId}::uuid,${input.note},${input.createdAt}::timestamptz,1,${now}::timestamptz) RETURNING *`
  } else {
    const deleted = refs[0].deleted_at != null
    if (
      (!deleted || input.expectedVersion !== null) &&
      number(refs[0].version) !== input.expectedVersion
    )
      stale('ref set', input.expectedVersion, number(refs[0].version))
    refs =
      await tx`UPDATE port_ref SET note=${input.note},resolved_at=NULL,deleted_at=NULL,version=version+1,updated_at=${now}::timestamptz WHERE id=${text(refs[0].id)}::uuid RETURNING *`
  }
  const ref = refs[0]!
  const prior =
    (await tx`SELECT * FROM port_ref_source WHERE space_id=${input.spaceId}::uuid AND ref_id=${text(ref.id)}::uuid FOR UPDATE`) as Record<
      string,
      unknown
    >[]
  const wanted = new Set(input.sources.map((source) => source.sourceProjectId))
  const changed: Record<string, unknown>[] = []
  for (const row of prior) {
    if (!wanted.has(text(row.source_project_id)) && row.deleted_at == null) {
      const tombstone =
        await tx`UPDATE port_ref_source SET deleted_at=${now}::timestamptz,updated_at=${now}::timestamptz WHERE id=${text(row.id)}::uuid RETURNING *`
      changed.push(tombstone[0]!)
    }
  }
  for (const source of input.sources) {
    const existing = prior.find((row) => text(row.source_project_id) === source.sourceProjectId)
    if (existing) {
      const rows =
        await tx`UPDATE port_ref_source SET commits=${JSON.stringify(source.commits)},paths=${JSON.stringify(source.paths)},note=${source.note},deleted_at=NULL,updated_at=${now}::timestamptz WHERE id=${text(existing.id)}::uuid RETURNING *`
      changed.push(rows[0]!)
    } else {
      const id = newRecordId()
      const rows =
        await tx`INSERT INTO port_ref_source (id,space_id,ref_id,source_project_id,commits,paths,note,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${text(ref.id)}::uuid,${source.sourceProjectId}::uuid,${JSON.stringify(source.commits)},${JSON.stringify(source.paths)},${source.note},${now}::timestamptz) RETURNING *`
      changed.push(rows[0]!)
    }
  }
  return {
    ref: mapped('port_ref', ref),
    sources: changed.map((row) => mapped('port_ref_source', row)),
  }
}

async function writeRefTransition(
  tx: SQL,
  input: Tenant & Extract<RecordPortWriteInput, { action: 'resolve_ref' | 'delete_ref' }>,
): Promise<RecordPortWriteResponse> {
  const refs =
    await tx`SELECT * FROM port_ref WHERE space_id=${input.spaceId}::uuid AND target_project_id=${input.targetProjectId}::uuid AND task_key=${input.taskKey} FOR UPDATE`
  if (!refs[0] || refs[0].deleted_at != null)
    throw new RecordPortError('unknown hosted port ref', 404)
  if (number(refs[0].version) !== input.expectedVersion)
    stale(
      `ref ${input.action === 'resolve_ref' ? 'resolve' : 'delete'}`,
      input.expectedVersion,
      number(refs[0].version),
    )
  const changed =
    input.action === 'resolve_ref'
      ? await tx`UPDATE port_ref SET resolved_at=${input.at}::timestamptz,version=version+1,updated_at=${input.at}::timestamptz WHERE id=${text(refs[0].id)}::uuid RETURNING *`
      : await tx`UPDATE port_ref SET deleted_at=${input.at}::timestamptz,version=version+1,updated_at=${input.at}::timestamptz WHERE id=${text(refs[0].id)}::uuid RETURNING *`
  if (input.action === 'resolve_ref') return { ref: mapped('port_ref', changed[0]!) }
  const sources =
    (await tx`UPDATE port_ref_source SET deleted_at=${input.at}::timestamptz,updated_at=${input.at}::timestamptz WHERE space_id=${input.spaceId}::uuid AND ref_id=${text(refs[0].id)}::uuid AND deleted_at IS NULL RETURNING *`) as Record<
      string,
      unknown
    >[]
  return {
    ref: mapped('port_ref', changed[0]!),
    sources: sources.map((row) => mapped('port_ref_source', row)),
  }
}

export async function writeRecordPort(input: Tenant & RecordPortWriteInput) {
  try {
    return await tenant(input, async (tx) => {
      switch (input.action) {
        case 'add_doctrine':
        case 'retire_doctrine':
          return writeDoctrine(tx, input)
        case 'set_baseline':
          return writeBaseline(tx, input)
        case 'add_skip':
          return writeSkip(tx, input)
        case 'set_ref':
          return writeRefSet(tx, input)
        case 'resolve_ref':
        case 'delete_ref':
          return writeRefTransition(tx, input)
      }
    })
  } catch (error) {
    return unique(error)
  }
}
