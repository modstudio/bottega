import { expect, test } from 'bun:test'
import { decideRecordRehearsal, mergeGroupPullRequest } from './check-record-rehearsal.ts'

const hash = 'a'.repeat(64)
const status = (
  state: string,
  description = `migration-set ${hash}; restore 1; migrate 2; dump key`,
) => ({
  context: 'record-rehearsal',
  state,
  description,
})

test('passes when no record migration changed', () => {
  expect(
    decideRecordRehearsal({ migrationChanged: false, migrationSetHash: hash, statuses: [] }),
  ).toEqual({
    pass: true,
    message: 'record rehearsal: no migration change',
  })
})

test('passes a matching successful rehearsal', () => {
  expect(
    decideRecordRehearsal({
      migrationChanged: true,
      migrationSetHash: hash,
      statuses: [status('success')],
    }).pass,
  ).toBe(true)
})

test('refuses a missing rehearsal status', () => {
  expect(
    decideRecordRehearsal({ migrationChanged: true, migrationSetHash: hash, statuses: [] }),
  ).toEqual({
    pass: false,
    message: expect.stringContaining('status is missing'),
  })
})

test('refuses a migration-set hash mismatch', () => {
  const decision = decideRecordRehearsal({
    migrationChanged: true,
    migrationSetHash: hash,
    statuses: [
      status('success', `migration-set ${'b'.repeat(64)}; restore 1; migrate 2; dump key`),
    ],
  })
  expect(decision).toEqual({ pass: false, message: expect.stringContaining('hash differs') })
})

test('refuses a failed rehearsal status', () => {
  const decision = decideRecordRehearsal({
    migrationChanged: true,
    migrationSetHash: hash,
    statuses: [status('failure')],
  })
  expect(decision).toEqual({ pass: false, message: expect.stringContaining('failure') })
})

test('parses the pull request from a merge-group ref', () => {
  expect(mergeGroupPullRequest('gh-readonly-queue/main/pr-1573-deadbeef')).toBe(1573)
  expect(mergeGroupPullRequest('main')).toBeNull()
})
