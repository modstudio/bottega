// concern: outbox-prune
/** Removes delivered outbox history only after a later delivered row supersedes it. */

import type { Database } from 'bun:sqlite'
import { writeTransaction } from '../database/db.ts'
import { OUTBOX_PAYLOAD_RETENTION_MS, RELEASED_OUTBOX_PAYLOAD } from './outbox-prune-payload.ts'
import {
  deliveredUnprotectedOutboxDeleteSql,
  releasableOutboxPayloadCountSql,
  releasableOutboxPayloadProbeSql,
  releasableOutboxPayloadSelectionSql,
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

export type OutboxPayloadReleaseOptions = { now: number; limit: number; dryRun?: boolean }
export type OutboxPayloadReleaseResult = { released: number; more: boolean }
export type OutboxPayloadReleaseDrainOptions = { now: number; timeBoundMs?: number }

export const OUTBOX_PRUNE_CHUNK_SIZE = 5_000

/** Deletes one identity's delivered, unprotected rows inside the caller's transaction. */
export function deleteDeliveredUnprotectedOutboxRows(
  database: Database,
  kind: string,
  rowId: string,
): number {
  return database
    .query<never, [string, string]>(deliveredUnprotectedOutboxDeleteSql)
    .run(kind, rowId).changes
}

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

function payloadReleaseArgs(now: number): [string, string] {
  return [new Date(now - OUTBOX_PAYLOAD_RETENTION_MS).toISOString(), RELEASED_OUTBOX_PAYLOAD]
}

export function releaseDeliveredOutboxPayloads(
  database: Database,
  options: OutboxPayloadReleaseOptions,
): OutboxPayloadReleaseResult {
  validateLimit(options.limit)
  const args = payloadReleaseArgs(options.now)
  if (options.dryRun) {
    const count = database
      .query<{ count: number }, [string, string]>(releasableOutboxPayloadCountSql)
      .get(...args)!.count
    return { released: count, more: count > 0 }
  }
  const release = (): OutboxPayloadReleaseResult => {
    const selected = database
      .query<{ id: number }, [string, string, number]>(releasableOutboxPayloadSelectionSql)
      .all(...args, options.limit)
    const update = database.query('UPDATE outbox SET payload=? WHERE id=?')
    for (const row of selected) update.run(RELEASED_OUTBOX_PAYLOAD, row.id)
    const more = Boolean(
      database
        .query<{ id: number }, [string, string]>(releasableOutboxPayloadProbeSql)
        .get(...args),
    )
    return { released: selected.length, more }
  }
  return database.inTransaction ? release() : writeTransaction(release, database)
}

/** Drains payload-release chunks until no eligible rows remain or the time bound expires. */
export function drainDeliveredOutboxPayloads(
  database: Database,
  options: OutboxPayloadReleaseDrainOptions,
): OutboxPayloadReleaseResult {
  const started = performance.now()
  let released = 0
  let more = false
  do {
    const result = releaseDeliveredOutboxPayloads(database, {
      now: options.now,
      limit: OUTBOX_PRUNE_CHUNK_SIZE,
    })
    released += result.released
    more = result.more
  } while (
    more &&
    (options.timeBoundMs === undefined || performance.now() - started < options.timeBoundMs)
  )
  return { released, more }
}
