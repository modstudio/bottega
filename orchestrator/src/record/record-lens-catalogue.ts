// concern: record-lens-catalogue
/** Owns tenant-bound hosted lens catalogue reads and writes. */
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import type { RecordCursor } from './record-cursor.ts'

export const RECORD_LENS_TABLES = [
  'lens',
  'lens_revision',
  'lens_profile',
  'lens_profile_revision',
  'project_lens_profile',
  'project_lens_profile_revision',
] as const
export type RecordLensTable = (typeof RECORD_LENS_TABLES)[number]
type Tenant = { url: string } & TenantPrincipal

export class RecordLensError extends Error {
  readonly status: number
  constructor(message: string, status = 409) {
    super(message)
    this.status = status
  }
}

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

const text = (value: unknown) => String(value)
const nullable = (value: unknown) => (value == null ? null : String(value))
const number = (value: unknown) => Number(value)
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))

function mapped(table: RecordLensTable, row: Record<string, unknown>): Record<string, unknown> {
  const common = { id: text(row.id), spaceId: text(row.space_id) }
  switch (table) {
    case 'lens':
      return {
        ...common,
        key: text(row.key),
        title: text(row.title),
        question: text(row.question),
        excludes: text(row.excludes),
        slots: text(row.slots),
        version: number(row.version),
        enabled: Boolean(row.enabled),
        requiresExecution: Boolean(row.requires_execution),
        updatedAt: iso(row.updated_at),
      }
    case 'lens_revision':
      return {
        ...common,
        lensId: text(row.lens_id),
        version: number(row.version),
        priorBody: text(row.prior_body),
        reason: text(row.reason),
        sessionId: nullable(row.session_id),
        at: iso(row.at),
      }
    case 'lens_profile':
      return {
        ...common,
        lensId: text(row.lens_id),
        axis: text(row.axis),
        name: text(row.name),
        version: number(row.version),
        body: text(row.body),
        enabled: Boolean(row.enabled),
        updatedAt: iso(row.updated_at),
      }
    case 'lens_profile_revision':
      return {
        ...common,
        profileId: text(row.profile_id),
        version: number(row.version),
        priorBody: text(row.prior_body),
        reason: text(row.reason),
        sessionId: nullable(row.session_id),
        at: iso(row.at),
      }
    case 'project_lens_profile':
      return {
        ...common,
        projectId: text(row.project_id),
        lensId: nullable(row.lens_id),
        axis: text(row.axis),
        profileName: text(row.profile_name),
        selectedVersion: row.selected_version == null ? null : number(row.selected_version),
        selectionVersion: number(row.selection_version),
        updatedAt: iso(row.updated_at),
      }
    case 'project_lens_profile_revision':
      return {
        ...common,
        selectionId: text(row.selection_id),
        priorProfileName: nullable(row.prior_profile_name),
        priorSelectedVersion:
          row.prior_selected_version == null ? null : number(row.prior_selected_version),
        reason: text(row.reason),
        sessionId: nullable(row.session_id),
        at: iso(row.at),
      }
  }
}

export async function listRecordLensCatalogue(
  input: Tenant & { table: RecordLensTable; limit: number; cursor: RecordCursor | null },
): Promise<Record<string, unknown>[]> {
  return tenant(input, async (tx) => {
    const at = input.cursor?.at ?? null
    const id = input.cursor?.id ?? null
    let rows: Record<string, unknown>[]
    switch (input.table) {
      case 'lens':
        rows =
          await tx`SELECT * FROM lens WHERE space_id=${input.spaceId}::uuid AND (${at}::timestamptz IS NULL OR (updated_at,id)>(${at}::timestamptz,${id}::uuid)) ORDER BY updated_at,id LIMIT ${input.limit + 1}`
        break
      case 'lens_revision':
        rows =
          await tx`SELECT * FROM lens_revision WHERE space_id=${input.spaceId}::uuid AND (${at}::timestamptz IS NULL OR (at,id)>(${at}::timestamptz,${id}::uuid)) ORDER BY at,id LIMIT ${input.limit + 1}`
        break
      case 'lens_profile':
        rows =
          await tx`SELECT * FROM lens_profile WHERE space_id=${input.spaceId}::uuid AND (${at}::timestamptz IS NULL OR (updated_at,id)>(${at}::timestamptz,${id}::uuid)) ORDER BY updated_at,id LIMIT ${input.limit + 1}`
        break
      case 'lens_profile_revision':
        rows =
          await tx`SELECT * FROM lens_profile_revision WHERE space_id=${input.spaceId}::uuid AND (${at}::timestamptz IS NULL OR (at,id)>(${at}::timestamptz,${id}::uuid)) ORDER BY at,id LIMIT ${input.limit + 1}`
        break
      case 'project_lens_profile':
        rows =
          await tx`SELECT * FROM project_lens_profile WHERE space_id=${input.spaceId}::uuid AND (${at}::timestamptz IS NULL OR (updated_at,id)>(${at}::timestamptz,${id}::uuid)) ORDER BY updated_at,id LIMIT ${input.limit + 1}`
        break
      case 'project_lens_profile_revision':
        rows =
          await tx`SELECT * FROM project_lens_profile_revision WHERE space_id=${input.spaceId}::uuid AND (${at}::timestamptz IS NULL OR (at,id)>(${at}::timestamptz,${id}::uuid)) ORDER BY at,id LIMIT ${input.limit + 1}`
        break
    }
    return rows.map((row) => mapped(input.table, row))
  })
}

