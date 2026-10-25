import { expect, test } from 'bun:test'
import { installRecordSessionRunner } from '../../test/fixtures/record-session.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { rememberSignedInRecordUser } from '../record/record-session.ts'
import { authorizeWorkflowQuestionMutation, rulingPersonName } from './question-mutation.ts'

const now = Date.parse('2026-10-25T06:00:00.000Z')

test('workflow question adoption audit names dead-process and ownership-window grounds', () => {
  const database = migratedTestDatabase()
  database
    .query('INSERT INTO session_seen(session_id,last_seen,ancestor_chain) VALUES (?,?,?)')
    .run(
      'dead-owner',
      '2026-10-25T04:00:00.000Z',
      JSON.stringify([{ pid: 987_654, startTime: 'owner-start' }]),
    )

  expect(
    authorizeWorkflowQuestionMutation({
      owner: 'dead-owner',
      actor: 'successor',
      fromOperator: false,
      subject: 'workflow question',
      action: 'rule',
      chainLastActivityAt: now,
      now,
      database,
      probe: () => ({ alive: false, startTime: null }),
    }),
  ).toBe('adopted from dead owner dead-owner (pids 987654 gone or reused) by successor')

  expect(
    authorizeWorkflowQuestionMutation({
      owner: 'window-owner',
      actor: 'successor',
      fromOperator: false,
      subject: 'workflow question',
      action: 'rule',
      chainLastActivityAt: 0,
      now,
      database,
    }),
  ).toBe('adopted from gone owner window-owner by successor')
})

test('a person ruling uses the cached signed-in display name', () => {
  const database = migratedTestDatabase()
  installRecordSessionRunner(() => ({
    exitCode: 0,
    stdout: new TextEncoder().encode('fixture-token\n'),
    stderr: new Uint8Array(),
  }))
  try {
    rememberSignedInRecordUser(
      { id: 'user-id', name: 'Ada Lovelace', email: 'ada@example.test' },
      database,
    )
    expect(rulingPersonName(true, { database, machineUsername: () => 'machine-user' })).toBe(
      'Ada Lovelace',
    )
  } finally {
    installRecordSessionRunner(null)
    database.close()
  }
})

test('a person ruling falls back to the OS username and an agent ruling has no name', () => {
  const database = migratedTestDatabase()
  installRecordSessionRunner(() => ({
    exitCode: 44,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
  }))
  try {
    expect(rulingPersonName(true, { database, machineUsername: () => 'machine-user' })).toBe(
      'machine-user',
    )
    expect(rulingPersonName(false, { database, machineUsername: () => 'machine-user' })).toBeNull()
  } finally {
    installRecordSessionRunner(null)
    database.close()
  }
})
