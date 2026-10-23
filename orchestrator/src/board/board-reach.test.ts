import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { parseAudience } from './board-policy.ts'
import { markBoardDeliveryDelivered } from './board-push-service.ts'
import {
  BOARD_REACH_RETENTION_HOURS,
  type BoardReachRow,
  boardReachConcern,
  boardReachReport,
  countBoardReach,
  reapBoardReach,
  renderBoardReach,
} from './board-reach.ts'
import { postNotice } from './board-service.ts'

const row = ({
  recordId,
  messageId,
  ...input
}: Partial<BoardReachRow> & Pick<BoardReachRow, 'recordId' | 'messageId'>): BoardReachRow => ({
  recordId,
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
  audienceAtPosting: true,
  successor: false,
  ...input,
})

test('counts project concern, unqualified and older pushes, and stop acknowledgement weight', () => {
  const result = countBoardReach([
    row({ recordId: newRecordId(), messageId: 'one' }),
    row({
      recordId: newRecordId(),
      messageId: 'one',
      readerProject: 'beta',
      concern: 'not-concerned',
    }),
    row({
      recordId: newRecordId(),
      messageId: 'unqualified',
      audience: 'architects',
      concern: 'unqualified',
    }),
    row({
      recordId: newRecordId(),
      messageId: 'old',
      postingTiming: 'before-session',
      postedAt: '2026-10-13T10:00:00.000Z',
    }),
    row({
      recordId: newRecordId(),
      messageId: 'blocking-info',
      deliveryPoint: 'stop',
      blockedStop: true,
    }),
    row({
      recordId: newRecordId(),
      messageId: 'blocking-ack',
      deliveryPoint: 'stop',
      blockedStop: true,
      acknowledgementRequired: true,
    }),
  ])

  expect(result).toEqual({
    messagesPushed: 5,
    pushes: 6,
    pushesByPurpose: { information: 6, request: 0, standing: 0 },
    pushesNotConcerned: 1,
    pushesUnqualified: 1,
    pushesOlderThanSession: 1,
    audienceAtPostingZero: 0,
    audienceAtPostingNull: 0,
    successorDeliveries: 0,
    stopsBlockedWithoutAcknowledgement: 1,
    worstMessages: [
      {
        messageSource: 'local',
        messageId: 'one',
        audience: 'project:alpha',
        pushes: 2,
        pushesNotConcerned: 1,
        pushesUnqualified: 0,
        pushesOlderThanSession: 0,
        stopsBlocked: 0,
        pushesNotShownToConcernReader: 1,
        readerProjects: ['alpha', 'beta'],
      },
      {
        messageSource: 'local',
        messageId: 'unqualified',
        audience: 'architects',
        pushes: 1,
        pushesNotConcerned: 0,
        pushesUnqualified: 1,
        pushesOlderThanSession: 0,
        stopsBlocked: 0,
        pushesNotShownToConcernReader: 1,
        readerProjects: ['alpha'],
      },
    ],
  })
  expect(
    countBoardReach([
      row({
        recordId: newRecordId(),
        messageId: 'info',
        blockedStop: true,
        acknowledgementRequired: false,
      }),
    ]).stopsBlockedWithoutAcknowledgement,
  ).toBe(1)
  expect(
    countBoardReach([
      row({
        recordId: newRecordId(),
        messageId: 'ack',
        blockedStop: true,
        acknowledgementRequired: true,
      }),
    ]).stopsBlockedWithoutAcknowledgement,
  ).toBe(0)
  expect(
    countBoardReach([
      row({ recordId: newRecordId(), messageId: 'zero', audienceAtPosting: false }),
      row({ recordId: newRecordId(), messageId: 'unset', audienceAtPosting: null }),
      row({
        recordId: newRecordId(),
        messageId: 'succ',
        audienceAtPosting: false,
        successor: true,
      }),
    ]),
  ).toMatchObject({
    audienceAtPostingZero: 2,
    audienceAtPostingNull: 1,
    successorDeliveries: 1,
  })
})

test('an empty reach window has no pushes or worst messages', () => {
  const totals = countBoardReach([])
  expect(totals).toEqual({
    messagesPushed: 0,
    pushes: 0,
    pushesByPurpose: { information: 0, request: 0, standing: 0 },
    pushesNotConcerned: 0,
    pushesUnqualified: 0,
    pushesOlderThanSession: 0,
    audienceAtPostingZero: 0,
    audienceAtPostingNull: 0,
    successorDeliveries: 0,
    stopsBlockedWithoutAcknowledgement: 0,
    worstMessages: [],
  })
  expect(
    renderBoardReach({
      windowHours: 24,
      windowStart: '2026-10-12T12:00:00.000Z',
      coveredFrom: '2026-10-13T12:00:00.000Z',
      coveredTo: '2026-10-13T13:00:00.000Z',
      partial: true,
      recordingStartedAt: '2026-10-13T12:00:00.000Z',
      recordingFailures: 2,
      totals: {
        ...totals,
        worstMessages: totals.worstMessages.map((message) => ({
          ...message,
          title: null,
        })),
      },
      rows: [],
    }),
  ).toBe(
    'Covered 2026-10-13T12:00:00.000Z to 2026-10-13T13:00:00.000Z (partial window). Recording failures: 2.\nNo board pushes recorded in this window. Recording has existed since 2026-10-13T12:00:00.000Z.',
  )
})

