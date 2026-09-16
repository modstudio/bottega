import type { Database } from 'bun:sqlite'
import { db, nowIso, sessionId, writableDb, writeTransaction } from './db.ts'
import { projectByName } from './projects.ts'

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
}
type ProfileRow = {
  id: number
  lens_id: string
  axis: LensAxis
  name: string
  version: number
  body: string
  enabled: number
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
  })
const profileSnapshot = (row: ProfileRow) =>
  JSON.stringify({ body: JSON.parse(row.body), enabled: !!row.enabled })

export function listLenses(database: Database = db()): NonNullable<ReturnType<typeof showLens>>[] {
  return (database.query('SELECT id FROM lens ORDER BY id').all() as { id: string }[]).map(
    ({ id }) => showLens(id, database)!,
  )
}
export function showLens(id: string, database: Database = db()) {
  const row = database.query('SELECT * FROM lens WHERE id=?').get(id) as CoreRow | null
  if (!row) return null
  const profiles = database
    .query('SELECT * FROM lens_profile WHERE lens_id=? ORDER BY axis,name')
    .all(id) as ProfileRow[]
  return {
    ...row,
    enabled: !!row.enabled,
    slots: JSON.parse(row.slots),
    profiles: profiles.map((p) => ({ ...p, enabled: !!p.enabled, body: JSON.parse(p.body) })),
  }
}
export function setLens(input: {
  id: string
  title: string
  question: string
  excludes: string
  slots: string
  enabled: boolean
  reason: string
}) {
  writableDb()
  stableId(input.id, 'lens')
  nonempty(input.title, 'title')
  nonempty(input.question, 'question')
  nonempty(input.excludes, 'excludes')
  nonempty(input.reason, 'reason')
  slotNames(input.slots)
  const d = db()
  writeTransaction(() => {
    const prior = d.query('SELECT * FROM lens WHERE id=?').get(input.id) as CoreRow | null
    if (!prior)
      d.query(
        'INSERT INTO lens (id,title,question,excludes,slots,version,enabled) VALUES (?,?,?,?,?,1,?)',
      ).run(
        input.id,
        input.title,
        input.question,
        input.excludes,
        input.slots,
        input.enabled ? 1 : 0,
      )
    else {
      d.query(
        'INSERT INTO lens_revision (lens_id,version,prior_body,reason,session_id,at) VALUES (?,?,?,?,?,?)',
      ).run(input.id, prior.version, coreSnapshot(prior), input.reason, sessionId(), nowIso())
      d.query(
        'UPDATE lens SET title=?,question=?,excludes=?,slots=?,version=version+1,enabled=? WHERE id=?',
      ).run(
        input.title,
        input.question,
        input.excludes,
        input.slots,
        input.enabled ? 1 : 0,
        input.id,
      )
    }
  }, d)
  return showLens(input.id, d)
}
export function listProfiles(lensId?: string, database: Database = db()) {
  const rows = database
    .query(
      `SELECT * FROM lens_profile ${lensId ? 'WHERE lens_id=?' : ''} ORDER BY lens_id,axis,name`,
    )
    .all(...(lensId ? [lensId] : [])) as ProfileRow[]
  return rows.map((row) => ({ ...row, enabled: !!row.enabled, body: JSON.parse(row.body) }))
}
export function showProfile(lensId: string, axis: string, name: string, database: Database = db()) {
  const row = database
    .query('SELECT * FROM lens_profile WHERE lens_id=? AND axis=? AND name=?')
    .get(lensId, axisValue(axis), name) as ProfileRow | null
  return row ? { ...row, enabled: !!row.enabled, body: JSON.parse(row.body) } : null
}
export function setProfile(input: {
  lensId: string
  axis: string
  name: string
  body: string
  enabled: boolean
  reason: string
}) {
  writableDb()
  nonempty(input.name, 'name')
  nonempty(input.reason, 'reason')
  const axis = axisValue(input.axis)
  const d = db()
  const core = d.query('SELECT * FROM lens WHERE id=?').get(input.lensId) as CoreRow | null
  if (!core) throw new Error(`no lens "${input.lensId}"`)
  profileValues(input.body, core.slots)
  writeTransaction(() => {
    const prior = d
      .query('SELECT * FROM lens_profile WHERE lens_id=? AND axis=? AND name=?')
      .get(input.lensId, axis, input.name) as ProfileRow | null
    if (!prior)
      d.query(
        'INSERT INTO lens_profile (lens_id,axis,name,version,body,enabled) VALUES (?,?,?,1,?,?)',
      ).run(input.lensId, axis, input.name, input.body, input.enabled ? 1 : 0)
    else {
      d.query(
        'INSERT INTO lens_profile_revision (profile_id,version,prior_body,reason,session_id,at) VALUES (?,?,?,?,?,?)',
      ).run(prior.id, prior.version, profileSnapshot(prior), input.reason, sessionId(), nowIso())
      d.query('UPDATE lens_profile SET version=version+1,body=?,enabled=? WHERE id=?').run(
        input.body,
        input.enabled ? 1 : 0,
        prior.id,
      )
    }
  }, d)
  return showProfile(input.lensId, axis, input.name, d)
}

