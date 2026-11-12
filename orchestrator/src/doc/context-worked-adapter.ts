// concern: context-worked-adapter
/** Gathers session work rows and persists their compact fact through the context service. */

import type { Database } from 'bun:sqlite'
import { claimsOfSession } from '../board/board-claim-service.ts'
import { db } from '../database/db.ts'
import { setContextItem } from './context-service.ts'
import { sessionWorkEvents } from './context-session-work-adapter.ts'
import {
  renderWorkedTaskKeys,
  WORKED_CONTEXT_ID,
  WORKED_CONTEXT_KIND,
  type WorkedTaskFacts,
  workedTaskKeys,
} from './context-worked.ts'
import { CONTEXT_ITEM_MAX_CHARS } from './doc-context-write.ts'

function workedTaskFacts(session: string, database: Database = db()): WorkedTaskFacts {
  const events = sessionWorkEvents(session, database)
  const claims = claimsOfSession(session, database)
    .filter((claim) => claim.subject.kind === 'task')
    .map((claim) => ({
      key: claim.subject.value,
      at: claim.closedAt ?? claim.renewedAt ?? claim.takenAt,
    }))
  events.push(...claims)
  return { events }
}

export function sessionWorkedTaskKeys(session: string, database: Database = db()): string[] {
  return workedTaskKeys(workedTaskFacts(session, database))
}

export async function recordSessionWorked(
  session: string,
  keys: readonly string[],
  source: string,
): Promise<{ body: string | null }> {
  const body = renderWorkedTaskKeys(keys, CONTEXT_ITEM_MAX_CHARS.fact)
  if (body)
    await setContextItem({
      session,
      id: WORKED_CONTEXT_ID,
      kind: WORKED_CONTEXT_KIND,
      source,
      body,
    })
  return { body }
}
