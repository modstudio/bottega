import { expect, test } from 'bun:test'
import { releaseClientContractContentsRefusal } from './check-release-client-contract.ts'

test('the release client contract decision refuses missing and differing contents', () => {
  expect(releaseClientContractContentsRefusal('1.2.3', null, 'current')).toContain(
    '1.2.3 is missing',
  )
  expect(releaseClientContractContentsRefusal('1.2.3', 'old', 'current')).toContain(
    '1.2.3 differs',
  )
  expect(releaseClientContractContentsRefusal('1.2.3', 'current', 'current')).toBeNull()
})
