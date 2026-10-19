import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { projectByName } from '../project/projects.ts'
import { effectiveProjectSpace, rememberProjectSpace } from '../project-space.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import type {
  RecordLensProfileWriteResponse,
  RecordLensWriteResponse,
  RecordProjectLensSelectionResponse,
} from '../record/record-lens-contract.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'

const LENS_AXES = ['framework', 'architecture'] as const
export type LensAxis = (typeof LENS_AXES)[number]

type CoreRow = {
  id: string
  title: string
  question: string
  excludes: string
  slots: string
  version: number
  enabled: number
  requires_execution: number
  space_id: string | null
}
type ProfileRow = {
  id: number
  lens_id: string
  axis: LensAxis
  name: string
  version: number
  body: string
  enabled: number
  space_id: string | null
}

export type LensProfileSource = 'project' | 'stack' | 'generic'
type ProfileSelection = { name: string; version: number | null }
type SetLensInput = {
  id: string
  title: string
  question: string
  excludes: string
  slots: string
  enabled: boolean
  requiresExecution: boolean
  reason: string
}
type SetProfileInput = {
  lensId: string
  axis: string
  name: string
  body: string
  enabled: boolean
  reason: string
}
type SelectProjectProfileInput = {
  project: string
  axis: string
  name: string
  lensId?: string
  version?: number
  reason: string
}

function validateLensInput(input: SetLensInput): void {
  stableId(input.id, 'lens')
  nonempty(input.title, 'title')
  nonempty(input.question, 'question')
  nonempty(input.excludes, 'excludes')
  nonempty(input.reason, 'reason')
  slotNames(input.slots)
}

function validateProfileInput(input: SetProfileInput): LensAxis {
  nonempty(input.name, 'name')
  nonempty(input.reason, 'reason')
  return axisValue(input.axis)
}

function validateSelectionInput(input: SelectProjectProfileInput): LensAxis {
  nonempty(input.reason, 'reason')
  if (input.version !== undefined && (!Number.isInteger(input.version) || input.version < 1))
    throw new Error('version must be a positive integer')
  return axisValue(input.axis)
}

/** Decide one axis's profile without consulting the store. */
export function chooseLensProfile(input: {
  lensSelection: ProfileSelection | null
  axisSelection: ProfileSelection | null
  enabledProfileNames: string[]
  stack: string | null
}): ProfileSelection & { source: LensProfileSource } {
  const selected = input.lensSelection ?? input.axisSelection
  if (selected) return { ...selected, source: 'project' }
  if (input.stack && input.enabledProfileNames.includes(input.stack)) {
    return { name: input.stack, version: null, source: 'stack' }
  }
  return { name: 'default', version: null, source: 'generic' }
}

export function formatLensProfileSource(
  profile: {
    axis: LensAxis
    name: string
    version: number
    source: LensProfileSource
  },
  form: 'resolved' | 'source',
): string {
  return form === 'resolved'
    ? `${profile.axis}=${profile.name}@${profile.version} source=${profile.source}`
    : `${profile.axis}=${profile.source}`
}

