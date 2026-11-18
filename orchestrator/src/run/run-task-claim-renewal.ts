// concern: run task claim renewal
/** Keeps run lifecycle services independent of the board-backed claim adapter. */

import type { Database } from 'bun:sqlite'

export type RenewTaskClaim = (
  launchKey: string | null,
  session: string | null | undefined,
) => Promise<void>

export async function renewTaskClaimBestEffort(
  renew: RenewTaskClaim | undefined,
  launchKey: string | null,
  session: string | null | undefined,
  event: 'start' | 'continue' | 'answer' | 'terminal',
): Promise<void> {
  if (!renew || !launchKey || !session) return
  try {
    await renew(launchKey, session)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`warning: ${event} did not renew task claim ${launchKey}: ${detail}`)
  }
}

export async function renewStartedClaim(
  database: Database,
  renew: RenewTaskClaim | undefined,
  claimed: { claim: { id: string }; launchKey: string | null },
): Promise<void> {
  await renewRunOwnerClaim(database, renew, claimed.claim.id, claimed.launchKey, 'start')
}

export async function renewRunOwnerClaim(
  database: Database,
  renew: RenewTaskClaim | undefined,
  runId: string,
  launchKey: string | null,
  event: 'start' | 'terminal',
): Promise<void> {
  const owner = database
    .query<{ session_id: string | null }, [string]>('SELECT session_id FROM run WHERE record_id=?')
    .get(runId)?.session_id
  await renewTaskClaimBestEffort(renew, launchKey, owner, event)
}