test('an unqualified message reports every way its pushes failed to show concern', () => {
  const result = countBoardReach([
    row({
      recordId: newRecordId(),
      messageId: 'plain-architects',
      audience: 'architects',
      readerProject: 'beta',
      concern: 'unqualified',
      postingTiming: 'before-session',
    }),
    row({
      recordId: newRecordId(),
      messageId: 'plain-architects',
      audience: 'architects',
      readerProject: 'alpha',
      concern: 'unqualified',
      deliveryPoint: 'stop',
      blockedStop: true,
    }),
  ])

  expect(result.pushesUnqualified).toBe(2)
  expect(result.worstMessages).toEqual([
    {
      messageSource: 'local',
      messageId: 'plain-architects',
      audience: 'architects',
      pushes: 2,
      pushesNotConcerned: 0,
      pushesUnqualified: 2,
      pushesOlderThanSession: 1,
      stopsBlocked: 1,
      pushesNotShownToConcernReader: 2,
      readerProjects: ['alpha', 'beta'],
    },
  ])
})

test('rendering identifies a removed message by id alone', async () => {
  const clock = Date.parse('2026-10-13T13:00:00.000Z')
  const session = 'removed-message-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
     VALUES (?,'claude-code','architect','test','alpha',(SELECT record_id FROM project WHERE name='alpha'),'/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const posted = postNotice(
    { audience: 'architects:all', title: 'Soon gone', body: 'body' },
    {},
    clock,
  )
  await markBoardDeliveryDelivered({
    session,
    ids: [String(posted.number)],
    emissionId: 'removed-emission',
    deliveryPoint: 'after-tool-call',
    clock: clock + 1,
  })
  expect(renderBoardReach(boardReachReport(1, clock + 2, db()))).toContain(
    `${posted.recordId} — Soon gone [architects:all]`,
  )
  db().query('DELETE FROM board_message WHERE record_id=?').run(posted.recordId)
  expect(renderBoardReach(boardReachReport(1, clock + 2, db()))).toContain(
    `${posted.recordId} [architects:all]: 1 not shown to concern`,
  )
})

test('the pure concern classifier covers every audience form', () => {
  const classify = (
    audience: string,
    session = 'reader',
    project = 'alpha',
    taskProject: string | null = null,
  ) => boardReachConcern(parseAudience(audience), session, project, taskProject)
  expect(classify('operator')).toBe('unqualified')
  expect(classify('architects')).toBe('unqualified')
  expect(boardReachConcern(parseAudience('architects'), 'reader', 'alpha', null, 'alpha')).toBe(
    'concerned',
  )
  expect(boardReachConcern(parseAudience('architects'), 'reader', 'beta', null, 'alpha')).toBe(
    'not-concerned',
  )
  expect(classify('architects:all')).toBe('unqualified')
  expect(classify('architects:alpha')).toBe('concerned')
  expect(classify('spaces')).toBe('unqualified')
  expect(classify('project:alpha')).toBe('concerned')
  expect(classify('project:beta')).toBe('not-concerned')
  expect(classify('workers:alpha')).toBe('concerned')
  expect(classify('task:DEV-1', 'reader', 'alpha', 'alpha')).toBe('concerned')
  expect(classify('task:DEV-1', 'reader', 'alpha', 'beta')).toBe('not-concerned')
  expect(classify('task:DEV-1')).toBe('unqualified')
  expect(classify('run:7', 'run:7')).toBe('concerned')
  expect(classify('run:7')).toBe('not-concerned')
  expect(classify('machine:test')).toBe('unqualified')
  expect(classify('session:reader')).toBe('concerned')
  expect(classify('session:other')).toBe('not-concerned')
})

