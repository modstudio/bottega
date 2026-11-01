// concern: record-lens-catalogue
/** Owns tenant-bound hosted lens catalogue reads and writes. */
import type { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { lensProfileSnapshot, nextLensProfileVersion } from '../lens/lens-profile-version.ts'
import { type RecordCursor, type RecordListCursorRow, recordCursorAt } from './record-cursor.ts'
import type {
  RecordLensProfileWriteInput,
  RecordLensTable,
  RecordLensWriteInput,
  RecordProjectLensSelectionInput,
} from './record-lens-contract.ts'
import { PINNED_LENS_VERSION_REQUIRES_LENS_KEY, RecordLensError } from './record-lens-contract.ts'
import { recordPool } from './record-pool.ts'

type Tenant = { url: string } & TenantPrincipal

async function tenant<T>(input: Tenant, use: (tx: SQL) => Promise<T>): Promise<T> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    return use(tx)
  })
}

const text = (value: unknown) => String(value)
const nullable = (value: unknown) => (value == null ? null : String(value))
const number = (value: unknown) => Number(value)
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))

function hostedLensProfilePinVersionSql(input: {
  selection: string
  row: string
  profileName: string
  versionId: string
  label: string
}): { projection: string; joins: string } {
  const { selection, row, profileName, versionId, label } = input
  return {
    projection: `COALESCE(current_profile.version, pinned_revision.version) AS ${label}`,
    joins: `LEFT JOIN lens_profile current_profile
      ON current_profile.space_id=${row}.space_id
      AND current_profile.lens_id=${selection}.lens_id
      AND current_profile.axis=${selection}.axis
      AND current_profile.name=${profileName}
      AND current_profile.current_version_id=${versionId}
    LEFT JOIN lens_profile_revision pinned_revision
      ON pinned_revision.space_id=${row}.space_id
      AND pinned_revision.id=${versionId}`,
  }
}

async function selectionRows(
  tx: SQL,
  spaceId: string,
  after: { at: string | null; id: string | null; rowId: string | null; limit: number },
): Promise<Record<string, unknown>[]> {
  const pinVersion = hostedLensProfilePinVersionSql({
    selection: 'selection',
    row: 'selection',
    profileName: 'selection.profile_name',
    versionId: 'selection.selected_version_id',
    label: 'selected_version',
  })
  return tx.unsafe(
    `SELECT selection.*,
      ${pinVersion.projection},
      to_char(selection.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM project_lens_profile selection
    ${pinVersion.joins}
    WHERE selection.space_id=$1::uuid
      AND ($2::uuid IS NULL OR selection.id=$2::uuid)
      AND ($3::timestamptz IS NULL OR (selection.updated_at,selection.id)>($3::timestamptz,$4::uuid))
    ORDER BY selection.updated_at,selection.id LIMIT $5`,
    [spaceId, after.rowId, after.at, after.id, after.limit],
  )
}

async function selectionRevisionRows(
  tx: SQL,
  spaceId: string,
  after: { at: string | null; id: string | null; rowId: string | null; limit: number },
): Promise<Record<string, unknown>[]> {
  const pinVersion = hostedLensProfilePinVersionSql({
    selection: 'selection',
    row: 'history',
    profileName: 'history.prior_profile_name',
    versionId: 'history.prior_selected_version_id',
    label: 'prior_selected_version',
  })
  return tx.unsafe(
    `SELECT history.*,
      ${pinVersion.projection},
      to_char(history.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM project_lens_profile_revision history
    JOIN project_lens_profile selection
      ON selection.space_id=history.space_id AND selection.id=history.selection_id
    ${pinVersion.joins}
    WHERE history.space_id=$1::uuid
      AND ($2::uuid IS NULL OR history.id=$2::uuid)
      AND ($3::timestamptz IS NULL OR (history.at,history.id)>($3::timestamptz,$4::uuid))
    ORDER BY history.at,history.id LIMIT $5`,
    [spaceId, after.rowId, after.at, after.id, after.limit],
  )
}

function mapped(
  table: RecordLensTable,
  row: Record<string, unknown>,
): { id: string } & Record<string, unknown> {
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
        currentVersionId: text(row.current_version_id),
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
        selectedVersionId: nullable(row.selected_version_id),
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
        priorSelectedVersionId: nullable(row.prior_selected_version_id),
        reason: text(row.reason),
        sessionId: nullable(row.session_id),
        at: iso(row.at),
      }
  }
}

