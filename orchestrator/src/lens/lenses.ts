import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { type Project, projectByName } from '../project/projects.ts'
import { activeRecordSpace, effectiveProjectSpace, rememberProjectSpace } from '../project-space.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import type {
  RecordLensProfileWriteResponse,
  RecordLensWriteResponse,
  RecordProjectLensSelectionResponse,
} from '../record/record-lens-contract.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { BUILT_IN_LENS_DEFAULT_PROFILE } from './lens-built-ins.ts'

const LENS_AXES = ['framework', 'architecture'] as const
export type LensAxis = (typeof LENS_AXES)[number]

type CoreRow = {
  record_id: string
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
  record_id: string
  lens_record_id: string
  lens_id: string
  axis: LensAxis
  name: string
  version: number
  current_version_id: string | null
  body: string
  enabled: number
  space_id: string | null
}

export type LensProfileSource = 'project' | 'stack' | 'generic'
type ProfileSelection = { name: string; version: number | null; versionId: string | null }
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
  project?: Project
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
  if (input.version !== undefined && !input.lensId)
    throw new Error(
      "a pinned version names one lens profile's version; pass --lens <key> with --version",
    )
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
    return { name: input.stack, version: null, versionId: null, source: 'stack' }
  }
  return { name: 'default', version: null, versionId: null, source: 'generic' }
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

