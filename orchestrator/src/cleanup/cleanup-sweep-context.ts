// concern: cleanup sweep session context
/** Expires context items after their session owner has been gone for the shared owner window. */

import type { Database } from 'bun:sqlite'
import {
  dropSessionContextItemForLifecycle,
  sessionContextHolders,
} from '../doc/context-service.ts'
import type { CleanupPresentation } from './cleanup.ts'
import {
  shouldDropSweptSessionContext,
  UNJUDGED_OWNER_WINDOW_MS,
} from './cleanup-sweep-decisions.ts'

function sessionActivity(database: Database, session: string, fallback: string) {
  const seen = database
    .query('SELECT last_seen FROM session_seen WHERE session_id=?')
    .get(session) as { last_seen: string } | null
  const run = database
    .query('SELECT MAX(COALESCE(last_event_at,started_at)) AS at FROM run WHERE session_id=?')
    .get(session) as { at: string | null }
  return {
    ownerLastSeenAt: seen ? Date.parse(seen.last_seen) : null,
    runLastActivityAt: Date.parse(run.at ?? fallback),
  }
}

export async function sweepSessionContext(input: {
  enabled: boolean
  dryRun: boolean
  database: Database
  presentation: CleanupPresentation
}): Promise<boolean> {
  if (!input.enabled) return false
  let failed = false
  for (const holder of sessionContextHolders(input.database)) {
    const gone = shouldDropSweptSessionContext({
      ownerSessionId: holder.session,
      ...sessionActivity(input.database, holder.session, holder.updatedAt),
      now: Date.now(),
      windowMs: UNJUDGED_OWNER_WINDOW_MS,
    })
    if (gone && (await dropSweptHolder(input, holder))) failed = true
  }
  return failed
}

async function dropSweptHolder(
  input: Parameters<typeof sweepSessionContext>[0],
  holder: ReturnType<typeof sessionContextHolders>[number],
): Promise<boolean> {
  let failed = false
  for (const item of holder.items) {
    if (input.dryRun) input.presentation.log(`would drop context ${holder.holder}/${item.id}`)
    else
      try {
        await dropSessionContextItemForLifecycle({
          session: holder.session,
          id: item.id,
          expectedRevision: item.revision ?? undefined,
          reason: `machine sweep owner gone past ${UNJUDGED_OWNER_WINDOW_MS}ms`,
        })
        input.presentation.log(`dropped context ${holder.holder}/${item.id}`)
      } catch (error) {
        failed = true
        input.presentation.error(
          `context drop failed ${holder.holder}/${item.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
  }
  return failed
}
