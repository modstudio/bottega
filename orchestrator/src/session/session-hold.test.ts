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

test('session hold names a resolved reply id in its thread-root refusal', () => {
  const rootId = addMessage()
  const id = newRecordId()
  db()
    .query(
      `INSERT INTO board_message
       (record_id,number,kind,author_kind,author_session,audience,title,body,ack_required,
        expires_at,created_at,purpose,thread_root_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM board_message),'reply','architect',
        'replier','participants',NULL,'body',0,NULL,
        '2026-10-30T00:30:00.000Z',NULL,?)`,
    )
    .run(id, rootId)
  expect(() => sessionHold({ on: id }, { env })).toThrow(
    `board message ${id} is a reply, not a thread root; hold its thread root (see ${PLATFORM_SLUG} board thread ${id})`,
  )
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

test('session hold releases a reaped local message by its record id without hosted adoption', () => {
  const id = addMessage()
  sessionHold({ on: id }, { env, at: '2026-10-30T02:30:00.000Z', recordId: () => newRecordId() })
  db().query('DELETE FROM board_message WHERE record_id=?').run(id)

  expect(
    sessionHold(
      { release: id, reason: 'message was reaped' },
      { env, at: '2026-10-30T02:45:00.000Z' },
    ),
  ).toEqual({ action: 'released', messageRecordId: id, reason: 'message was reaped' })
  expect(sessionHold({}, { env })).toEqual({ action: 'listed', holds: [] })
})

test('session hold resolves a local board number for holding and release', () => {
  const id = addMessage()
  const number = db()
    .query<{ number: number }, [string]>('SELECT number FROM board_message WHERE record_id=?')
    .get(id)!.number

  expect(
    sessionHold(
      { on: String(number) },
      { env, at: '2026-10-30T03:00:00.000Z', recordId: () => newRecordId() },
    ),
  ).toMatchObject({ action: 'held', hold: { messageRecordId: id } })
  expect(
    db()
      .query<{ message_record_id: string }, [string]>(
        'SELECT message_record_id FROM session_board_hold WHERE session_id=? AND released_at IS NULL',
      )
      .get(env.CLAUDE_CODE_SESSION_ID),
  ).toEqual({ message_record_id: id })

  expect(
    sessionHold(
      { release: String(number), reason: 'request resolved' },
      { env, at: '2026-10-30T04:00:00.000Z' },
    ),
  ).toEqual({ action: 'released', messageRecordId: id, reason: 'request resolved' })
})