function lensRecordId(d: Database, lensId: string, spaceId: string | null): string {
  return (
    d.query('SELECT record_id FROM lens WHERE id=? AND space_id IS ?').get(lensId, spaceId) as {
      record_id: string
    }
  ).record_id
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

function defaultProfileBody(slots: string): string {
  const builtInValues = objectJson(BUILT_IN_LENS_DEFAULT_PROFILE, 'built-in default profile')
  return JSON.stringify(
    Object.fromEntries(
      slotNames(slots).names.map((slot) => [
        slot,
        typeof builtInValues[slot] === 'string' ? builtInValues[slot] : 'None.',
      ]),
    ),
  )
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
  spaceId: string | null = activeRecordSpace(database),
): NonNullable<ReturnType<typeof showLens>>[] {
  return (
    database.query('SELECT id FROM lens WHERE space_id IS ? ORDER BY id').all(spaceId) as {
      id: string
    }[]
  ).map(({ id }) => showLens(id, database, spaceId)!)
}
const LENS_COLUMNS =
  'record_id,id,title,question,excludes,slots,version,enabled,requires_execution,space_id' as const
const PROFILE_COLUMNS =
  'p.record_id,p.lens_record_id,l.id lens_id,p.axis,p.name,p.version,p.current_version_id,p.body,p.enabled,p.space_id' as const

export function showLens(
  id: string,
  database: Database = db(),
  spaceId: string | null = activeRecordSpace(database),
) {
  const row = database
    .query(`SELECT ${LENS_COLUMNS} FROM lens WHERE id=? AND space_id IS ?`)
    .get(id, spaceId) as CoreRow | null
  if (!row) return null
  const profiles = database
    .query(
      `SELECT ${PROFILE_COLUMNS} FROM lens_profile p JOIN lens l ON l.record_id=p.lens_record_id WHERE l.id=? AND p.space_id IS ? ORDER BY p.axis,p.name`,
    )
    .all(id, spaceId) as ProfileRow[]
  return {
    ...row,
    enabled: !!row.enabled,
    requires_execution: !!row.requires_execution,
    slots: JSON.parse(row.slots),
    profiles: profiles.map(({ current_version_id: _currentVersionId, ...p }) => ({
      ...p,
      enabled: !!p.enabled,
      body: JSON.parse(p.body),
    })),
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
          'INSERT INTO lens_revision (record_id,space_id,lens_record_id,version,prior_body,reason,session_id,at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          hosted?.revision?.id ?? newRecordId(),
          spaceId,
          lensRecordId(d, input.id, spaceId),
          prior.version,
          coreSnapshot(prior),
          input.reason,
          sessionId(),
          nowIso(),
        )
        d.query(
          'UPDATE lens SET record_id=?,title=?,question=?,excludes=?,slots=?,version=?,enabled=?,requires_execution=? WHERE id=? AND space_id IS ?',
        ).run(
          hosted?.lens.id ?? lensRecordId(d, input.id, spaceId),
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
export function listProfiles(
  lensId?: string,
  database: Database = db(),
  project: Pick<Project, 'name'> | null = null,
) {
  const spaceId = lensProfileSpace(project?.name ?? null, database)
  return profileRows(lensId, database, spaceId).map((row) => ({
    ...row,
    enabled: !!row.enabled,
    body: JSON.parse(row.body),
  }))
}

function profileRows(
  lensId: string | undefined,
  database: Database,
  spaceId: string | null,
): ProfileRow[] {
  const rows = database
    .query(
      `SELECT ${PROFILE_COLUMNS} FROM lens_profile p JOIN lens l ON l.record_id=p.lens_record_id WHERE p.space_id IS ? ${lensId ? 'AND l.id=?' : ''} ORDER BY l.id,p.axis,p.name`,
    )
    .all(...(lensId ? [spaceId, lensId] : [spaceId])) as ProfileRow[]
  return rows
}

/** Resolve the catalogue space used by profile inspection, selection, and dispatch. */
function lensProfileSpace(projectName: string | null, database: Database = db()): string | null {
  if (!projectName) return activeRecordSpace(database)
  return effectiveProjectSpace(database, projectName)
}
export function showProfile(
  lensId: string,
  axis: string,
  name: string,
  database: Database = db(),
  project: Pick<Project, 'name'> | null = null,
) {
  return showProfileInSpace(
    lensId,
    axis,
    name,
    database,
    lensProfileSpace(project?.name ?? null, database),
  )
}

function showProfileInSpace(
  lensId: string,
  axis: string,
  name: string,
  database: Database,
  spaceId: string | null,
) {
  const row = profileRowInSpace(lensId, axisValue(axis), name, database, spaceId)
  if (!row) return null
  const { current_version_id: _currentVersionId, ...profile } = row
  return { ...profile, enabled: !!profile.enabled, body: JSON.parse(profile.body) }
}

function profileRowInSpace(
  lensId: string,
  axis: LensAxis,
  name: string,
  database: Database,
  spaceId: string | null,
): ProfileRow | null {
  return database
    .query(
      `SELECT ${PROFILE_COLUMNS} FROM lens_profile p JOIN lens l ON l.record_id=p.lens_record_id WHERE l.id=? AND p.axis=? AND p.name=? AND p.space_id IS ?`,
    )
    .get(lensId, axis, name, spaceId) as ProfileRow | null
}
export async function setProfile(input: SetProfileInput) {
  writableDb()
  const axis = validateProfileInput(input)
  const d = db()
  const project = input.project ?? null
  const writeLocal = (spaceId: string | null, hosted?: RecordLensProfileWriteResponse) => {
    const core = d
      .query(`SELECT ${LENS_COLUMNS} FROM lens WHERE id=? AND space_id IS ?`)
      .get(input.lensId, spaceId) as CoreRow | null
    if (!core) throw new Error(`no lens "${input.lensId}" in the selected record space`)
    profileValues(input.body, core.slots)
    const prior = profileRowInSpace(input.lensId, axis, input.name, d, spaceId)
    writeTransaction(() => {
      if (!prior)
        d.query(
          'INSERT INTO lens_profile (record_id,space_id,lens_record_id,axis,name,version,current_version_id,body,enabled) VALUES (?,?,?,?,?,1,?,?,?)',
        ).run(
          hosted?.profile.id ?? newRecordId(),
          spaceId,
          core.record_id,
          axis,
          input.name,
          hosted?.profile.currentVersionId ?? newRecordId(),
          input.body,
          input.enabled ? 1 : 0,
        )
      else {
        const outgoingVersionId = hosted?.revision?.id ?? prior.current_version_id ?? newRecordId()
        d.query(
          'INSERT INTO lens_profile_revision (record_id,space_id,profile_record_id,version,prior_body,reason,session_id,at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          outgoingVersionId,
          spaceId,
          prior.record_id,
          prior.version,
          profileSnapshot(prior),
          input.reason,
          sessionId(),
          nowIso(),
        )
        d.query(
          'UPDATE lens_profile SET version=?,current_version_id=?,body=?,enabled=? WHERE record_id=?',
        ).run(
          hosted?.profile.version ?? prior.version + 1,
          hosted?.profile.currentVersionId ?? newRecordId(),
          input.body,
          input.enabled ? 1 : 0,
          prior.record_id,
        )
      }
    }, d)
    return showProfileInSpace(input.lensId, axis, input.name, d, spaceId)!
  }
  return applyRecordWriteAuthority({
    local: () => writeLocal(project ? lensProfileSpace(project.name, d) : null),
    hosted: async () => {
      const client = recordApiClient()
      const identity = await client.whoami()
      if (!identity.activeSpaceId) throw new Error('record session has no active space')
      const destinationSpaceId = project
        ? await requireProjectRecordDestination(project.name, project.settings, client)
        : identity.activeSpaceId
      const core = d
        .query(`SELECT ${LENS_COLUMNS} FROM lens WHERE id=? AND space_id IS ?`)
        .get(input.lensId, destinationSpaceId) as CoreRow | null
      if (!core) throw new Error(`no lens "${input.lensId}" in the selected record space`)
      profileValues(input.body, core.slots)
      const prior = profileRowInSpace(input.lensId, axis, input.name, d, destinationSpaceId)
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
        { destinationSpaceId },
      )
      return writeLocal(result.profile.spaceId, result)
    },
  })
}

function versionedProfile(
  profile: ProfileRow,
  selection: Pick<ProfileSelection, 'version' | 'versionId'>,
  d: Database,
): ProfileRow {
  if (selection.versionId === profile.current_version_id) return profile
  if (
    selection.versionId === null &&
    (selection.version === null || selection.version === profile.version)
  )
    return profile
  const prior = d
    .query(
      `SELECT record_id,version,prior_body FROM lens_profile_revision
       WHERE profile_record_id=? AND space_id IS ?
         AND (${selection.versionId === null ? 'version=?' : 'record_id=?'})`,
    )
    .get(profile.record_id, profile.space_id, selection.versionId ?? selection.version) as {
    record_id: string
    version: number
    prior_body: string
  } | null
  if (!prior)
    throw new Error(
      `profile ${profile.lens_id}/${profile.axis}/${profile.name} has no version ${selection.version ?? selection.versionId}`,
    )
  const snapshot = objectJson(prior.prior_body, 'stored profile revision') as {
    body: Record<string, string>
    enabled: boolean
  }
  return {
    ...profile,
    version: prior.version,
    current_version_id: prior.record_id,
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
): string | null {
  const cores = lensId
    ? ([
        d
          .query(`SELECT ${LENS_COLUMNS} FROM lens WHERE id=? AND enabled=1 AND space_id IS ?`)
          .get(lensId, spaceId),
      ].filter(Boolean) as CoreRow[])
    : (d
        .query(
          `SELECT DISTINCT l.id,l.title,l.question,l.excludes,l.slots,l.version,l.enabled,l.requires_execution,l.space_id FROM lens l JOIN lens_profile p ON p.lens_record_id=l.record_id WHERE l.enabled=1 AND p.axis=? AND l.space_id IS ? ORDER BY l.id`,
        )
        .all(axis, spaceId) as CoreRow[])
  if (lensId && !cores.length) throw new Error(`no enabled lens "${lensId}"`)
  if (!cores.length) throw new Error(`no enabled lenses declare axis ${axis}`)
  const missing = cores.filter((core) => {
    const profile = profileRows(core.id, d, spaceId).find(
      (candidate) => candidate.axis === axis && candidate.name === name && candidate.enabled,
    ) as ProfileRow | undefined
    if (!profile) return true
    try {
      versionedProfile(profile, { version: version ?? null, versionId: null }, d)
      return false
    } catch {
      return true
    }
  })
  if (missing.length)
    throw new Error(
      `profile ${axis}/${name}${version ? ` version ${version}` : ''} is missing or disabled for lenses: ${missing.map((core) => core.id).join(', ')}`,
    )
  if (version === undefined) return null
  const profile = profileRows(lensId, d, spaceId).find(
    (candidate) => candidate.axis === axis && candidate.name === name,
  )!
  const resolved = versionedProfile(profile, { version, versionId: null }, d)
  if (!resolved.current_version_id)
    throw new Error(
      `profile ${profile.lens_id}/${profile.axis}/${profile.name} has no version ${version}`,
    )
  return resolved.current_version_id
}

function writeProjectProfileSelectionLocal(input: {
  d: Database
  project: Project
  axis: LensAxis
  selection: SelectProjectProfileInput
  spaceId: string | null
  hosted?: RecordProjectLensSelectionResponse
}) {
  const { d, project, axis, selection, spaceId, hosted } = input
  const selectedVersionId = validateSelectedProfile(
    d,
    axis,
    selection.name,
    selection.lensId,
    selection.version,
    spaceId,
  )
  const prior = d
    .query(
      `SELECT s.record_id,s.profile_name,s.selected_version,s.selected_version_id,s.selection_version FROM project_lens_profile s
       LEFT JOIN lens l ON l.record_id=s.lens_record_id
       WHERE s.project_record_id=? AND l.id IS ? AND s.axis=? AND s.space_id IS ?`,
    )
    .get(project.recordId, selection.lensId ?? null, axis, spaceId) as {
    profile_name: string
    selected_version: number | null
    selected_version_id: string | null
    selection_version: number
    record_id: string
  } | null
  writeTransaction(() => {
    const selectedLensRecordId = selection.lensId
      ? lensRecordId(d, selection.lensId, spaceId)
      : null
    d.query(`INSERT INTO project_lens_profile (record_id,space_id,project_record_id,lens_record_id,axis,profile_name,selected_version,selected_version_id,selection_version) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT DO UPDATE SET record_id=excluded.record_id,profile_name=excluded.profile_name,selected_version=excluded.selected_version,selected_version_id=excluded.selected_version_id,selection_version=excluded.selection_version`).run(
      hosted?.selection.id ?? prior?.record_id ?? newRecordId(),
      spaceId,
      project.recordId,
      selectedLensRecordId,
      axis,
      selection.name,
      selection.version ?? null,
      hosted?.selection.selectedVersionId ?? selectedVersionId,
      hosted?.selection.selectionVersion ?? (prior?.selection_version ?? 0) + 1,
    )
    const selected = d
      .query(
        'SELECT record_id FROM project_lens_profile WHERE project_record_id=? AND lens_record_id IS ? AND axis=? AND space_id IS ?',
      )
      .get(project.recordId, selectedLensRecordId, axis, spaceId) as { record_id: string }
    d.query(`INSERT INTO project_lens_profile_revision
    (record_id,space_id,selection_record_id,prior_profile_name,prior_selected_version,prior_selected_version_id,reason,session_id,at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      hosted?.revision.id ?? newRecordId(),
      spaceId,
      selected.record_id,
      prior?.profile_name ?? null,
      prior?.selected_version ?? null,
      hosted?.revision.priorSelectedVersionId ?? prior?.selected_version_id ?? null,
      selection.reason,
      sessionId(),
      nowIso(),
    )
  }, d)
  rememberProjectSpace(d, project.name, spaceId)
  return {
    project: project.name,
    lens: selection.lensId ?? null,
    axis,
    name: selection.name,
    version: selection.version ?? null,
    reason: selection.reason,
  }
}

export async function selectProjectProfile(input: SelectProjectProfileInput) {
  writableDb()
  const axis = validateSelectionInput(input)
  const d = db()
  const project = projectByName(input.project)
  if (!project) throw new Error(`no project "${input.project}"`)
  const profileSpaceId = lensProfileSpace(project.name, d)
  const writeLocal = (spaceId: string | null, hosted?: RecordProjectLensSelectionResponse) =>
    writeProjectProfileSelectionLocal({ d, project, axis, selection: input, spaceId, hosted })
  return applyRecordWriteAuthority({
    local: () => writeLocal(profileSpaceId),
    hosted: async () => {
      const client = recordApiClient()
      const destinationSpaceId = await requireProjectRecordDestination(
        project.name,
        project.settings,
        client,
      )
      const selectedVersionId = validateSelectedProfile(
        d,
        axis,
        input.name,
        input.lensId,
        input.version,
        destinationSpaceId,
      )
      const prior = d
        .query(
          `SELECT s.selection_version FROM project_lens_profile s LEFT JOIN lens l ON l.record_id=s.lens_record_id
           WHERE s.project_record_id=? AND l.id IS ? AND s.axis=? AND s.space_id IS ?`,
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
          selectedVersionId,
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

function resolvedProfile(
  core: CoreRow,
  axis: LensAxis,
  choice: ProfileSelection & { source: LensProfileSource },
  catalogueProfiles: ProfileRow[],
  d: Database,
): ProfileRow {
  const profile = catalogueProfiles.find(
    (candidate) => candidate.axis === axis && candidate.name === choice.name,
  )
  if (profile) return versionedProfile(profile, choice, d)
  if (choice.source !== 'generic')
    throw new Error(
      disabledLensRefusal(core.id, `lens "${core.id}" has no ${axis} profile "${choice.name}"`),
    )
  return {
    record_id: `generic:${core.record_id}:${axis}`,
    lens_record_id: core.record_id,
    lens_id: core.id,
    axis,
    name: 'default',
    version: 1,
    current_version_id: null,
    body: defaultProfileBody(core.slots),
    enabled: 1,
    space_id: core.space_id,
  }
}

export function resolveLens(id: string, projectName: string | null, d: Database = db()) {
  const spaceId = lensProfileSpace(projectName, d)
  const core = d
    .query(`SELECT ${LENS_COLUMNS} FROM lens WHERE id=? AND space_id IS ?`)
    .get(id, spaceId) as CoreRow | null
  if (!core) return null
  if (!core.enabled) throw new Error(disabledLensRefusal(id, `lens "${id}" is disabled`))
  const project = projectName ? projectByName(projectName, d) : null
  const declaredAxes = d
    .query(`SELECT axis FROM (
    SELECT DISTINCT p.axis FROM lens_profile p JOIN lens l ON l.record_id=p.lens_record_id WHERE l.id=? AND p.enabled=1 AND p.space_id IS ?
    UNION
    SELECT DISTINCT s.axis FROM project_lens_profile s LEFT JOIN lens l ON l.record_id=s.lens_record_id
      WHERE s.project_record_id=? AND (l.id=? OR s.lens_record_id IS NULL) AND s.space_id IS ?
  ) ORDER BY axis`)
    .all(id, spaceId, project?.recordId ?? -1, id, spaceId) as { axis: LensAxis }[]
  const axes = declaredAxes.length ? declaredAxes : [{ axis: LENS_AXES[0] }]
  const profiles: (ProfileRow & { source: LensProfileSource })[] = []
  for (const { axis } of axes) {
    const selections = project
      ? (d
          .query(
            `SELECT l.id lens_id,s.profile_name,s.selected_version,s.selected_version_id FROM project_lens_profile s
             LEFT JOIN lens l ON l.record_id=s.lens_record_id
             WHERE s.project_record_id=? AND s.axis=? AND (l.id=? OR s.lens_record_id IS NULL) AND s.space_id IS ?`,
          )
          .all(project.recordId, axis, id, spaceId) as {
          lens_id: string | null
          profile_name: string
          selected_version: number | null
          selected_version_id: string | null
        }[])
      : []
    const selection = (lensId: string | null): ProfileSelection | null => {
      const row = selections.find((candidate) => candidate.lens_id === lensId)
      return row
        ? {
            name: row.profile_name,
            version: row.selected_version,
            versionId: row.selected_version_id,
          }
        : null
    }
    const catalogueProfiles = profileRows(id, d, spaceId)
    const enabledProfileNames = catalogueProfiles
      .filter((profile) => profile.axis === axis && profile.enabled)
      .map((profile) => profile.name)
    const choice = chooseLensProfile({
      lensSelection: selection(id),
      axisSelection: selection(null),
      enabledProfileNames,
      stack: project?.stack ?? null,
    })
    const chosen = resolvedProfile(core, axis, choice, catalogueProfiles, d)
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
