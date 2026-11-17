import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import {
  HostedApiUpgradeRequiredError,
  outboxHeldForUpgradeLikePattern,
  outboxHeldUnknownColumns,
} from './outbox-held-contract.ts'

test('the held error message matches the reader pattern', () => {
  const database = new Database(':memory:')
  const reason = new HostedApiUpgradeRequiredError('run', ['futureColumn']).message
  expect(
    database
      .query<{ matches: number }, [string, string]>('SELECT ? LIKE ? AS matches')
      .get(reason, outboxHeldForUpgradeLikePattern()),
  ).toEqual({ matches: 1 })
  database.close()
})

test('an unknown-kind hold does not report unknown columns', () => {
  const reason = HostedApiUpgradeRequiredError.unknownKind('kind_from_a_newer_client').message
  expect(reason).toStartWith('outbox-held-for-upgrade:')
  expect(reason).toContain('kind_from_a_newer_client')
  expect(outboxHeldUnknownColumns(reason)).toBe('unknown')
})
