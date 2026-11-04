// concern: board-auto-adoption
/** Decides and attempts safe automatic adoption of an empty local board. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveRecordApiUrl } from '../../../shared/record-api-url.ts'
import { readRecordSessionToken } from '../../../shared/record-session.ts'
import { db } from '../database/db.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import { adoptHostedBoard } from './board-adoption.ts'
import { boardHasAdoptedHosted } from './board-mode.ts'

export type AutomaticBoardAdoptionDecision =
  | { action: 'skip' }
  | { action: 'adopt' }
  | { action: 'tell'; total: number }

export function decideAutomaticBoardAdoption(facts: {
  adopted: boolean
  hostedConfigured: boolean
  signedIn: boolean
  planTotal: number
}): AutomaticBoardAdoptionDecision {
  if (facts.adopted || !facts.hostedConfigured || !facts.signedIn) return { action: 'skip' }
  if (facts.planTotal === 0) return { action: 'adopt' }
  return { action: 'tell', total: facts.planTotal }
}

type Presentation = { log(value: string): void }

export async function automaticallyAdoptHostedBoard(
  presentation: Presentation,
  dependencies: {
    database?: Database
    client?: RecordApiClient
    hostedConfigured?: () => boolean
    signedIn?: () => boolean
  } = {},
): Promise<void> {
  try {
    const database = dependencies.database ?? db()
    const adopted = boardHasAdoptedHosted(database)
    const hostedConfigured =
      dependencies.hostedConfigured?.() ?? Boolean(resolveRecordApiUrl()?.trim())
    const signedIn = dependencies.signedIn?.() ?? Boolean(readRecordSessionToken())
    if (adopted || !hostedConfigured || !signedIn) return

    const plan = await adoptHostedBoard({ database, client: dependencies.client })
    const decision = decideAutomaticBoardAdoption({
      adopted,
      hostedConfigured,
      signedIn,
      planTotal: plan.total,
    })
    if (decision.action === 'adopt') {
      await adoptHostedBoard({ confirm: 0, database, client: dependencies.client })
      presentation.log('board now uses the hosted record')
    } else if (decision.action === 'tell') {
      presentation.log(
        `local board has ${decision.total} rows to upload; run ${PLATFORM_SLUG} board adopt --confirm ${decision.total}`,
      )
    }
  } catch (error) {
    presentation.log(
      `automatic board adoption failed: ${error instanceof Error ? error.message : String(error)}; run ${PLATFORM_SLUG} board adopt`,
    )
  }
}
