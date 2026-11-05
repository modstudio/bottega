// concern: outbox-prune
/** Removes delivered outbox history only after a later delivered row supersedes it. */

import type { Database } from 'bun:sqlite'
import { writeTransaction } from '../database/db.ts'
import {
  supersededOutboxCountSql,
  supersededOutboxProbeSql,
  supersededOutboxSelectionSql,
} from './outbox-prune-query.ts'

export type OutboxPruneOptions = {
  limit: number
  dryRun?: boolean
  identity?: { kind: string; rowId: string }
}

export type OutboxPruneResult = { deleted: number; more: boolean }

export type OutboxPruneDrainOptions = { timeBoundMs?: number }

export const OUTBOX_PRUNE_CHUNK_SIZE = 5_000

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('outbox prune limit must be a positive safe integer')
}

function identityArgs(options: OutboxPruneOptions): readonly string[] {
  return options.identity ? [options.identity.kind, options.identity.rowId] : []
}

function pruneInCurrentWrite(database: Database, options: OutboxPruneOptions): OutboxPruneResult {
  const args = identityArgs(options)
  const selected = database
    .query<{ id: number }, (string | number)[]>(
      supersededOutboxSelectionSql(Boolean(options.identity)),
    )
    .all(...args, options.limit)
  if (selected.length > 0) {
    const remove = database.query('DELETE FROM outbox WHERE id=?')
    for (const row of selected) remove.run(row.id)
  }
  const more = Boolean(
    database
      .query<{ id: number }, string[]>(supersededOutboxProbeSql(Boolean(options.identity)))
      .get(...args),
  )
  return { deleted: selected.length, more }
}

export function pruneSupersededOutboxRows(
  database: Database,
  options: OutboxPruneOptions,
): OutboxPruneResult {
  validateLimit(options.limit)
  if (options.dryRun) {
    const count = database
      .query<{ count: number }, string[]>(supersededOutboxCountSql(Boolean(options.identity)))
      .get(...identityArgs(options))!.count
    // A dry run reports whether any work exists; it makes no bounded backlog claim.
    return { deleted: count, more: count > 0 }
  }
  const prune = () => pruneInCurrentWrite(database, options)
  return database.inTransaction ? prune() : writeTransaction(prune, database)
}

/** Drains chunks until no eligible rows remain or the optional time bound expires. */
export function drainSupersededOutboxRows(
  database: Database,
  options: OutboxPruneDrainOptions = {},
): OutboxPruneResult {
  const started = performance.now()
  let deleted = 0
  let more = false
  do {
    const result = pruneSupersededOutboxRows(database, { limit: OUTBOX_PRUNE_CHUNK_SIZE })
    deleted += result.deleted
    more = result.more
  } while (
    more &&
    (options.timeBoundMs === undefined || performance.now() - started < options.timeBoundMs)
  )
  return { deleted, more }
}