export const assertRecordLensVersion = (
  what: string,
  expected: number | null,
  current: number | null,
) => {
  if (expected !== current)
    throw new RecordLensError(
      `refusing stale ${what} update: expected version ${expected ?? 'none'}, current version ${current ?? 'none'}`,
    )
}

export type RecordLensWriteInput = {
  key: string
  title: string
  question: string
  excludes: string
  slots: string
  enabled: boolean
  requiresExecution: boolean
  expectedVersion: number | null
  reason: string
  sessionId?: string | null
}
export async function upsertRecordLens(input: Tenant & RecordLensWriteInput) {
  return tenant(input, async (tx) => {
    const rows =
      await tx`SELECT * FROM lens WHERE space_id=${input.spaceId}::uuid AND key=${input.key} FOR UPDATE`
    const prior = rows[0] as Record<string, unknown> | undefined
    assertRecordLensVersion('lens', input.expectedVersion, prior ? number(prior.version) : null)
    const now = new Date().toISOString()
    const id = prior ? text(prior.id) : newRecordId()
    let revision: Record<string, unknown> | null = null
    if (prior) {
      const revisionId = newRecordId()
      const priorBody = JSON.stringify({
        title: prior.title,
        question: prior.question,
        excludes: prior.excludes,
        slots: JSON.parse(text(prior.slots)),
        enabled: Boolean(prior.enabled),
        requires_execution: Boolean(prior.requires_execution),
      })
      await tx`INSERT INTO lens_revision (id,space_id,lens_id,version,prior_body,reason,session_id,at) VALUES (${revisionId}::uuid,${input.spaceId}::uuid,${id}::uuid,${number(prior.version)},${priorBody},${input.reason},${input.sessionId ?? null},${now}::timestamptz)`
      revision = mapped(
        'lens_revision',
        (await tx`SELECT * FROM lens_revision WHERE id=${revisionId}::uuid`)[0]!,
      )
      await tx`UPDATE lens SET title=${input.title},question=${input.question},excludes=${input.excludes},slots=${input.slots},version=version+1,enabled=${input.enabled},requires_execution=${input.requiresExecution},updated_at=${now}::timestamptz WHERE id=${id}::uuid`
    } else
      await tx`INSERT INTO lens (id,space_id,key,title,question,excludes,slots,version,enabled,requires_execution,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${input.key},${input.title},${input.question},${input.excludes},${input.slots},1,${input.enabled},${input.requiresExecution},${now}::timestamptz)`
    return {
      lens: mapped('lens', (await tx`SELECT * FROM lens WHERE id=${id}::uuid`)[0]!),
      revision,
    }
  })
}

