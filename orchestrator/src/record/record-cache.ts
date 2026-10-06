// concern: record-cache
/** Pulls hosted docs and verdicts into the local offline cache. Must not know CLI presentation. */
import type { Database } from 'bun:sqlite'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { recordApiClient } from './record-api-client.ts'

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

export async function pullRecordCache(
  local: Database = db(),
): Promise<{ docs: number; scores: number }> {
  const hasMeta = local
    .query<{ n: number }, []>(
      "SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='schema_meta'",
    )
    .get()
  if (!hasMeta) return { docs: 0, scores: 0 }
  const client = recordApiClient()
  let docs = 0
  let cursor = readCursor(local, DOCS_CURSOR)
  const unresolvedParents = new Map<string, string>()
  for (;;) {
    const page = await client.listDocs({
      updatedSince: cursor,
      includeDeleted: true,
      limit: 100,
    })
    if (!page.items.length) break
    writeTransaction(() => {
      for (const item of page.items) {
        applyDoc(local, item, unresolvedParents)
        resolveRememberedParents(local, unresolvedParents)
        docs++
        if (typeof item.updatedAt === 'string') cursor = item.updatedAt
      }
    }, local)
    if (!page.nextCursor) break
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
  if (cursor) writeCursor(local, DOCS_CURSOR, cursor)
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
  return { docs, scores }
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
        'UPDATE doc SET title=?, body=?, delivery=?, audience=?, parent_id=?, position=?, updated_at=?, subject=?, owner=? WHERE id=?',
      )
      .run(
        title,
        body,
        delivery,
        audience,
        parentId,
        position,
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
        'UPDATE doc SET title=?, body=?, delivery=?, audience=?, parent_id=?, position=?, updated_at=?, record_id=? WHERE id=?',
      )
      .run(title, body, delivery, audience, parentId, position, updatedAt, recordId, byAddress.id)
    return
  }
  local
    .query(
      `INSERT INTO doc (scope, subject, owner, project_id, slug, title, body, delivery, audience, parent_id, position, created_at, updated_at, record_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