export async function listRecordLensCatalogue(
  input: Tenant & { table: RecordLensTable; limit: number; cursor: RecordCursor | null },
): Promise<(Record<string, unknown> & RecordListCursorRow)[]> {
  return tenant(input, async (tx) => {
    const at = input.cursor?.at ?? null
    const id = input.cursor?.id ?? null
    let rows: Record<string, unknown>[]
    switch (input.table) {
      case 'lens':
        rows =
          await tx`SELECT *,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM lens WHERE space_id=${input.spaceId}::uuid AND (${at}::timestamptz IS NULL OR (updated_at,id)>(${at}::timestamptz,${id}::uuid)) ORDER BY updated_at,id LIMIT ${input.limit + 1}`
        break
      case 'lens_revision':
        rows =
          await tx`SELECT *,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM lens_revision WHERE space_id=${input.spaceId}::uuid AND (${at}::timestamptz IS NULL OR (at,id)>(${at}::timestamptz,${id}::uuid)) ORDER BY at,id LIMIT ${input.limit + 1}`
        break
      case 'lens_profile':
        rows =
          await tx`SELECT *,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM lens_profile WHERE space_id=${input.spaceId}::uuid AND (${at}::timestamptz IS NULL OR (updated_at,id)>(${at}::timestamptz,${id}::uuid)) ORDER BY updated_at,id LIMIT ${input.limit + 1}`
        break
      case 'lens_profile_revision':
        rows =
          await tx`SELECT *,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM lens_profile_revision WHERE space_id=${input.spaceId}::uuid AND (${at}::timestamptz IS NULL OR (at,id)>(${at}::timestamptz,${id}::uuid)) ORDER BY at,id LIMIT ${input.limit + 1}`
        break
      case 'project_lens_profile':
        rows = await selectionRows(tx, input.spaceId, {
          at,
          id,
          rowId: null,
          limit: input.limit + 1,
        })
        break
      case 'project_lens_profile_revision':
        rows = await selectionRevisionRows(tx, input.spaceId, {
          at,
          id,
          rowId: null,
          limit: input.limit + 1,
        })
        break
    }
    return rows.map((row) => ({
      ...mapped(input.table, row),
      [recordCursorAt]: text(row.cursor_at),
    }))
  })
}

const assertRecordLensVersion = (what: string, expected: number | null, current: number | null) => {
  if (expected !== current)
    throw new RecordLensError(
      `refusing stale ${what} update: expected version ${expected ?? 'none'}, current version ${current ?? 'none'}`,
    )
}

