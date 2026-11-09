// concern: context-stale-adapter
/** Gathers session work and next-action revision facts for stale context policy. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { type CursorTrailEntry, isClosedStep } from '../workflow/workflow-cursor-trail.ts'
import { decodeContextItem } from './context-item-codec.ts'
import { type ContextWorkEvent, staleContextHolders } from './context-stale.ts'

type KeyAt = { key: string | null; at: string }
type CursorWork = { key: string; closed: string }
type StoredContext = { subject: string; slug: string; body: string; updated_at: string }

export function staleContextForSession(session: string, database: Database = db()) {
  const work: ContextWorkEvent[] = []
  const add = ({ key, at }: KeyAt) => {
    if (key?.trim()) work.push({ holder: key, at })
  }
  for (const row of database
    .query<KeyAt, [string]>(
      'SELECT launch_key key,started_at at FROM run WHERE session_id=? AND launch_key IS NOT NULL',
    )
    .all(session))
    add(row)
  for (const row of database
    .query<CursorWork, [string]>(
      "SELECT workflow_key key,closed FROM workflow_cursor WHERE session_id=? AND workflow_key<>''",
    )
    .all(session)) {
    for (const entry of JSON.parse(row.closed) as CursorTrailEntry[])
      if (isClosedStep(entry)) add({ key: row.key, at: entry.at })
  }
  for (const row of database
    .query<KeyAt, [string]>(
      `SELECT COALESCE(q.workflow_key,r.launch_key) key,q.answered_at at
       FROM question q LEFT JOIN run r ON r.record_id=q.run_record_id
       WHERE q.answered_by=? AND q.answered_at IS NOT NULL`,
    )
    .all(session))
    add(row)

  const revisions = database
    .query<StoredContext, []>(
      "SELECT subject,slug,body,updated_at FROM doc WHERE scope='context' AND subject LIKE 'task:%'",
    )
    .all()
    .filter((row) => decodeContextItem(row.subject, row.slug, row.body).kind === 'next-action')
    .map((row) => ({ holder: row.subject.slice(5), at: row.updated_at }))
  return staleContextHolders(work, revisions)
}
