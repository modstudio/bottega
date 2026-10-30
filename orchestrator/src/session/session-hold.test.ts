import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { sessionHold } from './session-hold.ts'

const env = { CLAUDE_CODE_SESSION_ID: 'hold-test-session' }

function addMessage(): string {
  const id = newRecordId()
  db()
    .query(
      `INSERT INTO board_message
       (record_id,number,kind,author_kind,author_session,audience,title,body,ack_required,
        expires_at,created_at,purpose)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM board_message),'notice','architect',
        'author','all','Load gate: held','body',0,'2099-01-01T00:00:00.000Z',
        '2026-10-30T00:00:00.000Z','request')`,
    )
    .run(id)
  return id
}

test('session hold refuses an unknown board id with the thread check', () => {
  const id = newRecordId()
  expect(() => sessionHold({ on: id }, { env })).toThrow(`${PLATFORM_SLUG} board thread ${id}`)
})

test('session hold is idempotent and releases the open row with its reason', () => {
  const id = addMessage()
  const first = sessionHold(
    { on: id },
    { env, at: '2026-10-30T01:00:00.000Z', recordId: () => newRecordId() },
  )
  const duplicate = sessionHold({ on: id }, { env })
  expect(first.action).toBe('held')
  expect(duplicate.action).toBe('already-held')
  expect(sessionHold({}, { env })).toMatchObject({
    action: 'listed',
    holds: [{ messageRecordId: id }],
  })

  expect(
    sessionHold(
      { release: id, reason: 'superseded by Load gate: open' },
      { env, at: '2026-10-30T02:00:00.000Z' },
    ),
  ).toEqual({
    action: 'released',
    messageRecordId: id,
    reason: 'superseded by Load gate: open',
  })
  expect(sessionHold({}, { env })).toEqual({ action: 'listed', holds: [] })
  expect(
    db()
      .query('SELECT released_at,release_reason FROM session_board_hold WHERE message_record_id=?')
      .get(id),
  ).toEqual({
    released_at: '2026-10-30T02:00:00.000Z',
    release_reason: 'superseded by Load gate: open',
  })
})
