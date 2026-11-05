// concern: record-api-changes
/** Owns validation and long-poll policy for the record change HTTP endpoint. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import {
  decodeRecordChangeCursor,
  encodeRecordChangeCursor,
  MAX_RECORD_CHANGE_PAGE_SIZE,
  type RecordChangeCursor,
} from '../../../shared/record/record-changes.ts'
import { RECORD_CHANGE_SERVED_TABLES } from './record-change-feed.ts'
import type { RecordIdentity } from './record-auth.ts'

export const MAX_RECORD_CHANGE_WAIT_SECONDS = 30

type Environment = { Variables: { identity: RecordIdentity } }
type ReadResult =
  | { resetRequired: true; cursor: RecordChangeCursor; lag: number }
  | { resetRequired: false; cursor: RecordChangeCursor; lag: number; more: boolean; changes: unknown[] }
export type RecordChangeRouteDeps = {
  readChanges(input: { userId: string; spaceId: string; spaceIds: string[]; after: RecordChangeCursor | null; limit: number }): Promise<ReadResult>
  waitForRecordChange(milliseconds: number, signal?: AbortSignal): Promise<void>
}
const integer = (maximum: number) => z.coerce.number().int().min(0).max(maximum)

export function registerRecordChangeRoute(app: Hono<Environment>, deps: RecordChangeRouteDeps) {
  app.get('/v1/changes', async (context: Context<Environment>) => {
    const query = z.object({
      after: z.string().optional(),
      limit: integer(MAX_RECORD_CHANGE_PAGE_SIZE).refine((value) => value > 0).default(MAX_RECORD_CHANGE_PAGE_SIZE),
      wait: integer(MAX_RECORD_CHANGE_WAIT_SECONDS).default(0),
    }).safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'malformed record change cursor, limit, or wait' }, 400)
    let after: RecordChangeCursor | null = null
    if (query.data.after !== undefined) {
      try { after = decodeRecordChangeCursor(query.data.after) }
      catch { return context.json({ error: 'malformed record change cursor, limit, or wait' }, 400) }
    }
    const identity = context.get('identity')
    const spaces = identity.memberships.map((membership) => String(membership.space_id))
    const principal = { userId: identity.user.id, spaceId: spaces[0] ?? identity.personalSpaceId, spaceIds: spaces }
    const read = () => deps.readChanges({ ...principal, after, limit: query.data.limit })
    let result = await read()
    if (result.resetRequired)
      return context.json({ reset: true, cursor: encodeRecordChangeCursor(result.cursor), tables: RECORD_CHANGE_SERVED_TABLES }, 410)
    const deadline = Date.now() + query.data.wait * 1_000
    while (!result.changes.length && Date.now() < deadline && !context.req.raw.signal.aborted) {
      await deps.waitForRecordChange(deadline - Date.now(), context.req.raw.signal)
      if (context.req.raw.signal.aborted) return context.body(null, 499)
      result = await read()
      if (result.resetRequired)
        return context.json({ reset: true, cursor: encodeRecordChangeCursor(result.cursor), tables: RECORD_CHANGE_SERVED_TABLES }, 410)
    }
    return context.json({ changes: result.changes, cursor: encodeRecordChangeCursor(result.cursor), lag: result.lag, more: result.more })
  })
}
