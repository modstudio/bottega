import { expect, test } from 'bun:test'
import { releaseClientContractRefusal } from './check-release-client-contract.ts'

test('the current release has a matching record client contract', () => {
  expect(releaseClientContractRefusal('v0.5.13')).toBeNull()
})
