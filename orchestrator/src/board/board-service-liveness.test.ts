import { beforeEach, expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { postNotice, withdrawNotice } from './board-service.ts'

beforeEach(() => fixtureProjectRecordId(db()))

test('a notice identical to a withdrawn notice posts anew', () => {
  const clock = Date.now()
  const input = {
    audience: 'operator',
    title: 'Withdrawn duplicate',
    body: 'Post this content again after withdrawal.',
  }
  const first = postNotice(input, {}, clock)
  withdrawNotice(first.recordId, {}, clock + 1)
  const reposted = postNotice(input, {}, clock + 2)
  expect(reposted.dropped).toBeFalse()
  expect(reposted.recordId).not.toBe(first.recordId)
})

test('a notice identical to an expired notice posts anew', () => {
  const clock = Date.now()
  const input = {
    audience: 'operator',
    title: 'Expired duplicate',
    body: 'Post this content again after expiry.',
    expiresMs: 1,
  }
  const first = postNotice(input, {}, clock)
  const reposted = postNotice(input, {}, clock + 2)
  expect(reposted.dropped).toBeFalse()
  expect(reposted.recordId).not.toBe(first.recordId)
})