const stableId = (value: string, what: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
    throw new Error(`${what} "${value}" must be a lowercase stable id of at most 64 characters`)
}
const nonempty = (value: string, what: string) => {
  if (!value.trim()) throw new Error(`${what} is required`)
  return value
}
const axisValue = (axis: string): LensAxis => {
  if (!(LENS_AXES as readonly string[]).includes(axis))
    throw new Error(`axis must be ${LENS_AXES.join(' or ')}`)
  return axis as LensAxis
}
function objectJson(value: string, what: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('must be an object')
    return parsed
  } catch (error) {
    throw new Error(
      `${what} must be a JSON object: ${error instanceof Error ? error.message : error}`,
    )
  }
}
function slotNames(slots: string): { names: string[]; required: string[] } {
  const schema = objectJson(slots, 'slots')
  if (
    schema.type !== 'object' ||
    schema.additionalProperties !== false ||
    !schema.properties ||
    typeof schema.properties !== 'object' ||
    Array.isArray(schema.properties)
  ) {
    throw new Error(
      'slots must be a JSON Schema object with properties and additionalProperties:false',
    )
  }
  const properties = schema.properties as Record<string, unknown>
  for (const [name, definition] of Object.entries(properties)) {
    stableId(name.replaceAll('_', '-'), 'slot')
    if (
      !definition ||
      typeof definition !== 'object' ||
      !('type' in definition) ||
      typeof definition.type !== 'string'
    ) {
      throw new Error(`slot "${name}" must have type string`)
    }
  }
  const required = schema.required === undefined ? [] : schema.required
  if (
    !Array.isArray(required) ||
    required.some((name) => typeof name !== 'string' || !(name in properties))
  ) {
    throw new Error('slots.required must name declared slots')
  }
  return { names: Object.keys(properties), required: required as string[] }
}
function profileValues(body: string, slots: string): Record<string, string> {
  const values = objectJson(body, 'body')
  const declared = slotNames(slots)
  const unknown = Object.keys(values).filter((key) => !declared.names.includes(key))
  if (unknown.length)
    throw new Error(
      `profile names undeclared slot${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`,
    )
  for (const [key, value] of Object.entries(values))
    if (typeof value !== 'string') throw new Error(`profile slot "${key}" must be Markdown text`)
  const missing = declared.required.filter((key) => !(key in values))
  if (missing.length)
    throw new Error(
      `profile is missing required slot${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
    )
  return values as Record<string, string>
}
const coreSnapshot = (row: CoreRow) =>
  JSON.stringify({
    title: row.title,
    question: row.question,
    excludes: row.excludes,
    slots: JSON.parse(row.slots),
    enabled: !!row.enabled,
    requires_execution: !!row.requires_execution,
  })
const profileSnapshot = (row: ProfileRow) =>
  JSON.stringify({ body: JSON.parse(row.body), enabled: !!row.enabled })

export function listLenses(
  database: Database = db(),
  spaceId: string | null = null,
): NonNullable<ReturnType<typeof showLens>>[] {
  return (
    database.query('SELECT id FROM lens WHERE space_id IS ? ORDER BY id').all(spaceId) as {
      id: string
    }[]
  ).map(({ id }) => showLens(id, database, spaceId)!)
}
const LENS_COLUMNS =
  'id,title,question,excludes,slots,version,enabled,requires_execution,space_id' as const
const PROFILE_COLUMNS = 'id,lens_id,axis,name,version,body,enabled,space_id' as const

export function showLens(id: string, database: Database = db(), spaceId: string | null = null) {
  const row = database
    .query(`SELECT ${LENS_COLUMNS} FROM lens WHERE id=? AND space_id IS ?`)
    .get(id, spaceId) as CoreRow | null
  if (!row) return null
  const profiles = database
    .query(
      `SELECT ${PROFILE_COLUMNS} FROM lens_profile WHERE lens_id=? AND space_id IS ? ORDER BY axis,name`,
    )
    .all(id, spaceId) as ProfileRow[]
  return {
    ...row,
    enabled: !!row.enabled,
    requires_execution: !!row.requires_execution,
    slots: JSON.parse(row.slots),
    profiles: profiles.map((p) => ({ ...p, enabled: !!p.enabled, body: JSON.parse(p.body) })),
  }
}
export async function setLens(input: SetLensInput) {
  writableDb()
  validateLensInput(input)
  const d = db()
  const writeLocal = (spaceId: string | null, hosted?: RecordLensWriteResponse) => {
    const prior = d
      .query(`SELECT ${LENS_COLUMNS} FROM lens WHERE id=? AND space_id IS ?`)
      .get(input.id, spaceId) as CoreRow | null
    writeTransaction(() => {
      if (!prior)
        d.query(
          'INSERT INTO lens (record_id,space_id,id,title,question,excludes,slots,version,enabled,requires_execution) VALUES (?,?,?,?,?,?,?,1,?,?)',
        ).run(
          hosted?.lens.id ?? newRecordId(),
          spaceId,
          input.id,
          input.title,
          input.question,
          input.excludes,
          input.slots,
          input.enabled ? 1 : 0,
          input.requiresExecution ? 1 : 0,
        )
      else {
        d.query(
          'INSERT INTO lens_revision (record_id,space_id,lens_id,version,prior_body,reason,session_id,at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          hosted?.revision?.id ?? newRecordId(),
          spaceId,
          input.id,
          prior.version,
          coreSnapshot(prior),
          input.reason,
          sessionId(),
          nowIso(),
        )
        d.query(
          'UPDATE lens SET record_id=?,title=?,question=?,excludes=?,slots=?,version=?,enabled=?,requires_execution=? WHERE id=? AND space_id IS ?',
        ).run(
          hosted?.lens.id ??
            (
              d
                .query('SELECT record_id FROM lens WHERE id=? AND space_id IS ?')
                .get(input.id, spaceId) as {
                record_id: string
              }
            ).record_id,
          input.title,
          input.question,
          input.excludes,
          input.slots,
          hosted?.lens.version ?? prior.version + 1,
          input.enabled ? 1 : 0,
          input.requiresExecution ? 1 : 0,
          input.id,
          spaceId,
        )
      }
    }, d)
    return showLens(input.id, d, spaceId)!
  }
  return applyRecordWriteAuthority({
    local: () => writeLocal(null),
    hosted: async () => {
      const client = recordApiClient()
      const identity = await client.whoami()
      if (!identity.activeSpaceId) throw new Error('record session has no active space')
      const prior = d
        .query(`SELECT ${LENS_COLUMNS} FROM lens WHERE id=? AND space_id IS ?`)
        .get(input.id, identity.activeSpaceId) as CoreRow | null
      const result = await client.upsertLens(
        {
          key: input.id,
          title: input.title,
          question: input.question,
          excludes: input.excludes,
          slots: input.slots,
          enabled: input.enabled,
          requiresExecution: input.requiresExecution,
          expectedVersion: prior?.version ?? null,
          reason: input.reason,
          sessionId: sessionId(),
        },
        { destinationSpaceId: identity.activeSpaceId },
      )
      return writeLocal(result.lens.spaceId, result)
    },
  })
}
export function listProfiles(lensId?: string, database: Database = db()) {
  const rows = database
    .query(
      `SELECT ${PROFILE_COLUMNS} FROM lens_profile WHERE space_id IS NULL ${lensId ? 'AND lens_id=?' : ''} ORDER BY lens_id,axis,name`,
    )
    .all(...(lensId ? [lensId] : [])) as ProfileRow[]
  return rows.map((row) => ({ ...row, enabled: !!row.enabled, body: JSON.parse(row.body) }))
}
export function showProfile(
  lensId: string,
  axis: string,
  name: string,
  database: Database = db(),
  spaceId: string | null = null,
) {
  const row = database
    .query(
      `SELECT ${PROFILE_COLUMNS} FROM lens_profile WHERE lens_id=? AND axis=? AND name=? AND space_id IS ?`,
    )
    .get(lensId, axisValue(axis), name, spaceId) as ProfileRow | null
  return row ? { ...row, enabled: !!row.enabled, body: JSON.parse(row.body) } : null
}
export async function setProfile(input: SetProfileInput) {
  writableDb()
  const axis = validateProfileInput(input)
  const d = db()
  const writeLocal = (spaceId: string | null, hosted?: RecordLensProfileWriteResponse) => {
    const core = d
      .query(`SELECT ${LENS_COLUMNS} FROM lens WHERE id=? AND space_id IS ?`)
      .get(input.lensId, spaceId) as CoreRow | null
    if (!core) throw new Error(`no lens "${input.lensId}" in the selected record space`)
    profileValues(input.body, core.slots)
    const prior = d
      .query(
        `SELECT ${PROFILE_COLUMNS} FROM lens_profile WHERE lens_id=? AND axis=? AND name=? AND space_id IS ?`,
      )
      .get(input.lensId, axis, input.name, spaceId) as ProfileRow | null
    writeTransaction(() => {
      if (!prior)
        d.query(
          'INSERT INTO lens_profile (record_id,space_id,lens_id,axis,name,version,body,enabled) VALUES (?,?,?,?,?,1,?,?)',
        ).run(
          hosted?.profile.id ?? newRecordId(),
          spaceId,
          input.lensId,
          axis,
          input.name,
          input.body,
          input.enabled ? 1 : 0,
        )
      else {
        d.query(
          'INSERT INTO lens_profile_revision (record_id,space_id,profile_id,version,prior_body,reason,session_id,at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          hosted?.revision?.id ?? newRecordId(),
          spaceId,
          prior.id,
          prior.version,
          profileSnapshot(prior),
          input.reason,
          sessionId(),
          nowIso(),
        )
        d.query('UPDATE lens_profile SET record_id=?,version=?,body=?,enabled=? WHERE id=?').run(
          hosted?.profile.id ??
            (
              d.query('SELECT record_id FROM lens_profile WHERE id=?').get(prior.id) as {
                record_id: string
              }
            ).record_id,
          hosted?.profile.version ?? prior.version + 1,
          input.body,
          input.enabled ? 1 : 0,
          prior.id,
        )
      }
    }, d)
    return showProfile(input.lensId, axis, input.name, d, spaceId)!
  }
  return applyRecordWriteAuthority({
    local: () => writeLocal(null),
    hosted: async () => {
      const client = recordApiClient()
      const identity = await client.whoami()
      if (!identity.activeSpaceId) throw new Error('record session has no active space')
      const core = d
        .query(`SELECT ${LENS_COLUMNS} FROM lens WHERE id=? AND space_id IS ?`)
        .get(input.lensId, identity.activeSpaceId) as CoreRow | null
      if (!core) throw new Error(`no lens "${input.lensId}" in the selected record space`)
      profileValues(input.body, core.slots)
      const prior = d
        .query(
          `SELECT ${PROFILE_COLUMNS} FROM lens_profile WHERE lens_id=? AND axis=? AND name=? AND space_id IS ?`,
        )
        .get(input.lensId, axis, input.name, identity.activeSpaceId) as ProfileRow | null
      const result = await client.upsertLensProfile(
        {
          lensKey: input.lensId,
          axis,
          name: input.name,
          body: input.body,
          enabled: input.enabled,
          expectedVersion: prior?.version ?? null,
          reason: input.reason,
          sessionId: sessionId(),
        },
        { destinationSpaceId: identity.activeSpaceId },
      )
      return writeLocal(result.profile.spaceId, result)
    },
  })
}

function versionedProfile(profile: ProfileRow, version: number | null, d: Database): ProfileRow {
  if (version === null || version === profile.version) return profile
  const prior = d
    .query(
      'SELECT prior_body FROM lens_profile_revision WHERE profile_id=? AND version=? AND space_id IS ?',
    )
    .get(profile.id, version, profile.space_id) as { prior_body: string } | null
  if (!prior)
    throw new Error(
      `profile ${profile.lens_id}/${profile.axis}/${profile.name} has no version ${version}`,
    )
  const snapshot = objectJson(prior.prior_body, 'stored profile revision') as {
    body: Record<string, string>
    enabled: boolean
  }
  return {
    ...profile,
    version,
    body: JSON.stringify(snapshot.body),
    enabled: snapshot.enabled ? 1 : 0,
  }
}

function validateSelectedProfile(
  d: Database,
  axis: LensAxis,
  name: string,
  lensId: string | undefined,
  version: number | undefined,
  spaceId: string | null,
): void {
  const cores = lensId
    ? ([
        d
          .query(`SELECT ${LENS_COLUMNS} FROM lens WHERE id=? AND enabled=1 AND space_id IS ?`)
          .get(lensId, spaceId),
      ].filter(Boolean) as CoreRow[])
    : (d
        .query(
          `SELECT DISTINCT l.id,l.title,l.question,l.excludes,l.slots,l.version,l.enabled,l.requires_execution,l.space_id FROM lens l JOIN lens_profile p ON p.lens_id=l.id AND p.space_id IS l.space_id WHERE l.enabled=1 AND p.axis=? AND l.space_id IS ? ORDER BY l.id`,
        )
        .all(axis, spaceId) as CoreRow[])
  if (lensId && !cores.length) throw new Error(`no enabled lens "${lensId}"`)
  if (!cores.length) throw new Error(`no enabled lenses declare axis ${axis}`)
  const missing = cores.filter((core) => {
    const profile = d
      .query(
        `SELECT ${PROFILE_COLUMNS} FROM lens_profile WHERE lens_id=? AND axis=? AND name=? AND enabled=1 AND space_id IS ?`,
      )
      .get(core.id, axis, name, spaceId) as ProfileRow | null
    if (!profile) return true
    try {
      versionedProfile(profile, version ?? null, d)
      return false
    } catch {
      return true
    }
  })
  if (missing.length)
    throw new Error(
      `profile ${axis}/${name}${version ? ` version ${version}` : ''} is missing or disabled for lenses: ${missing.map((core) => core.id).join(', ')}`,
    )
}

export async function selectProjectProfile(input: SelectProjectProfileInput) {
  writableDb()
  const axis = validateSelectionInput(input)
  const d = db()
  const project = projectByName(input.project)
  if (!project) throw new Error(`no project "${input.project}"`)
  const writeLocal = (spaceId: string | null, hosted?: RecordProjectLensSelectionResponse) => {
    validateSelectedProfile(d, axis, input.name, input.lensId, input.version, spaceId)
    const prior = d
      .query(
        'SELECT id,record_id,profile_name,selected_version,selection_version FROM project_lens_profile WHERE project_record_id=? AND lens_id IS ? AND axis=? AND space_id IS ?',
      )
      .get(project.recordId, input.lensId ?? null, axis, spaceId) as {
      id: number
      profile_name: string
      selected_version: number | null
      selection_version: number
      record_id: string
    } | null
    writeTransaction(() => {
      d.query(`INSERT INTO project_lens_profile (record_id,space_id,project_record_id,lens_id,axis,profile_name,selected_version,selection_version) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT DO UPDATE SET record_id=excluded.record_id,profile_name=excluded.profile_name,selected_version=excluded.selected_version,selection_version=excluded.selection_version`).run(
        hosted?.selection.id ?? prior?.record_id ?? newRecordId(),
        spaceId,
        project.recordId,
        input.lensId ?? null,
        axis,
        input.name,
        input.version ?? null,
        hosted?.selection.selectionVersion ?? (prior?.selection_version ?? 0) + 1,
      )
      const selection = d
        .query(
          'SELECT id FROM project_lens_profile WHERE project_record_id=? AND lens_id IS ? AND axis=? AND space_id IS ?',
        )
        .get(project.recordId, input.lensId ?? null, axis, spaceId) as { id: number }
      d.query(`INSERT INTO project_lens_profile_revision
      (record_id,space_id,selection_id,prior_profile_name,prior_selected_version,reason,session_id,at) VALUES (?,?,?,?,?,?,?,?)`).run(
        hosted?.revision.id ?? newRecordId(),
        spaceId,
        selection.id,
        prior?.profile_name ?? null,
        prior?.selected_version ?? null,
        input.reason,
        sessionId(),
        nowIso(),
      )
    }, d)
    rememberProjectSpace(d, project.name, spaceId)
    return {
      project: project.name,
      lens: input.lensId ?? null,
      axis,
      name: input.name,
      version: input.version ?? null,
      reason: input.reason,
    }
  }
  return applyRecordWriteAuthority({
    local: () => writeLocal(null),
    hosted: async () => {
      const client = recordApiClient()
      const destinationSpaceId = await requireProjectRecordDestination(
        project.name,
        project.settings,
        client,
      )
      validateSelectedProfile(d, axis, input.name, input.lensId, input.version, destinationSpaceId)
      const prior = d
        .query(
          'SELECT selection_version FROM project_lens_profile WHERE project_record_id=? AND lens_id IS ? AND axis=? AND space_id IS ?',
        )
        .get(project.recordId, input.lensId ?? null, axis, destinationSpaceId) as {
        selection_version: number
      } | null
      const result = await client.selectProjectLensProfile(
        {
          projectId: project.recordId,
          lensKey: input.lensId ?? null,
          axis,
          profileName: input.name,
          selectedVersion: input.version ?? null,
          expectedSelectionVersion: prior?.selection_version ?? null,
          reason: input.reason,
          sessionId: sessionId(),
        },
        { destinationSpaceId },
      )
      return writeLocal(result.selection.spaceId, result)
    },
  })
}

const disabledLensRefusal = (id: string, what: string) =>
  `${what}\ninvariant: A disabled catalogue lens or selected profile never dispatches.\ncleared by: enable ${id} or select an enabled profile`

/** Whether a hosted copy holds at least what the local copy holds for one lens and project. */
export function hostedLensComplete(counts: {
  hostedCore: boolean
  localProfiles: number
  hostedProfiles: number
  localSelections: number
  hostedSelections: number
}): boolean {
  return (
    counts.hostedCore &&
    counts.hostedProfiles >= counts.localProfiles &&
    counts.hostedSelections >= counts.localSelections
  )
}

/** A project's hosted space resolves a lens only once it holds that lens's profiles and the project's selections; until then the local catalogue does. */
function resolutionSpace(id: string, projectName: string | null, d: Database): string | null {
  const hosted = effectiveProjectSpace(d, projectName)
  if (hosted === null) return null
  const projectRecordId = projectName ? (projectByName(projectName, d)?.recordId ?? null) : null
  const profiles = (space: string | null) =>
    (
      d
        .query(
          'SELECT count(*) AS n FROM lens_profile WHERE lens_id=? AND enabled=1 AND space_id IS ?',
        )
        .get(id, space) as { n: number }
    ).n
  const selections = (space: string | null) =>
    (
      d
        .query(
          'SELECT count(*) AS n FROM project_lens_profile WHERE project_record_id=? AND (lens_id=? OR lens_id IS NULL) AND space_id IS ?',
        )
        .get(projectRecordId, id, space) as { n: number }
    ).n
  const complete = hostedLensComplete({
    hostedCore: Boolean(d.query('SELECT 1 FROM lens WHERE id=? AND space_id=?').get(id, hosted)),
    localProfiles: profiles(null),
    hostedProfiles: profiles(hosted),
    localSelections: selections(null),
    hostedSelections: selections(hosted),
  })
  return complete ? hosted : null
}

export function resolveLens(id: string, projectName: string | null, d: Database = db()) {
  const spaceId = resolutionSpace(id, projectName, d)
  const core = d
    .query(`SELECT ${LENS_COLUMNS} FROM lens WHERE id=? AND space_id IS ?`)
    .get(id, spaceId) as CoreRow | null
  if (!core) return null
  if (!core.enabled) throw new Error(disabledLensRefusal(id, `lens "${id}" is disabled`))
  const project = projectName ? projectByName(projectName, d) : null
  const axes = d
    .query(`SELECT axis FROM (
    SELECT DISTINCT axis FROM lens_profile WHERE lens_id=? AND enabled=1 AND space_id IS ?
    UNION
    SELECT DISTINCT axis FROM project_lens_profile
      WHERE project_record_id=? AND (lens_id=? OR lens_id IS NULL) AND space_id IS ?
  ) ORDER BY axis`)
    .all(id, spaceId, project?.recordId ?? -1, id, spaceId) as { axis: LensAxis }[]
  const profiles: (ProfileRow & { source: LensProfileSource })[] = []
  for (const { axis } of axes) {
    const selections = project
      ? (d
          .query(
            `SELECT lens_id,profile_name,selected_version FROM project_lens_profile
             WHERE project_record_id=? AND axis=? AND (lens_id=? OR lens_id IS NULL) AND space_id IS ?`,
          )
          .all(project.recordId, axis, id, spaceId) as {
          lens_id: string | null
          profile_name: string
          selected_version: number | null
        }[])
      : []
    const selection = (lensId: string | null): ProfileSelection | null => {
      const row = selections.find((candidate) => candidate.lens_id === lensId)
      return row ? { name: row.profile_name, version: row.selected_version } : null
    }
    const enabledProfileNames = (
      d
        .query(
          'SELECT name FROM lens_profile WHERE lens_id=? AND axis=? AND enabled=1 AND space_id IS ?',
        )
        .all(id, axis, spaceId) as { name: string }[]
    ).map((row) => row.name)
    const choice = chooseLensProfile({
      lensSelection: selection(id),
      axisSelection: selection(null),
      enabledProfileNames,
      stack: project?.stack ?? null,
    })
    const profile = d
      .query(
        `SELECT ${PROFILE_COLUMNS} FROM lens_profile WHERE lens_id=? AND axis=? AND name=? AND space_id IS ?`,
      )
      .get(id, axis, choice.name, spaceId) as ProfileRow | null
    if (!profile)
      throw new Error(
        disabledLensRefusal(id, `lens "${id}" has no ${axis} profile "${choice.name}"`),
      )
    const chosen = versionedProfile(profile, choice.version, d)
    if (!chosen.enabled)
      throw new Error(
        disabledLensRefusal(id, `lens "${id}" selected disabled ${axis} profile "${choice.name}"`),
      )
    profiles.push({ ...chosen, source: choice.source })
  }
  const values: Record<string, string> = {}
  for (const profile of profiles)
    for (const [slot, value] of Object.entries(profileValues(profile.body, core.slots))) {
      if (slot in values)
        throw new Error(`lens "${id}" slot "${slot}" is filled by more than one selected profile`)
      values[slot] = value
    }
  const declared = slotNames(core.slots)
  const body = declared.names
    .flatMap((slot) => {
      const value = values[slot]
      return value?.trim() ? [`${slot.replaceAll('_', ' ').toUpperCase()}\n${value}`] : []
    })
    .join('\n\n')
  return {
    id: core.id,
    title: core.title,
    question: core.question,
    excludes: core.excludes,
    slots: declared.names,
    version: core.version,
    requires_execution: !!core.requires_execution,
    profiles: profiles.map((p) => ({
      axis: p.axis,
      name: p.name,
      version: p.version,
      source: p.source,
    })),
    body,
  }
}