export type RecordLensProfileWriteInput = {
  lensKey: string
  axis: 'framework' | 'architecture'
  name: string
  body: string
  enabled: boolean
  expectedVersion: number | null
  reason: string
  sessionId?: string | null
}
export async function upsertRecordLensProfile(input: Tenant & RecordLensProfileWriteInput) {
  return tenant(input, async (tx) => {
    const lensRows =
      await tx`SELECT id FROM lens WHERE space_id=${input.spaceId}::uuid AND key=${input.lensKey}`
    if (!lensRows[0]) throw new RecordLensError(`no hosted lens "${input.lensKey}"`, 404)
    const lensId = text(lensRows[0].id)
    const rows =
      await tx`SELECT * FROM lens_profile WHERE space_id=${input.spaceId}::uuid AND lens_id=${lensId}::uuid AND axis=${input.axis} AND name=${input.name} FOR UPDATE`
    const prior = rows[0] as Record<string, unknown> | undefined
    assertRecordLensVersion(
      'lens profile',
      input.expectedVersion,
      prior ? number(prior.version) : null,
    )
    const now = new Date().toISOString(),
      id = prior ? text(prior.id) : newRecordId()
    let revision: Record<string, unknown> | null = null
    if (prior) {
      const revisionId = newRecordId(),
        priorBody = JSON.stringify({
          body: JSON.parse(text(prior.body)),
          enabled: Boolean(prior.enabled),
        })
      await tx`INSERT INTO lens_profile_revision (id,space_id,profile_id,version,prior_body,reason,session_id,at) VALUES (${revisionId}::uuid,${input.spaceId}::uuid,${id}::uuid,${number(prior.version)},${priorBody},${input.reason},${input.sessionId ?? null},${now}::timestamptz)`
      revision = mapped(
        'lens_profile_revision',
        (await tx`SELECT * FROM lens_profile_revision WHERE id=${revisionId}::uuid`)[0]!,
      )
      await tx`UPDATE lens_profile SET body=${input.body},enabled=${input.enabled},version=version+1,updated_at=${now}::timestamptz WHERE id=${id}::uuid`
    } else
      await tx`INSERT INTO lens_profile (id,space_id,lens_id,axis,name,version,body,enabled,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${lensId}::uuid,${input.axis},${input.name},1,${input.body},${input.enabled},${now}::timestamptz)`
    return {
      profile: mapped(
        'lens_profile',
        (await tx`SELECT * FROM lens_profile WHERE id=${id}::uuid`)[0]!,
      ),
      revision,
    }
  })
}

export type RecordProjectLensSelectionInput = {
  projectId: string
  lensKey?: string | null
  axis: 'framework' | 'architecture'
  profileName: string
  selectedVersion: number | null
  expectedSelectionVersion: number | null
  reason: string
  sessionId?: string | null
}
export async function selectRecordProjectLensProfile(
  input: Tenant & RecordProjectLensSelectionInput,
) {
  return tenant(input, async (tx) => {
    const project =
      await tx`SELECT id FROM project WHERE id=${input.projectId}::uuid AND space_id=${input.spaceId}::uuid`
    if (!project[0]) throw new RecordLensError('project is not in the destination space', 404)
    let lensId: string | null = null
    if (input.lensKey) {
      const found =
        await tx`SELECT id FROM lens WHERE space_id=${input.spaceId}::uuid AND key=${input.lensKey}`
      if (!found[0]) throw new RecordLensError(`no hosted lens "${input.lensKey}"`, 404)
      lensId = text(found[0].id)
    }
    const rows =
      await tx`SELECT * FROM project_lens_profile WHERE space_id=${input.spaceId}::uuid AND project_id=${input.projectId}::uuid AND lens_id IS NOT DISTINCT FROM ${lensId}::uuid AND axis=${input.axis} FOR UPDATE`
    const prior = rows[0] as Record<string, unknown> | undefined
    assertRecordLensVersion(
      'project lens selection',
      input.expectedSelectionVersion,
      prior ? number(prior.selection_version) : null,
    )
    const now = new Date().toISOString(),
      id = prior ? text(prior.id) : newRecordId(),
      revisionId = newRecordId()
    if (prior)
      await tx`UPDATE project_lens_profile SET profile_name=${input.profileName},selected_version=${input.selectedVersion},selection_version=selection_version+1,updated_at=${now}::timestamptz WHERE id=${id}::uuid`
    else
      await tx`INSERT INTO project_lens_profile (id,space_id,project_id,lens_id,axis,profile_name,selected_version,selection_version,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${input.projectId}::uuid,${lensId}::uuid,${input.axis},${input.profileName},${input.selectedVersion},1,${now}::timestamptz)`
    await tx`INSERT INTO project_lens_profile_revision (id,space_id,selection_id,prior_profile_name,prior_selected_version,reason,session_id,at) VALUES (${revisionId}::uuid,${input.spaceId}::uuid,${id}::uuid,${prior?.profile_name == null ? null : text(prior.profile_name)},${prior?.selected_version == null ? null : number(prior.selected_version)},${input.reason},${input.sessionId ?? null},${now}::timestamptz)`
    return {
      selection: mapped(
        'project_lens_profile',
        (await tx`SELECT * FROM project_lens_profile WHERE id=${id}::uuid`)[0]!,
      ),
      revision: mapped(
        'project_lens_profile_revision',
        (await tx`SELECT * FROM project_lens_profile_revision WHERE id=${revisionId}::uuid`)[0]!,
      ),
    }
  })
}
