import { expect, test } from 'bun:test'
import { decideRecordRehearsal, mergeGroupPullRequest } from './check-record-rehearsal.ts'
import {
  RECORD_REHEARSAL_STATUS_CONTEXT,
  recordRehearsalDescription,
} from './record-rehearsal-status.ts'

const hash = 'a'.repeat(64)
const status = (
  state: string,
  description = recordRehearsalDescription.format({
    hash,
    pending: 1,
    restoreMs: 1,
    migrateMs: 2,
    dump: 'key',
  }),
) => ({
  context: RECORD_REHEARSAL_STATUS_CONTEXT,
  state,
  description,
})

test('passes when no record migration changed', () => {
  expect(
    decideRecordRehearsal({
      migrationChanged: false,
      migrationSetHash: hash,
      currentHeadStatuses: [],
      earlierHeadStatuses: [],
    }),
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
      currentHeadStatuses: [status('success')],
      earlierHeadStatuses: [],
    }).pass,
  ).toBe(true)
})

test('refuses a missing rehearsal status', () => {
  expect(
    decideRecordRehearsal({
      migrationChanged: true,
      migrationSetHash: hash,
      currentHeadStatuses: [],
      earlierHeadStatuses: [],
    }),
  ).toEqual({
    pass: false,
    message: expect.stringContaining('status is missing'),
  })
})

test('refuses a migration-set hash mismatch', () => {
  const decision = decideRecordRehearsal({
    migrationChanged: true,
    migrationSetHash: hash,
    currentHeadStatuses: [
      status(
        'success',
        recordRehearsalDescription.format({
          hash: 'b'.repeat(64),
          pending: 1,
          restoreMs: 1,
          migrateMs: 2,
          dump: 'key',
        }),
      ),
    ],
    earlierHeadStatuses: [],
  })
  expect(decision).toEqual({ pass: false, message: expect.stringContaining('hash differs') })
})

test('refuses a rehearsal that applied no migration', () => {
  const decision = decideRecordRehearsal({
    migrationChanged: true,
    migrationSetHash: hash,
    currentHeadStatuses: [
      status(
        'success',
        recordRehearsalDescription.format({
          hash,
          pending: 0,
          restoreMs: 1,
          migrateMs: 2,
          dump: 'key',
        }),
      ),
    ],
    earlierHeadStatuses: [],
  })
  expect(decision).toEqual({
    pass: false,
    message: expect.stringContaining('no pending migration'),
  })
})

test('refuses a failed rehearsal status', () => {
  const decision = decideRecordRehearsal({
    migrationChanged: true,
    migrationSetHash: hash,
    currentHeadStatuses: [status('failure')],
    earlierHeadStatuses: [],
  })
  expect(decision).toEqual({ pass: false, message: expect.stringContaining('failure') })
})

test('passes an earlier head rehearsal with the checked-out migration-set hash', () => {
  expect(
    decideRecordRehearsal({
      migrationChanged: true,
      migrationSetHash: hash,
      currentHeadStatuses: [],
      earlierHeadStatuses: [status('success')],
    }).pass,
  ).toBe(true)
})

test('passes an earlier matching success despite a current-head failure', () => {
  expect(
    decideRecordRehearsal({
      migrationChanged: true,
      migrationSetHash: hash,
      currentHeadStatuses: [status('failure')],
      earlierHeadStatuses: [status('success')],
    }).pass,
  ).toBe(true)
})

test('parses the pull request from a merge-group ref', () => {
  expect(
    mergeGroupPullRequest(
      'refs/heads/gh-readonly-queue/main/pr-1584-f9dd03b6f1eac7d583faf7ace175c1b435c51db3',
    ),
  ).toBe(1584)
  expect(mergeGroupPullRequest('gh-readonly-queue/main/pr-1573-deadbeef')).toBe(1573)
  expect(mergeGroupPullRequest('main')).toBeNull()
  expect(mergeGroupPullRequest('refs/heads/main')).toBeNull()
})
