// concern: cleanup sweep session context
/** Expires context items after their session owner has been gone for the shared owner window. */

import type { Database } from 'bun:sqlite'
import { db, writableDb } from '../database/db.ts'
import { contextItemReadSourceFor } from '../doc/context-item-store.ts'
import {
  dropSessionContextItemsForLifecycle,
  sessionContextHolders,
  sessionResumeBriefState,
} from '../doc/context-service.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { ownerIsGone, UNJUDGED_OWNER_WINDOW_MS } from './cleanup-sweep-decisions.ts'
import { gatherOwnerActivity } from './owner-activity.ts'

export type SessionContextSweepDecision = 'drop' | 'keep' | 'not-owned-by-this-install'

/** Keeps hosted holders unless local owner-activity facts establish this install's ownership. */
export function decideSessionContextSweep(input: {
  readSource: 'local' | 'hosted'
  localOwnerEvidence: boolean
  ownerGone: boolean
  hasUnconsumedResumeBrief: boolean
}): SessionContextSweepDecision {
  if (input.readSource === 'hosted' && !input.localOwnerEvidence) return 'not-owned-by-this-install'
  if (input.hasUnconsumedResumeBrief || !input.ownerGone) return 'keep'
  return 'drop'
}

export function sessionContextOwnershipLine(count: number): string {
  return `session context: kept ${count} holder${count === 1 ? '' : 's'} not owned by this install`
}

function sessionContextResumeUnreadableLine(count: number): string {
  return `session context: kept ${count} holder${count === 1 ? '' : 's'} because hosted resume briefs could not be read`
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
  let notOwned = 0
  let resumeUnreadable = 0
  const readSource = contextItemReadSourceFor(database)
  for (const holder of await sessionContextHolders(database)) {
    const activity = gatherOwnerActivity(database, {
      ownerSessionId: holder.session,
      holderActivityAt: holder.updatedAt,
    })
    const gone = ownerIsGone({
      ...activity,
      now: Date.now(),
      windowMs: UNJUDGED_OWNER_WINDOW_MS,
    })
    if (readSource === 'hosted' && !activity.localOwnerEvidence) {
      notOwned++
      continue
    }
    const resumeBrief = await sessionResumeBriefState(readSource, database, holder.session)
    if (resumeBrief === 'unreadable') resumeUnreadable++
    const decision = decideSessionContextSweep({
      readSource,
      localOwnerEvidence: activity.localOwnerEvidence,
      ownerGone: gone,
      hasUnconsumedResumeBrief: resumeBrief !== 'absent',
    })
    if (decision === 'not-owned-by-this-install') continue
    if (decision === 'drop' && (await dropSweptHolder(input, holder))) failed = true
  }
  if (notOwned) input.presentation.log(sessionContextOwnershipLine(notOwned))
  if (resumeUnreadable) input.presentation.log(sessionContextResumeUnreadableLine(resumeUnreadable))
  return failed
}

async function dropSweptHolder(
  input: Parameters<typeof sweepSessionContext>[0],
  holder: Awaited<ReturnType<typeof sessionContextHolders>>[number],
): Promise<boolean> {
  let failed = false
  for (const drop of await dropSessionContextItemsForLifecycle({
    session: holder.session,
    items: holder.items,
    reason: `machine sweep owner gone past ${UNJUDGED_OWNER_WINDOW_MS}ms`,
    dryRun: input.dryRun,
  })) {
    const label = `${holder.holder}/${drop.item.id} (${drop.item.kind})`
    if (drop.outcome === 'would-drop') input.presentation.log(`would drop context ${label}`)
    else if (drop.outcome === 'dropped') input.presentation.log(`dropped context ${label}`)
    else if (drop.outcome === 'already-absent')
      input.presentation.log(`context already absent ${label}`)
    else if (drop.outcome === 'failed' && drop.error) {
      failed = true
      input.presentation.error(`context drop failed ${label}: ${drop.error}`)
    }
  }
  return failed
}
