// concern: record-cache
/** Pulls hosted docs and verdicts into the local offline cache. Must not know CLI presentation. */
import type { Database } from 'bun:sqlite'
import { normalizeDocAudiences } from '../../../shared/docs.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { encodeStoredDocAudiences } from '../doc/doc-audiences-codec.ts'
import { projects } from '../project/projects.ts'
import { applySubjectRecord } from '../subject/subjects.ts'
import { recordApiClient } from './record-api-client.ts'
import type { RecordIdentity } from './record-auth.ts'
import { recordCacheSpaceOwnsAddress } from './record-cache-ownership.ts'
import {
  decodeRecordCursor,
  encodeRecordCursor,
  parseStoredRecordCursor,
  type RecordCursor,
} from './record-cursor.ts'
import { recordDocList } from './record-doc-list-shape.ts'
import { RECORD_LENS_TABLES, type RecordLensTable } from './record-lens-catalogue.ts'
import {
  declaredRecordSpace,
  noActiveRecordSpaceRefusal,
  projectRecordDestination,
} from './record-project-destination.ts'
import { rememberSignedInRecordUser } from './record-session.ts'

const DOCS_CURSOR = 'record_docs_cursor'
const SUBJECTS_CURSOR = 'record_subjects_cursor'
const SCORES_CURSOR = 'record_scores_cursor'
const LENS_CURSOR = 'record_lens_cursor'
function readRecordCursor(
  local: Database,
  key: string,
  legacyTimestamp = false,
): RecordCursor | undefined {
  const value = readCursor(local, key)
  if (value === undefined) return undefined
  const parsed = parseStoredRecordCursor(value, legacyTimestamp)
  if ('cursor' in parsed) {
    if (parsed.migrated) writeRecordCursor(local, key, parsed.cursor)
    return parsed.cursor
  }
  throw new Error(`invalid record cache cursor for ${key}`)
}

function writeRecordCursor(local: Database, key: string, cursor: RecordCursor): void {
  writeCursor(local, key, JSON.stringify(cursor))
}

function readCursor(local: Database, key: string): string | undefined {
  return local
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(key)?.value
}

