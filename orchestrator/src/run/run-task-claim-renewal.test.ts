import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { renewStartedClaim } from './run-task-claim-renewal.ts'
import { settleTerminalStateWithClaimRenewal } from './run-terminal-task-claim.ts'

test('start renews the launch key for the run owner', async () => {
  const runId = addRun({ agent: 'codex', job: 'implement', session: 'session-a' })
  const renewed: [string | null, string | null | undefined][] = []

  await renewStartedClaim(
    db(),
    async (key, session) => {
      renewed.push([key, session])
    },
    { claim: { id: runId }, launchKey: 'DEV-2414' },
  )

  expect(renewed).toEqual([['DEV-2414', 'session-a']])
})

test('terminal renews the launch key for the run owner', async () => {
  const runId = addRun({ agent: 'codex', job: 'implement', session: 'session-a' })
  const renewed: [string | null, string | null | undefined][] = []

  await settleTerminalStateWithClaimRenewal(
    db(),
    {
      claim: { id: runId },
      opts: {},
      launchKey: 'DEV-2414',
      renewTaskClaim: async (key, session) => {
        renewed.push([key, session])
      },
    },
    async () => {},
  )

  expect(renewed).toEqual([['DEV-2414', 'session-a']])
})