function versionedProfile(profile: ProfileRow, version: number | null, d: Database): ProfileRow {
  if (version === null || version === profile.version) return profile
  const prior = d
    .query('SELECT prior_body FROM lens_profile_revision WHERE profile_id=? AND version=?')
    .get(profile.id, version) as { prior_body: string } | null
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
export function selectProjectProfile(input: {
  project: string
  axis: string
  name: string
  lensId?: string
  version?: number
  reason: string
}) {
  writableDb()
  nonempty(input.reason, 'reason')
  const axis = axisValue(input.axis)
  const d = db()
  const project = projectByName(input.project)
  if (!project) throw new Error(`no project "${input.project}"`)
  if (input.version !== undefined && (!Number.isInteger(input.version) || input.version < 1))
    throw new Error('version must be a positive integer')
  let cores: CoreRow[]
  if (input.lensId) {
    const core = d
      .query('SELECT * FROM lens WHERE id=? AND enabled=1')
      .get(input.lensId) as CoreRow | null
    if (!core) throw new Error(`no enabled lens "${input.lensId}"`)
    cores = [core]
  } else
    cores = d
      .query(
        `SELECT DISTINCT l.* FROM lens l JOIN lens_profile p ON p.lens_id=l.id WHERE l.enabled=1 AND p.axis=? ORDER BY l.id`,
      )
      .all(axis) as CoreRow[]
  const missing: string[] = []
  for (const core of cores) {
    const p = d
      .query('SELECT * FROM lens_profile WHERE lens_id=? AND axis=? AND name=? AND enabled=1')
      .get(core.id, axis, input.name) as ProfileRow | null
    if (!p) {
      missing.push(core.id)
      continue
    }
    try {
      versionedProfile(p, input.version ?? null, d)
    } catch {
      missing.push(core.id)
    }
  }
  if (missing.length)
    throw new Error(
      `profile ${axis}/${input.name}${input.version ? ` version ${input.version}` : ''} is missing or disabled for lenses: ${missing.join(', ')}`,
    )
  if (!cores.length) throw new Error(`no enabled lenses declare axis ${axis}`)
  writeTransaction(() => {
    const prior = d
      .query(
        'SELECT id,profile_name,selected_version FROM project_lens_profile WHERE project_id=? AND lens_id IS ? AND axis=?',
      )
      .get(project.id, input.lensId ?? null, axis) as {
      id: number
      profile_name: string
      selected_version: number | null
    } | null
    d.query(`INSERT INTO project_lens_profile (project_id,lens_id,axis,profile_name,selected_version) VALUES (?,?,?,?,?)
      ON CONFLICT DO UPDATE SET profile_name=excluded.profile_name,selected_version=excluded.selected_version`).run(
      project.id,
      input.lensId ?? null,
      axis,
      input.name,
      input.version ?? null,
    )
    const selection = d
      .query('SELECT id FROM project_lens_profile WHERE project_id=? AND lens_id IS ? AND axis=?')
      .get(project.id, input.lensId ?? null, axis) as { id: number }
    d.query(`INSERT INTO project_lens_profile_revision
      (selection_id,prior_profile_name,prior_selected_version,reason,session_id,at) VALUES (?,?,?,?,?,?)`).run(
      selection.id,
      prior?.profile_name ?? null,
      prior?.selected_version ?? null,
      input.reason,
      sessionId(),
      nowIso(),
    )
  }, d)
  return {
    project: project.name,
    lens: input.lensId ?? null,
    axis,
    name: input.name,
    version: input.version ?? null,
    reason: input.reason,
  }
}

const disabledLensRefusal = (id: string, what: string) =>
  `${what}\ninvariant: A disabled catalogue lens or selected profile never dispatches.\ncleared by: enable ${id} or select an enabled profile`

export function resolveLens(id: string, projectName: string | null, d: Database = db()) {
  const core = d.query('SELECT * FROM lens WHERE id=?').get(id) as CoreRow | null
  if (!core) return null
  if (!core.enabled) throw new Error(disabledLensRefusal(id, `lens "${id}" is disabled`))
  const project = projectName ? projectByName(projectName) : null
  const axes = d
    .query(`SELECT axis FROM (
    SELECT DISTINCT axis FROM lens_profile WHERE lens_id=? AND enabled=1
    UNION
    SELECT DISTINCT axis FROM project_lens_profile
      WHERE project_id=? AND (lens_id=? OR lens_id IS NULL)
  ) ORDER BY axis`)
    .all(id, project?.id ?? -1, id) as { axis: LensAxis }[]
  const profiles: ProfileRow[] = []
  for (const { axis } of axes) {
    const selection = project
      ? (d
          .query(
            `SELECT profile_name,selected_version FROM project_lens_profile WHERE project_id=? AND axis=? AND (lens_id=? OR lens_id IS NULL) ORDER BY lens_id IS NULL LIMIT 1`,
          )
          .get(project.id, axis, id) as {
          profile_name: string
          selected_version: number | null
        } | null)
      : null
    const name = selection?.profile_name ?? 'default'
    const profile = d
      .query('SELECT * FROM lens_profile WHERE lens_id=? AND axis=? AND name=?')
      .get(id, axis, name) as ProfileRow | null
    if (!profile)
      throw new Error(disabledLensRefusal(id, `lens "${id}" has no ${axis} profile "${name}"`))
    const chosen = versionedProfile(profile, selection?.selected_version ?? null, d)
    if (!chosen.enabled)
      throw new Error(
        disabledLensRefusal(id, `lens "${id}" selected disabled ${axis} profile "${name}"`),
      )
    profiles.push(chosen)
  }
  const values: Record<string, string> = {}
  for (const profile of profiles)
    for (const [slot, value] of Object.entries(profileValues(profile.body, core.slots))) {
      if (slot in values)
        throw new Error(`lens "${id}" slot "${slot}" is filled by more than one selected profile`)
      values[slot] = value
    }
  const declared = slotNames(core.slots)
  const render = (slot: string) => values[slot] ?? ''
  const body = `QUESTION\n${core.question}\n\nEXCLUDES\n${core.excludes}\n\nFRAMEWORK GUIDANCE\n${render('framework_guidance')}\n\nCOMMANDS\n${render('commands')}`
  return {
    id: core.id,
    title: core.title,
    question: core.question,
    excludes: core.excludes,
    slots: declared.names,
    version: core.version,
    profiles: profiles.map((p) => ({ axis: p.axis, name: p.name, version: p.version })),
    body,
  }
}
