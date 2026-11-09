// concern: cleanup sweep session context
/** Expires context items after their session owner has been gone for the shared owner window. */

import type { Database } from 'bun:sqlite'
import { db, writableDb } from '../database/db.ts'
import {
  dropSessionContextItemsForLifecycle,
  sessionContextHolders,
} from '../doc/context-service.ts'
import { listDocsStore } from '../doc/doc-read-store.ts'
import { parseResumeFrontmatter } from '../doc/doc-resume-frontmatter.ts'
import { latestStoredDocAuthorSession } from '../doc/doc-revision-store.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { ownerIsGone, UNJUDGED_OWNER_WINDOW_MS } from './cleanup-sweep-decisions.ts'
import { gatherOwnerActivity } from './owner-activity.ts'

function hasUnconsumedResumeBrief(database: Database, session: string): boolean {
  return listDocsStore({ scope: 'resume' }, database).some((doc) => {
    if (parseResumeFrontmatter(doc.body)?.status !== 'open') return false
    return latestStoredDocAuthorSession(doc.record_id, database) === session
  })
}

export async function sweepSessionContext(input: {
  enabled: boolean
  dryRun: boolean
  database?: Database
  presentation: CleanupPresentation
}): Promise<boolean> {
  if (!input.enabled) return false
  const database = input.database ?? (input.dryRun ? db() : writableDb())
  let failed = false
  for (const holder of sessionContextHolders(database)) {
    if (hasUnconsumedResumeBrief(database, holder.session)) continue
    const activity = gatherOwnerActivity(database, {
      ownerSessionId: holder.session,
      holderActivityAt: holder.updatedAt,
    })
    const gone = ownerIsGone({
      ...activity,
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
  for (const drop of await dropSessionContextItemsForLifecycle({
    session: holder.session,
    items: holder.items,
    reason: `machine sweep owner gone past ${UNJUDGED_OWNER_WINDOW_MS}ms`,
    dryRun: input.dryRun,
  })) {
    const label = `${holder.holder}/${drop.item.id} (${drop.item.kind})`
    if (input.dryRun && drop.error === null) input.presentation.log(`would drop context ${label}`)
    else if (drop.removed) input.presentation.log(`dropped context ${label}`)
    else if (drop.error) {
      failed = true
      input.presentation.error(`context drop failed ${label}: ${drop.error}`)
    }
  }
  return failed
}
