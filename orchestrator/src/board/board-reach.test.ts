import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import { markBoardDeliveryDelivered } from './board-push-service.ts'
import {
  type BoardReachRow,
  boardReachReport,
  countBoardReach,
  renderBoardReach,
} from './board-reach.ts'
import { postNotice } from './board-service.ts'

const row = ({
  id,
  messageId,
  ...input
}: Partial<BoardReachRow> & Pick<BoardReachRow, 'id' | 'messageId'>): BoardReachRow => ({
  id,
  messageSource: 'local',
  messageId,
  readerSession: 'reader',
  readerProject: 'alpha',
  deliveryPoint: 'after-tool-call',
  blockedStop: false,
  audience: 'project:alpha',
  acknowledgementRequired: false,
  postedAt: '2026-10-13T12:00:00.000Z',
  expiresAt: '2026-10-14T12:00:00.000Z',
  sessionStartedAt: '2026-10-13T11:00:00.000Z',
  postingTiming: 'after-session',
  concern: 'concerned',
  recordedAt: '2026-10-13T12:01:00.000Z',
  ...input,
})

test('counts project concern, unqualified and older pushes, and stop acknowledgement weight', () => {
  const result = countBoardReach([
    row({ id: 1, messageId: 'one' }),
    row({
      id: 2,
      messageId: 'one',
      readerProject: 'beta',
      concern: 'not-concerned',
    }),
    row({ id: 3, messageId: 'unqualified', audience: 'architects', concern: 'unqualified' }),
    row({
      id: 4,
      messageId: 'old',
      postingTiming: 'before-session',
      postedAt: '2026-10-13T10:00:00.000Z',
    }),
    row({
      id: 5,
      messageId: 'blocking-info',
      deliveryPoint: 'stop',
      blockedStop: true,
    }),
    row({
      id: 6,
      messageId: 'blocking-ack',
      deliveryPoint: 'stop',
      blockedStop: true,
      acknowledgementRequired: true,
    }),
  ])

  expect(result).toEqual({
    messagesPushed: 5,
    pushes: 6,
    pushesNotConcerned: 1,
    pushesOlderThanSession: 1,
    stopsBlockedWithoutAcknowledgement: 1,
    worstMessages: [{ messageId: 'one', audience: 'project:alpha', pushes: 2, unrelated: 1 }],
  })
})

test('an empty reach window has no pushes or worst messages', () => {
  expect(countBoardReach([])).toEqual({
    messagesPushed: 0,
    pushes: 0,
    pushesNotConcerned: 0,
    pushesOlderThanSession: 0,
    stopsBlockedWithoutAcknowledgement: 0,
    worstMessages: [],
  })
  expect(
    renderBoardReach({
      windowHours: 24,
      windowStart: '2026-10-12T12:00:00.000Z',
      recordingStartedAt: '2026-10-13T12:00:00.000Z',
      recordingFailures: 0,
      totals: countBoardReach([]),
      rows: [],
    }),
  ).toBe(
    'No board pushes recorded in this window. Recording has existed since 2026-10-13T12:00:00.000Z.',
  )
})

test('a reach recording failure does not prevent delivery stamping', async () => {
  const clock = Date.parse('2026-10-13T13:00:00.000Z')
  const session = 'recording-failure-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','reach-project','/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const posted = postNotice(
    { audience: `session:${session}`, title: 'Still deliver', body: 'Recording is secondary' },
    {},
    clock,
  )

  await markBoardDeliveryDelivered({
    session,
    ids: [String(posted.id)],
    deliveryPoint: 'after-tool-call',
    clock: clock + 1,
    recordReach: () => {
      throw new Error('injected reach recorder failure')
    },
  })

  expect(
    db()
      .query('SELECT delivered_at FROM board_receipt WHERE message_id=? AND reader_session=?')
      .get(posted.id, session),
  ).toEqual({ delivered_at: new Date(clock + 1).toISOString() })
  expect(db().query('SELECT COUNT(*) count FROM board_reach_recording_failure').get()).toEqual({
    count: 1,
  })
})

test('delivery records its point and the reader project in the reach window', async () => {
  const clock = Date.parse('2026-10-13T13:10:00.000Z')
  const session = 'recorded-reach-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','reach-project','/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const posted = postNotice(
    { audience: 'project:reach-project', title: 'Measured', body: 'A measured push' },
    {},
    clock,
  )

  await markBoardDeliveryDelivered({
    session,
    ids: [String(posted.id)],
    deliveryPoint: 'stop',
    blockedStop: true,
    clock: clock + 1,
  })

  const measured = boardReachReport(1, clock + 2, db()).rows.find(
    (delivery) => delivery.messageId === String(posted.id),
  )
  expect(measured).toMatchObject({
    readerSession: session,
    readerProject: 'reach-project',
    deliveryPoint: 'stop',
    blockedStop: true,
    audience: 'project:reach-project',
    acknowledgementRequired: false,
    postingTiming: 'after-session',
    concern: 'concerned',
  })
})
