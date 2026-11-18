// concern: terminal run task claim
/** Renews a keyed run's task claim after its terminal row is durable. */

import type { Database } from 'bun:sqlite'
import { claimIdentity } from './run-resume-kind.ts'
import { type RenewTaskClaim, renewRunOwnerClaim } from './run-task-claim-renewal.ts'
import { settleTerminalQuestionState } from './run-terminal-chain.ts'

export async function settleTerminalStateWithClaimRenewal(
  database: Database,
  input: {
    claim: { id: string }
    opts: {
      resume?: { kind: 'continue' | 'fresh-session' | 'retry-root'; parent: string; turn: number }
    }
    renewTaskClaim?: RenewTaskClaim
    launchKey: string | null
  },
  preAnswer: Parameters<typeof settleTerminalQuestionState>[0]['preAnswer'],
) {
  const runId = input.claim.id
  const recorded = await settleTerminalQuestionState({
    database,
    runId,
    rootId: claimIdentity(input.opts.resume).parent_run_record_id ?? runId,
    preAnswer,
  })
  await renewRunOwnerClaim(database, input.renewTaskClaim, runId, input.launchKey, 'terminal')
  return recorded
}
