// concern: record-cache
/** Pulls hosted docs and verdicts into the local offline cache. Must not know CLI presentation. */
import type { Database } from 'bun:sqlite'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { projects } from '../project/projects.ts'
import { recordApiClient } from './record-api-client.ts'
import type { RecordIdentity } from './record-auth.ts'
import { recordCacheSpaceOwnsAddress } from './record-cache-ownership.ts'
import { declaredRecordSpace, projectRecordDestination } from './record-project-destination.ts'

const DOCS_CURSOR = 'record_docs_cursor'
const SCORES_CURSOR = 'record_scores_cursor'

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
): { docs: number; skippedDocs: number; cursor?: string } {
  let docs = 0
  let skippedDocs = 0
  let cursor: string | undefined
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
    if (typeof item.updatedAt === 'string') cursor = item.updatedAt
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
): Promise<{ docs: number; skippedDocs: number; cursorKey: string; cursor?: string }> {
  const cursorKey = `${DOCS_CURSOR}:${input.spaceId}`
  let cursor = readCursor(local, cursorKey)
  if (input.spaceId === input.activeSpaceId && cursor === undefined) {
    const legacy = readCursor(local, DOCS_CURSOR)
    if (legacy !== undefined) {
      cursor = legacy
      writeCursor(local, cursorKey, legacy)
      deleteCursor(local, DOCS_CURSOR)
    }
  }
  let docs = 0
  let skippedDocs = 0
  const client = recordApiClient()
  for (;;) {
    const page = await client.listDocs(
      { updatedSince: cursor, includeDeleted: true, limit: 100 },
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
      cursor = applied.cursor ?? cursor
    }, local)
    if (!page.nextCursor) break
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
  const cursors = new Map<string, string>()
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
  for (const [key, cursor] of cursors) writeCursor(local, key, cursor)
  return { docs, skippedDocs }
}

export async function pullRecordCache(
  local: Database = db(),
): Promise<{ docs: number; skippedDocs: number; scores: number }> {
  const hasMeta = local
    .query<{ n: number }, []>(
      "SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='schema_meta'",
    )
    .get()
  if (!hasMeta) return { docs: 0, skippedDocs: 0, scores: 0 }
  const client = recordApiClient()
  const identity = await client.whoami()
  const cache = recordCacheSpaces(identity)
  const pulledDocs = await pullDocs(local, identity, cache.spaces, cache.projectSpaces)
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
  return { ...pulledDocs, scores }
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
  const audience = item.audience == null ? 'technical' : String(item.audience)
  const position = item.position == null ? 0 : Number(item.position)
  const featured = item.featured == null ? false : Boolean(item.featured)
  const parentRecordId = item.parentId == null ? null : String(item.parentId)
  const parentId: number | null =
    parentRecordId == null
      ? null
      : (local
          .query<{ id: number }, [string]>('SELECT id FROM doc WHERE record_id=?')
          .get(parentRecordId)?.id ?? null)
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
        'UPDATE doc SET title=?, body=?, delivery=?, audience=?, parent_id=?, position=?, featured=?, updated_at=?, subject=?, owner=? WHERE id=?',
      )
      .run(
        title,
        body,
        delivery,
        audience,
        parentId,
        position,
        featured,
        updatedAt,
        subject,
        owner,
        existing.id,
      )
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
        'UPDATE doc SET title=?, body=?, delivery=?, audience=?, parent_id=?, position=?, featured=?, updated_at=?, record_id=? WHERE id=?',
      )
      .run(
        title,
        body,
        delivery,
        audience,
        parentId,
        position,
        featured,
        updatedAt,
        recordId,
        byAddress.id,
      )
    return
  }
  local
    .query(
      `INSERT INTO doc (scope, subject, owner, project_id, slug, title, body, delivery, audience, parent_id, position, featured, created_at, updated_at, record_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      audience,
      parentId,
      position,
      featured,
      createdAt,
      updatedAt,
      recordId,
    )
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
      `INSERT INTO score (run_id, delivery, quality, fidelity, note, scored_at, scored_by)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(run_id) DO UPDATE SET delivery=excluded.delivery, quality=excluded.quality,
         fidelity=excluded.fidelity, note=excluded.note, scored_at=excluded.scored_at`,
    )
    .run(
      localRun.id,
      String(item.delivery),
      item.quality == null ? null : String(item.quality),
      item.fidelity == null ? null : String(item.fidelity),
      item.note == null ? null : String(item.note),
      String(item.scoredAt ?? nowIso()),
      String(item.scoredBy ?? 'record'),
    )
}