export async function upsertRecordLens(input: Tenant & RecordLensWriteInput) {
  return tenant(input, async (tx) => {
    await tx`SELECT id FROM space WHERE id=${input.spaceId}::uuid FOR UPDATE`
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

export async function upsertRecordLensProfile(input: Tenant & RecordLensProfileWriteInput) {
  return tenant(input, async (tx) => {
    await tx`SELECT id FROM space WHERE id=${input.spaceId}::uuid FOR UPDATE`
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
      const revisionNumbers = (
        await tx`SELECT version FROM lens_profile_revision WHERE space_id=${input.spaceId}::uuid AND profile_id=${id}::uuid`
      ).map((row: Record<string, unknown>) => number(row.version))
      const revisionId = nullable(prior.current_version_id) ?? newRecordId(),
        currentVersionId = newRecordId(),
        nextVersion = nextLensProfileVersion(number(prior.version), revisionNumbers),
        priorBody = lensProfileSnapshot(text(prior.body), Boolean(prior.enabled))
      await tx`INSERT INTO lens_profile_revision (id,space_id,profile_id,version,prior_body,reason,session_id,at) VALUES (${revisionId}::uuid,${input.spaceId}::uuid,${id}::uuid,${number(prior.version)},${priorBody},${input.reason},${input.sessionId ?? null},${now}::timestamptz)`
      revision = mapped(
        'lens_profile_revision',
        (await tx`SELECT * FROM lens_profile_revision WHERE id=${revisionId}::uuid`)[0]!,
      )
      await tx`UPDATE lens_profile SET body=${input.body},enabled=${input.enabled},version=${nextVersion},current_version_id=${currentVersionId}::uuid,updated_at=${now}::timestamptz WHERE id=${id}::uuid`
    } else
      await tx`INSERT INTO lens_profile (id,space_id,lens_id,axis,name,version,current_version_id,body,enabled,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${lensId}::uuid,${input.axis},${input.name},1,${newRecordId()}::uuid,${input.body},${input.enabled},${now}::timestamptz)`
    return {
      profile: mapped(
        'lens_profile',
        (await tx`SELECT * FROM lens_profile WHERE id=${id}::uuid`)[0]!,
      ),
      revision,
    }
  })
}

async function selectionCandidateLenses(
  tx: SQL,
  input: Tenant & RecordProjectLensSelectionInput,
  lensId: string | null,
): Promise<Record<string, unknown>[]> {
  const candidateLenses = lensId
    ? await tx`SELECT id,key FROM lens
        WHERE space_id=${input.spaceId}::uuid AND id=${lensId}::uuid AND enabled=true`
    : await tx`SELECT id,key FROM lens l
        WHERE space_id=${input.spaceId}::uuid AND enabled=true AND EXISTS (
          SELECT 1 FROM lens_profile declared WHERE declared.space_id=l.space_id
            AND declared.lens_id=l.id AND declared.axis=${input.axis}
        )
        ORDER BY key`
  if (!candidateLenses.length)
    throw new RecordLensError(
      lensId
        ? `no enabled hosted lens "${input.lensKey}"`
        : `no enabled hosted lenses declare axis ${input.axis}`,
      422,
    )
  return candidateLenses
}

async function selectionProfileExists(
  tx: SQL,
  input: Tenant & RecordProjectLensSelectionInput,
  lensId: string,
): Promise<{ versionId: string | null } | null> {
  const profiles = await tx`SELECT id,version,current_version_id,enabled FROM lens_profile
    WHERE space_id=${input.spaceId}::uuid AND lens_id=${lensId}::uuid
      AND axis=${input.axis} AND name=${input.profileName}
    FOR UPDATE`
  const profile = profiles[0]
  if (!profile?.enabled) return null
  const selectedVersionId = input.selectedVersionId
  if (input.selectedVersion === null && selectedVersionId === null) return { versionId: null }
  const resolved = selectedVersionId
    ? await selectedProfileVersionById(tx, input.spaceId, profile, selectedVersionId)
    : await selectedProfileVersionByNumber(tx, input.spaceId, profile, input.selectedVersion!)
  if (!resolved?.enabled) return null
  if (input.selectedVersion !== resolved.version)
    throw new RecordLensError(
      `selected version ${input.selectedVersion ?? 'none'} and selected version id ${selectedVersionId} name different versions`,
      422,
    )
  return { versionId: resolved.id }
}

type SelectedProfileVersion = { id: string; version: number; enabled: boolean }

function currentSelectedProfileVersion(
  profile: Record<string, unknown>,
): SelectedProfileVersion | null {
  const id = nullable(profile.current_version_id)
  return id ? { id, version: number(profile.version), enabled: Boolean(profile.enabled) } : null
}

function historicalSelectedProfileVersion(
  revision: Record<string, unknown> | undefined,
): SelectedProfileVersion | null {
  if (!revision) return null
  const snapshot = JSON.parse(text(revision.prior_body)) as { enabled?: unknown }
  return {
    id: text(revision.id),
    version: number(revision.version),
    enabled: snapshot.enabled === true,
  }
}

async function selectedProfileVersionById(
  tx: SQL,
  spaceId: string,
  profile: Record<string, unknown>,
  versionId: string,
): Promise<SelectedProfileVersion | null> {
  if (nullable(profile.current_version_id) === versionId)
    return currentSelectedProfileVersion(profile)
  const revision = await tx`SELECT id,version,prior_body FROM lens_profile_revision
    WHERE space_id=${spaceId}::uuid AND profile_id=${text(profile.id)}::uuid
      AND id=${versionId}::uuid`
  return historicalSelectedProfileVersion(revision[0])
}

async function selectedProfileVersionByNumber(
  tx: SQL,
  spaceId: string,
  profile: Record<string, unknown>,
  version: number,
): Promise<SelectedProfileVersion | null> {
  if (number(profile.version) === version) return currentSelectedProfileVersion(profile)
  const revision = await tx`SELECT id,version,prior_body FROM lens_profile_revision
    WHERE space_id=${spaceId}::uuid AND profile_id=${text(profile.id)}::uuid
      AND version=${version}`
  return historicalSelectedProfileVersion(revision[0])
}

async function validatedSelectionLensId(
  tx: SQL,
  input: Tenant & RecordProjectLensSelectionInput,
): Promise<{ lensId: string | null; selectedVersionId: string | null }> {
  if (input.selectedVersion !== null && !input.lensKey)
    throw new RecordLensError(PINNED_LENS_VERSION_REQUIRES_LENS_KEY, 422)
  let lensId: string | null = null
  if (input.lensKey) {
    const found =
      await tx`SELECT id FROM lens WHERE space_id=${input.spaceId}::uuid AND key=${input.lensKey}`
    if (!found[0]) throw new RecordLensError(`no hosted lens "${input.lensKey}"`, 404)
    lensId = text(found[0].id)
  }
  const candidateLenses = await selectionCandidateLenses(tx, input, lensId)
  const invalid: string[] = []
  let selectedVersionId: string | null = null
  for (const lens of candidateLenses) {
    const profile = await selectionProfileExists(tx, input, text(lens.id))
    if (!profile) invalid.push(text(lens.key))
    else if (lensId) selectedVersionId = profile.versionId
  }
  if (invalid.length)
    throw new RecordLensError(
      `profile ${input.axis}/${input.profileName}${input.selectedVersion ? ` version ${input.selectedVersion}` : ''} is missing or disabled for hosted lenses: ${invalid.join(', ')}`,
      422,
    )
  return { lensId, selectedVersionId }
}

export async function selectRecordProjectLensProfile(
  input: Tenant & RecordProjectLensSelectionInput,
) {
  return tenant(input, async (tx) => {
    await tx`SELECT id FROM space WHERE id=${input.spaceId}::uuid FOR UPDATE`
    const project =
      await tx`SELECT id FROM project WHERE id=${input.projectId}::uuid AND space_id=${input.spaceId}::uuid`
    if (!project[0]) throw new RecordLensError('project is not in the destination space', 404)
    const { lensId, selectedVersionId } = await validatedSelectionLensId(tx, input)
    const pinVersion = hostedLensProfilePinVersionSql({
      selection: 'selection',
      row: 'selection',
      profileName: 'selection.profile_name',
      versionId: 'selection.selected_version_id',
      label: 'selected_version',
    })
    const rows = await tx.unsafe(
      `SELECT selection.*,
      ${pinVersion.projection}
      FROM project_lens_profile selection
      ${pinVersion.joins}
      WHERE selection.space_id=$1::uuid
        AND selection.project_id=$2::uuid
        AND selection.lens_id IS NOT DISTINCT FROM $3::uuid
        AND selection.axis=$4 FOR UPDATE OF selection`,
      [input.spaceId, input.projectId, lensId, input.axis],
    )
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
      await tx`UPDATE project_lens_profile SET profile_name=${input.profileName},selected_version_id=${selectedVersionId}::uuid,selection_version=selection_version+1,updated_at=${now}::timestamptz WHERE id=${id}::uuid`
    else
      await tx`INSERT INTO project_lens_profile (id,space_id,project_id,lens_id,axis,profile_name,selected_version_id,selection_version,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${input.projectId}::uuid,${lensId}::uuid,${input.axis},${input.profileName},${selectedVersionId}::uuid,1,${now}::timestamptz)`
    await tx`INSERT INTO project_lens_profile_revision (id,space_id,selection_id,prior_profile_name,prior_selected_version_id,reason,session_id,at) VALUES (${revisionId}::uuid,${input.spaceId}::uuid,${id}::uuid,${prior?.profile_name == null ? null : text(prior.profile_name)},${prior?.selected_version_id == null ? null : text(prior.selected_version_id)}::uuid,${input.reason},${input.sessionId ?? null},${now}::timestamptz)`
    const selection = await selectionRows(tx, input.spaceId, {
      at: null,
      id: null,
      rowId: id,
      limit: 1,
    })
    const revisions = await selectionRevisionRows(tx, input.spaceId, {
      at: null,
      id: null,
      rowId: revisionId,
      limit: 1,
    })
    return {
      selection: mapped('project_lens_profile', selection[0]!),
      revision: mapped('project_lens_profile_revision', revisions[0]!),
    }
  })
}