test('a reach recording failure does not prevent delivery stamping', async () => {
  const clock = Date.parse('2026-10-13T13:00:00.000Z')
  const session = 'recording-failure-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','reach-project',(SELECT record_id FROM project WHERE name='reach-project'),'/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const posted = postNotice(
    { audience: `session:${session}`, title: 'Still deliver', body: 'Recording is secondary' },
    {},
    clock,
  )

  db().exec(`CREATE TRIGGER fail_reach BEFORE INSERT ON board_reach_delivery
    BEGIN SELECT RAISE(ABORT, 'injected reach recorder failure'); END`)
  await markBoardDeliveryDelivered({
    session,
    ids: [String(posted.number)],
    emissionId: 'failed-emission',
    deliveryPoint: 'after-tool-call',
    clock: clock + 1,
  })

  expect(
    db()
      .query(
        'SELECT delivered_at FROM board_receipt WHERE message_record_id=? AND reader_session=?',
      )
      .get(posted.recordId, session),
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
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','reach-project',(SELECT record_id FROM project WHERE name='reach-project'),'/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const posted = postNotice(
    {
      audience: 'project:reach-project',
      title: 'Measured',
      body: 'A measured push',
      purpose: 'request',
    },
    {},
    clock,
  )

  await markBoardDeliveryDelivered({
    session,
    ids: [String(posted.number)],
    emissionId: 'measured-emission',
    deliveryPoint: 'stop',
    blockedStop: true,
    clock: clock + 1,
  })

  const measured = boardReachReport(1, clock + 2, db()).rows.find(
    (delivery) => delivery.messageId === String(posted.recordId),
  )
  expect(measured).toMatchObject({
    readerSession: session,
    readerProject: 'reach-project',
    deliveryPoint: 'stop',
    blockedStop: true,
    audience: 'project:reach-project',
    acknowledgementRequired: false,
    purpose: 'request',
    postingTiming: 'after-session',
    concern: 'concerned',
  })
})

test('an emission retry records once while a later reminder records twice', async () => {
  const clock = Date.parse('2026-10-13T14:00:00.000Z')
  const session = 'emission-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
     VALUES (?,'claude-code','architect','test','alpha',(SELECT record_id FROM project WHERE name='alpha'),'/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const posted = postNotice(
    {
      audience: `session:${session}`,
      title: 'Reminder',
      body: 'Acknowledge',
      ackRequired: true,
      purpose: 'request',
    },
    {},
    clock,
  )
  const stamp = (emissionId: string, at: number) =>
    markBoardDeliveryDelivered({
      session,
      ids: [String(posted.number)],
      emissionId,
      deliveryPoint: 'after-tool-call',
      clock: at,
    })
  await stamp('same-emission', clock + 1)
  await stamp('same-emission', clock + 2)
  expect(db().query('SELECT COUNT(*) count FROM board_reach_delivery').get()).toEqual({ count: 1 })
  expect(db().query('SELECT COUNT(*) count FROM board_reach_recording_failure').get()).toEqual({
    count: 0,
  })
  await stamp('later-reminder', clock + 3)
  expect(db().query('SELECT COUNT(*) count FROM board_reach_delivery').get()).toEqual({ count: 2 })
})

test('reach reports pushes with audience_at_posting 0 separately', async () => {
  const clock = Date.parse('2026-10-13T16:00:00.000Z')
  const session = 'late-join-reader'
  const posted = postNotice(
    {
      audience: 'architects:all',
      title: 'Missed',
      body: 'Catch up.',
      purpose: 'request',
    },
    {},
    clock,
  )
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','alpha',(SELECT record_id FROM project WHERE name='alpha'),'/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 60_000).toISOString(), new Date(clock + 1).toISOString())
  await markBoardDeliveryDelivered({
    session,
    ids: [String(posted.number)],
    emissionId: 'late-join-emission',
    deliveryPoint: 'after-tool-call',
    clock: clock + 1,
  })
  const report = boardReachReport(1, clock + 2, db())
  expect(report.totals.audienceAtPostingZero).toBe(1)
  expect(report.totals.audienceAtPostingNull).toBe(0)
  expect(report.totals.successorDeliveries).toBe(0)
  expect(
    report.rows.find((row) => row.messageId === String(posted.recordId))?.audienceAtPosting,
  ).toBe(false)
  expect(renderBoardReach(report)).toContain('Pushes with audience_at_posting 0: 1')
  expect(renderBoardReach(report)).toContain('Pushes with audience_at_posting unset: 0')
  expect(renderBoardReach(report)).toContain('Successor deliveries: 0')
  db().query('UPDATE board_receipt SET successor=1 WHERE reader_session=?').run(session)
  const successorReport = boardReachReport(1, clock + 2, db())
  expect(successorReport.totals.successorDeliveries).toBe(1)
  expect(
    successorReport.rows.find((row) => row.messageId === String(posted.recordId))?.successor,
  ).toBe(true)
  expect(renderBoardReach(successorReport)).toContain('Successor deliveries: 1')
})

test('reach retention leaves recent rows and failures in place', () => {
  const now = Date.parse('2026-10-13T15:00:00.000Z')
  const old = new Date(now - (BOARD_REACH_RETENTION_HOURS + 1) * 60 * 60 * 1_000).toISOString()
  const recent = new Date(now - 60 * 60 * 1_000).toISOString()
  db()
    .query('INSERT INTO board_reach_recording_failure(recorded_at,record_id) VALUES (?,?),(?,?)')
    .run(old, newRecordId(), recent, newRecordId())
  reapBoardReach(now, db())
  expect(db().query('SELECT recorded_at FROM board_reach_recording_failure').all()).toEqual([
    { recorded_at: recent },
  ])
})