function writeCursor(local: Database, key: string, value: string): void {
  local
    .query(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(key, value)
}

function deleteCursor(local: Database, key: string): void {
  local.query('DELETE FROM schema_meta WHERE key=?').run(key)
}

function recordCacheSpaces(identity: RecordIdentity): {
  spaces: string[]
  projectSpaces: Map<string, string | null>
} {
  if (!identity.activeSpaceId) return { spaces: [], projectSpaces: new Map() }
  const memberships = parseRecordSpaceMemberships(identity.memberships)
  const spaces = new Set([identity.activeSpaceId])
  const projectSpaces = new Map<string, string | null>()
  for (const project of [...projects(), ...projects({ retired: true })]) {
    const destination = projectRecordDestination(
      project.name,
      declaredRecordSpace(project.settings),
      identity.activeSpaceId,
      memberships,
    )
    if ('refused' in destination) {
      projectSpaces.set(project.name, null)
      continue
    }
    projectSpaces.set(project.name, destination.spaceId)
    spaces.add(destination.spaceId)
  }
  return { spaces: [...spaces], projectSpaces }
}

function applyDocPage(
  local: Database,
  items: Record<string, unknown>[],
  ownership: {
    pullingSpaceId: string
    activeSpaceId: string
    projectSpaces: ReadonlyMap<string, string | null>
  },
  unresolvedParents: Map<string, string>,
): { docs: number; skippedDocs: number; cursor?: RecordCursor } {
  let docs = 0
  let skippedDocs = 0
  let cursor: RecordCursor | undefined
  for (const item of items) {
    const owned = recordCacheSpaceOwnsAddress({
      scope: String(item.scope),
      subject: item.subject == null ? null : String(item.subject),
      ...ownership,
    })
    if (owned) {
      applyDoc(local, item, unresolvedParents)
      resolveRememberedParents(local, unresolvedParents)
      docs++
    } else {
      skippedDocs++
    }
    if (typeof item.updatedAt === 'string' && typeof item.id === 'string')
      cursor = { at: item.updatedAt, id: item.id }
  }
  return { docs, skippedDocs, cursor }
}

async function pullDocsForSpace(
  local: Database,
  input: {
    spaceId: string
    activeSpaceId: string
    projectSpaces: ReadonlyMap<string, string | null>
    unresolvedParents: Map<string, string>
  },
): Promise<{ docs: number; skippedDocs: number; cursorKey: string; cursor?: RecordCursor }> {
  const cursorKey = `${DOCS_CURSOR}:${input.spaceId}`
  let cursor = readRecordCursor(local, cursorKey, true)
  if (input.spaceId === input.activeSpaceId && cursor === undefined) {
    const legacy = readCursor(local, DOCS_CURSOR)
    if (legacy !== undefined) {
      writeCursor(local, cursorKey, legacy)
      cursor = readRecordCursor(local, cursorKey, true)
      deleteCursor(local, DOCS_CURSOR)
    }
  }
  let docs = 0
  let skippedDocs = 0
  const client = recordApiClient()
  let requestCursor = cursor ? encodeRecordCursor(cursor) : undefined
  for (;;) {
    const page = await client.listDocs(
      {
        cursor: requestCursor,
        includeDeleted: true,
        limit: 100,
      },
      { destinationSpaceId: input.spaceId },
    )
    if (!page.items.length) break
    writeTransaction(() => {
      const applied = applyDocPage(
        local,
        page.items,
        { ...input, pullingSpaceId: input.spaceId },
        input.unresolvedParents,
      )
      docs += applied.docs
      skippedDocs += applied.skippedDocs
      cursor = page.endCursor ? decodeRecordCursor(page.endCursor) : (applied.cursor ?? cursor)
      if (cursor && input.unresolvedParents.size === 0) writeRecordCursor(local, cursorKey, cursor)
    }, local)
    if (!page.nextCursor) break
    requestCursor = page.nextCursor
  }
  return { docs, skippedDocs, cursorKey, cursor }
}

async function pullDocs(
  local: Database,
  identity: RecordIdentity,
  spaces: readonly string[],
  projectSpaces: ReadonlyMap<string, string | null>,
): Promise<{ docs: number; skippedDocs: number }> {
  let docs = 0
  let skippedDocs = 0
  const cursors = new Map<string, RecordCursor>()
  const unresolvedParents = new Map<string, string>()
  for (const spaceId of spaces) {
    const pulled = await pullDocsForSpace(local, {
      spaceId,
      activeSpaceId: identity.activeSpaceId as string,
      projectSpaces,
      unresolvedParents,
    })
    docs += pulled.docs
    skippedDocs += pulled.skippedDocs
    if (pulled.cursor) cursors.set(pulled.cursorKey, pulled.cursor)
  }
  if (unresolvedParents.size) {
    const links = [...unresolvedParents]
      .map(([child, parent]) => `${child} -> ${parent}`)
      .sort()
      .join(', ')
    throw new Error(
      `record cache could not resolve document parent links ${links}; cleared by: ensure the hosted parent documents are readable and refresh again`,
    )
  }
  for (const [key, cursor] of cursors) writeRecordCursor(local, key, cursor)
  return { docs, skippedDocs }
}

export async function pullRecordCache(local: Database = db()): Promise<{
  docs: number
  skippedDocs: number
  subjects: number
  skippedSubjects: number
  scores: number
  lensCatalogue: number
}> {
  const hasMeta = local
    .query<{ n: number }, []>(
      "SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='schema_meta'",
    )
    .get()
  if (!hasMeta)
    return { docs: 0, skippedDocs: 0, subjects: 0, skippedSubjects: 0, scores: 0, lensCatalogue: 0 }
  const client = recordApiClient()
  const identity = await client.whoami()
  if (!identity.activeSpaceId) throw new Error(noActiveRecordSpaceRefusal())
  rememberSignedInRecordUser(identity.user, local)
  const cache = recordCacheSpaces(identity)
  const pulledSubjects = await pullSubjects(local, cache.spaces, cache.projectSpaces)
  const pulledDocs = await pullDocs(local, identity, cache.spaces, cache.projectSpaces)
  const lensCatalogue = await pullLensCatalogue(local, cache.spaces)
  let scores = 0
  let scoreCursor = readCursor(local, SCORES_CURSOR)
  for (;;) {
    const page = await client.listScores({ updatedSince: scoreCursor, limit: 100 })
    if (!page.items.length) break
    writeTransaction(() => {
      for (const item of page.items) {
        applyScore(local, item)
        scores++
        if (typeof item.updatedAt === 'string') scoreCursor = item.updatedAt
      }
      if (scoreCursor) writeCursor(local, SCORES_CURSOR, scoreCursor)
    }, local)
    if (!page.nextCursor) break
  }
  return { ...pulledDocs, ...pulledSubjects, scores, lensCatalogue }
}

async function pullLensCatalogue(local: Database, spaces: readonly string[]): Promise<number> {
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
  const key = String(item.key)
  const row =
    local.query<{ id: string }, [string]>('SELECT id FROM lens WHERE record_id=?').get(recordId) ??
    local.query<{ id: string }, [string]>('SELECT id FROM lens WHERE id=?').get(key)
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
        'UPDATE lens SET record_id=?,title=?,question=?,excludes=?,slots=?,version=?,enabled=?,requires_execution=? WHERE id=?',
      )
      .run(...values, row.id)
  else
    local
      .query(
        'INSERT INTO lens (record_id,id,title,question,excludes,slots,version,enabled,requires_execution) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(recordId, key, ...values.slice(1))
}

function applyLensRevisionRow(local: Database, item: Record<string, unknown>): void {
  const recordId = String(item.id)
  const parent = local
    .query<{ id: string }, [string]>('SELECT id FROM lens WHERE record_id=?')
    .get(String(item.lensId))
  if (!parent) throw new Error(`record cache could not resolve lens parent ${String(item.lensId)}`)
  const found =
    local
      .query<{ id: number }, [string]>('SELECT id FROM lens_revision WHERE record_id=?')
      .get(recordId) ??
    local
      .query<{ id: number }, [string, number]>(
        'SELECT id FROM lens_revision WHERE lens_id=? AND version=?',
      )
      .get(parent.id, Number(item.version))
  if (found)
    local
      .query(
        'UPDATE lens_revision SET record_id=?,prior_body=?,reason=?,session_id=?,at=? WHERE id=?',
      )
      .run(
        recordId,
        String(item.priorBody),
        String(item.reason),
        nullableText(item.sessionId),
        String(item.at),
        found.id,
      )
  else
    local
      .query(
        'INSERT INTO lens_revision (record_id,lens_id,version,prior_body,reason,session_id,at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        recordId,
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
  const lens = local
    .query<{ id: string }, [string]>('SELECT id FROM lens WHERE record_id=?')
    .get(String(item.lensId))
  if (!lens) throw new Error(`record cache could not resolve lens parent ${String(item.lensId)}`)
  const found =
    local
      .query<{ id: number }, [string]>('SELECT id FROM lens_profile WHERE record_id=?')
      .get(recordId) ??
    local
      .query<{ id: number }, [string, string, string]>(
        'SELECT id FROM lens_profile WHERE lens_id=? AND axis=? AND name=?',
      )
      .get(lens.id, String(item.axis), String(item.name))
  if (found)
    local
      .query('UPDATE lens_profile SET record_id=?,lens_id=?,version=?,body=?,enabled=? WHERE id=?')
      .run(
        recordId,
        lens.id,
        Number(item.version),
        String(item.body),
        item.enabled ? 1 : 0,
        found.id,
      )
  else
    local
      .query(
        'INSERT INTO lens_profile (record_id,lens_id,axis,name,version,body,enabled) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        recordId,
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
  const parent = local
    .query<{ id: number }, [string]>('SELECT id FROM lens_profile WHERE record_id=?')
    .get(String(item.profileId))
  if (!parent)
    throw new Error(`record cache could not resolve lens profile parent ${String(item.profileId)}`)
  const found =
    local
      .query<{ id: number }, [string]>('SELECT id FROM lens_profile_revision WHERE record_id=?')
      .get(recordId) ??
    local
      .query<{ id: number }, [number, number]>(
        'SELECT id FROM lens_profile_revision WHERE profile_id=? AND version=?',
      )
      .get(parent.id, Number(item.version))
  if (found)
    local
      .query(
        'UPDATE lens_profile_revision SET record_id=?,prior_body=?,reason=?,session_id=?,at=? WHERE id=?',
      )
      .run(
        recordId,
        String(item.priorBody),
        String(item.reason),
        nullableText(item.sessionId),
        String(item.at),
        found.id,
      )
  else
    local
      .query(
        'INSERT INTO lens_profile_revision (record_id,profile_id,version,prior_body,reason,session_id,at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        recordId,
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
  const project = local
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE record_id=?')
    .get(String(item.projectId))
  if (!project)
    throw new Error(`record cache could not resolve project parent ${String(item.projectId)}`)
  const lens =
    item.lensId == null
      ? null
      : local
          .query<{ id: string }, [string]>('SELECT id FROM lens WHERE record_id=?')
          .get(String(item.lensId))
  if (item.lensId != null && !lens)
    throw new Error(`record cache could not resolve lens parent ${String(item.lensId)}`)
  const found =
    local
      .query<{ id: number }, [string]>('SELECT id FROM project_lens_profile WHERE record_id=?')
      .get(recordId) ??
    local
      .query<{ id: number }, [string, string | null, string]>(
        'SELECT id FROM project_lens_profile WHERE project_record_id=? AND lens_id IS ? AND axis=?',
      )
      .get(project.record_id, lens?.id ?? null, String(item.axis))
  if (found)
    local
      .query(
        'UPDATE project_lens_profile SET record_id=?,profile_name=?,selected_version=?,selection_version=? WHERE id=?',
      )
      .run(
        recordId,
        String(item.profileName),
        nullableNumber(item.selectedVersion),
        Number(item.selectionVersion),
        found.id,
      )
  else
    local
      .query(
        'INSERT INTO project_lens_profile (record_id,project_record_id,lens_id,axis,profile_name,selected_version,selection_version) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        recordId,
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
  const parent = local
    .query<{ id: number }, [string]>('SELECT id FROM project_lens_profile WHERE record_id=?')
    .get(String(item.selectionId))
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
        'UPDATE project_lens_profile_revision SET prior_profile_name=?,prior_selected_version=?,reason=?,session_id=?,at=? WHERE id=?',
      )
      .run(
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
        'INSERT INTO project_lens_profile_revision (record_id,selection_id,prior_profile_name,prior_selected_version,reason,session_id,at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        recordId,
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

async function pullSubjects(
  local: Database,
  spaces: readonly string[],
  projectSpaces: ReadonlyMap<string, string | null>,
): Promise<{ subjects: number; skippedSubjects: number }> {
  const client = recordApiClient()
  let subjects = 0
  let skippedSubjects = 0
  for (const spaceId of spaces) {
    const cursorKey = `${SUBJECTS_CURSOR}:${spaceId}`
    let cursor = readRecordCursor(local, cursorKey)
    let requestCursor = cursor ? encodeRecordCursor(cursor) : undefined
    for (;;) {
      const page = await client.listProjectSubjects(
        {
          includeRetired: true,
          order: 'updated',
          cursor: requestCursor,
          limit: 100,
        },
        { destinationSpaceId: spaceId },
      )
      if (!page.items.length) break
      writeTransaction(() => {
        for (const row of page.items) {
          if (projectSpaces.get(row.project) !== spaceId) {
            skippedSubjects++
          } else {
            applySubjectRecord(row, local)
            subjects++
          }
          cursor = { at: row.updatedAt, id: row.id }
        }
        if (page.endCursor) cursor = decodeRecordCursor(page.endCursor)
        if (cursor) writeRecordCursor(local, cursorKey, cursor)
      }, local)
      if (!page.nextCursor) break
      requestCursor = page.nextCursor
    }
  }
  return { subjects, skippedSubjects }
}

function resolveRememberedParents(local: Database, unresolved: Map<string, string>): void {
  for (const [childRecordId, parentRecordId] of unresolved) {
    const child = local
      .query<{ id: number }, [string]>('SELECT id FROM doc WHERE record_id=?')
      .get(childRecordId)
    const parent = local
      .query<{ id: number }, [string]>('SELECT id FROM doc WHERE record_id=?')
      .get(parentRecordId)
    if (!child || !parent) continue
    local.query('UPDATE doc SET parent_id=? WHERE id=?').run(parent.id, child.id)
    unresolved.delete(childRecordId)
  }
}

function pulledDocLifecycle(item: Record<string, unknown>): {
  status: string
  kind: string
  replacementSlug: string | null
} {
  // Records from before lifecycle and kind fields existed use the local schema defaults.
  return {
    status: item.status == null ? 'current' : String(item.status),
    kind: item.kind == null ? 'working' : String(item.kind),
    replacementSlug: item.replacementSlug == null ? null : String(item.replacementSlug),
  }
}

function pulledDocAudiences(item: Record<string, unknown>): string {
  const values = Array.isArray(item.audiences)
    ? item.audiences.map(String)
    : [item.audience == null ? 'technical' : String(item.audience)]
  return encodeStoredDocAudiences(normalizeDocAudiences(values))
}

function pulledDocArticleFields(local: Database, item: Record<string, unknown>, recordId: string) {
  const articleSubject =
    item.articleSubject && typeof item.articleSubject === 'object'
      ? (item.articleSubject as Record<string, unknown>)
      : null
  const articleSubjectId = articleSubject?.id == null ? null : String(articleSubject.id)
  const relatedSubjects = recordDocList(item.relatedSubjects, {
    document: recordId,
    column: 'doc.related_subjects',
    optional: true,
  })
  if (relatedSubjects.unwrapped)
    console.warn(`unwrapped hosted document JSON string list: ${recordId} doc.related_subjects`)
  const relatedSubjectIds = relatedSubjects.values.map((value) =>
    String((value as Record<string, unknown>).id),
  )
  const decodedSourceFiles = recordDocList(item.sourceFiles, {
    document: recordId,
    column: 'doc.source_files',
    optional: true,
  })
  if (decodedSourceFiles.unwrapped)
    console.warn(`unwrapped hosted document JSON string list: ${recordId} doc.source_files`)
  const sourceFiles = decodedSourceFiles.values.map(String)
  const checkedAgainstCommit =
    item.checkedAgainstCommit == null ? null : String(item.checkedAgainstCommit)
  const summary = item.summarySource === 'written' ? String(item.summary) : null
  for (const id of [articleSubjectId, ...relatedSubjectIds].filter((value): value is string =>
    Boolean(value),
  )) {
    if (!local.query('SELECT 1 FROM subject WHERE id=?').get(id))
      throw new Error(
        `record cache deferred document ${recordId}: subject ${id} is not local; cleared by: refresh subjects and pull again`,
      )
  }
  return { articleSubjectId, relatedSubjectIds, sourceFiles, checkedAgainstCommit, summary }
}

function syncPulledDocRelatedSubjects(
  local: Database,
  recordId: string,
  relatedSubjectIds: string[],
): void {
  local.query('DELETE FROM doc_related_subject WHERE doc_record_id=?').run(recordId)
  for (const id of relatedSubjectIds)
    local
      .query(
        'INSERT INTO doc_related_subject (id,record_id,doc_record_id,subject_id) VALUES (?,?,?,?)',
      )
      .run(newRecordId(), newRecordId(), recordId, id)
}

function pulledDocParentId(local: Database, parentRecordId: string | null): number | null {
  if (parentRecordId == null) return null
  return (
    local
      .query<{ id: number }, [string]>('SELECT id FROM doc WHERE record_id=?')
      .get(parentRecordId)?.id ?? null
  )
}

function applyDoc(
  local: Database,
  item: Record<string, unknown>,
  unresolvedParents: Map<string, string>,
): void {
  const recordId = String(item.id)
  const deletedAt = item.deletedAt == null ? null : String(item.deletedAt)
  if (deletedAt) {
    unresolvedParents.delete(recordId)
    local.query('DELETE FROM doc WHERE record_id=?').run(recordId)
    return
  }
  const scope = String(item.scope)
  const subject = item.subject == null ? null : String(item.subject)
  const owner = item.owner == null ? null : String(item.owner)
  const slug = String(item.slug)
  const title = String(item.title)
  const body = String(item.body)
  const delivery = String(item.delivery)
  // A record that predates the tree fields omits them; such a document is technical and a root.
  const audiences = pulledDocAudiences(item)
  const position = item.position == null ? 0 : Number(item.position)
  const featured = item.featured == null ? false : Boolean(item.featured)
  const { status, kind, replacementSlug } = pulledDocLifecycle(item)
  const form = item.form == null ? null : String(item.form)
  const { articleSubjectId, relatedSubjectIds, sourceFiles, checkedAgainstCommit, summary } =
    pulledDocArticleFields(local, item, recordId)
  const parentRecordId = item.parentId == null ? null : String(item.parentId)
  const parentId = pulledDocParentId(local, parentRecordId)
  if (parentRecordId && parentId == null) unresolvedParents.set(recordId, parentRecordId)
  else unresolvedParents.delete(recordId)
  const updatedAt = String(item.updatedAt ?? nowIso())
  const createdAt = String(item.createdAt ?? updatedAt)
  const existing = local
    .query<{ id: number }, [string]>('SELECT id FROM doc WHERE record_id=?')
    .get(recordId)
  if (existing) {
    local
      .query(
        'UPDATE doc SET title=?, body=?, delivery=?, audiences=?, parent_id=?, position=?, featured=?, status=?, kind=?, form=?, article_subject_id=?, source_files=?, checked_against_commit=?, summary=?, replacement_slug=?, updated_at=?, subject=?, owner=? WHERE id=?',
      )
      .run(
        title,
        body,
        delivery,
        audiences,
        parentId,
        position,
        featured,
        status,
        kind,
        form,
        articleSubjectId,
        JSON.stringify(sourceFiles),
        checkedAgainstCommit,
        summary,
        replacementSlug,
        updatedAt,
        subject,
        owner,
        existing.id,
      )
    syncPulledDocRelatedSubjects(local, recordId, relatedSubjectIds)
    return
  }
  const byAddress = local
    .query<{ id: number }, [string, string | null, string | null, string]>(
      'SELECT id FROM doc WHERE scope=? AND subject IS ? AND owner IS ? AND slug=?',
    )
    .get(scope, subject, owner, slug)
  if (byAddress) {
    local
      .query(
        'UPDATE doc SET title=?, body=?, delivery=?, audiences=?, parent_id=?, position=?, featured=?, status=?, kind=?, form=?, article_subject_id=?, source_files=?, checked_against_commit=?, summary=?, replacement_slug=?, updated_at=?, record_id=? WHERE id=?',
      )
      .run(
        title,
        body,
        delivery,
        audiences,
        parentId,
        position,
        featured,
        status,
        kind,
        form,
        articleSubjectId,
        JSON.stringify(sourceFiles),
        checkedAgainstCommit,
        summary,
        replacementSlug,
        updatedAt,
        recordId,
        byAddress.id,
      )
    syncPulledDocRelatedSubjects(local, recordId, relatedSubjectIds)
    return
  }
  local
    .query(
      `INSERT INTO doc (scope, subject, owner, project_record_id, slug, title, body, delivery, audiences, parent_id, position, featured, status, kind, form, article_subject_id, source_files, checked_against_commit, summary, replacement_slug, created_at, updated_at, record_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      scope,
      subject,
      owner,
      null,
      slug,
      title,
      body,
      delivery,
      audiences,
      parentId,
      position,
      featured,
      status,
      kind,
      form,
      articleSubjectId,
      JSON.stringify(sourceFiles),
      checkedAgainstCommit,
      summary,
      replacementSlug,
      createdAt,
      updatedAt,
      recordId,
    )
  syncPulledDocRelatedSubjects(local, recordId, relatedSubjectIds)
}

function applyScore(local: Database, item: Record<string, unknown>): void {
  const runId = String(item.runId)
  const localRun = local
    .query<{ id: number }, [string]>('SELECT id FROM run WHERE record_id=?')
    .get(runId)
  if (!localRun) return
  if (Object.hasOwn(item, 'evidenceExcluded')) {
    local
      .query('UPDATE run SET evidence_excluded=? WHERE id=?')
      .run(item.evidenceExcluded == null ? null : String(item.evidenceExcluded), localRun.id)
  }
  if (item.delivery == null) return
  local
    .query(
      `INSERT INTO score (record_id, run_id, delivery, quality, fidelity, note, scored_at, scored_by)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(run_id) DO UPDATE SET delivery=excluded.delivery, quality=excluded.quality,
         fidelity=excluded.fidelity, note=excluded.note, scored_at=excluded.scored_at`,
    )
    .run(
      newRecordId(),
      localRun.id,
      String(item.delivery),
      item.quality == null ? null : String(item.quality),
      item.fidelity == null ? null : String(item.fidelity),
      item.note == null ? null : String(item.note),
      String(item.scoredAt ?? nowIso()),
      String(item.scoredBy ?? 'record'),
    )
}
