import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { BOARD_BODY_MAX_CHARS, BOARD_TITLE_MAX_CHARS } from './board-policy.ts'
import {
  acknowledgeNotice,
  boardEscalations,
  claimNotices,
  noticeStatus,
  postNotice,
  readNotices,
  recordPresence,
} from './board-service.ts'

test('notice store round-trip resolves, renders, delivers, and explicitly acknowledges', () => {
  const clock = Date.now()
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
     VALUES ('board-reader','claude-code','architect','test',?,'/tmp',NULL,?)`,
    )
    .run(PLATFORM_SLUG, new Date(clock).toISOString())
  const posted = postNotice(
    { audience: 'architects', title: 'Wind down', body: 'Finish owned work.', ackRequired: true },
    {},
    clock,
  )
  const env = { CLAUDE_CODE_SESSION_ID: 'board-reader' }
  const notices = readNotices(false, env, clock + 1)
  expect(notices).toHaveLength(1)
  expect(notices[0]!.text).toContain('Origin: operator')
  expect(notices[0]!.text).toContain('not an instruction, ruling, or consent')
  expect(noticeStatus(posted.id, {}).unacknowledged).toEqual(['board-reader'])
  acknowledgeNotice(posted.id, env, clock + 2)
  expect(noticeStatus(posted.id, {}).unacknowledged).toEqual([])
})

test('a session-start notice dropped for budget stays unread until a stamping read', () => {
  const clock = Date.now() + 20_000
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
       VALUES ('budget-reader','claude-code','architect','test',?,'/tmp',NULL,?)`,
    )
    .run(PLATFORM_SLUG, new Date(clock).toISOString())
  const posted = postNotice(
    { audience: `session:budget-reader`, title: 'Droppable', body: 'budget text '.repeat(20) },
    {},
    clock,
  )
  const env = { CLAUDE_CODE_SESSION_ID: 'budget-reader' }
  expect(claimNotices(false, env, clock + 1).map((notice) => notice.id)).toEqual([posted.id])
  // The hook drops the whole board section here and therefore does not stamp its claimed ids.
  expect(readNotices(false, env, clock + 2).map((notice) => notice.id)).toEqual([posted.id])
})

test('architect origin is snapshotted when posted and survives presence mutation', () => {
  const clock = Date.now() + 30_000
  const session = 'origin-author'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
       VALUES (?,'claude-code','architect','test','original-project','/tmp',NULL,?)`,
    )
    .run(session, new Date(clock).toISOString())
  const posted = postNotice(
    { audience: 'operator', title: 'Stable origin', body: 'The origin does not move.' },
    { CLAUDE_CODE_SESSION_ID: session },
    clock,
  )
  db().query('DELETE FROM presence WHERE session_id=?').run(session)
  const rendered = noticeStatus(posted.id, {}).message.text
  expect(rendered).toContain(`architect ${session} (claude-code, original-project)`)
  expect(rendered).not.toContain('unknown project')
})

test('architect posting without project presence is refused with a remedy', () => {
  expect(() =>
    postNotice(
      { audience: 'operator', title: 'No project', body: 'Cannot establish origin.' },
      { CLAUDE_CODE_SESSION_ID: 'missing-project-author' },
      Date.now() + 40_000,
    ),
  ).toThrow(/run orch board presence from a registered project/)
})

test('secret-shaped title or body is refused before storage without echoing it', () => {
  const planted = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
  const before = (db().query('SELECT COUNT(*) count FROM board_message').get() as { count: number })
    .count
  for (const input of [
    { audience: 'operator', title: planted, body: 'safe' },
    { audience: 'operator', title: 'safe', body: planted },
  ]) {
    let output = ''
    try {
      postNotice(input, {}, Date.now() + 50_000)
    } catch (error) {
      output = String(error)
    }
    expect(output).toContain('secret-shaped')
    expect(output).not.toContain(planted)
  }
  const after = (db().query('SELECT COUNT(*) count FROM board_message').get() as { count: number })
    .count
  expect(after).toBe(before)
  expect(
    db().query('SELECT id FROM board_message WHERE title=? OR body=?').all(planted, planted),
  ).toEqual([])
})

test('post content accepts exact size boundaries and refuses one character over', () => {
  const clock = Date.now() + 60_000
  const posted = postNotice(
    {
      audience: 'operator',
      title: 't'.repeat(BOARD_TITLE_MAX_CHARS),
      body: 'z'.repeat(BOARD_BODY_MAX_CHARS),
    },
    {},
    clock,
  )
  expect(posted.dropped).toBeFalse()
  expect(() =>
    postNotice(
      { audience: 'operator', title: 't'.repeat(BOARD_TITLE_MAX_CHARS + 1), body: 'safe' },
      {},
      clock + 1,
    ),
  ).toThrow(`${BOARD_TITLE_MAX_CHARS} characters`)
  expect(() =>
    postNotice(
      { audience: 'operator', title: 'safe', body: 'z'.repeat(BOARD_BODY_MAX_CHARS + 1) },
      {},
      clock + 2,
    ),
  ).toThrow(`${BOARD_BODY_MAX_CHARS} characters`)
})

test('ack deadline cannot exceed expiry and expired notices do not escalate', () => {
  const clock = Date.now() + 70_000
  expect(() =>
    postNotice(
      {
        audience: 'operator',
        title: 'Impossible deadline',
        body: 'Deadline follows expiry.',
        ackRequired: true,
        deadlineMs: 2_000,
        expiresMs: 1_000,
      },
      {},
      clock,
    ),
  ).toThrow(/deadline 2000ms is later than expiry 1000ms/)
  const posted = postNotice(
    {
      audience: 'operator',
      title: 'Expires before inspection',
      body: 'Do not escalate after expiry.',
      ackRequired: true,
      deadlineMs: 500,
      expiresMs: 1_000,
    },
    {},
    clock + 1,
  )
  expect(
    boardEscalations(clock + 1_002).some((row) => row.subject.startsWith(`board:${posted.id}:`)),
  ).toBeFalse()
})

test('status is limited to operator, author, or an addressed architect and refuses workers', () => {
  const clock = Date.now() + 80_000
  const insert = db().query(
    `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
     VALUES (?,'claude-code','architect','test','status-project','/tmp',NULL,?)`,
  )
  for (const session of ['status-author', 'status-reader', 'status-stranger'])
    insert.run(session, new Date(clock).toISOString())
  const posted = postNotice(
    { audience: 'session:status-reader', title: 'Guarded status', body: 'Only relevant actors.' },
    { CLAUDE_CODE_SESSION_ID: 'status-author' },
    clock,
  )
  expect(noticeStatus(posted.id, {}).message.id).toBe(posted.id)
  expect(noticeStatus(posted.id, { CLAUDE_CODE_SESSION_ID: 'status-author' }).message.id).toBe(
    posted.id,
  )
  expect(
    noticeStatus(posted.id, { CLAUDE_CODE_SESSION_ID: 'status-reader' }, clock + 1).message.id,
  ).toBe(posted.id)
  expect(() =>
    noticeStatus(posted.id, { CLAUDE_CODE_SESSION_ID: 'status-stranger' }, clock + 1),
  ).toThrow(/not authored by or addressed/)
  expect(() => noticeStatus(posted.id, { ORCH_RUN_ID: '123' })).toThrow(/workers cannot/)
})

test('reserved operator sentinel is refused on every session-aware board path', () => {
  const env = { CLAUDE_CODE_SESSION_ID: 'operator' }
  const posted = postNotice(
    { audience: 'operator', title: 'Sentinel target', body: 'Used to exercise guards.' },
    {},
    Date.now() + 90_000,
  )
  expect(() => recordPresence('/tmp', env)).toThrow(/reserved/)
  expect(() => postNotice({ audience: 'operator', title: 'x', body: 'y' }, env)).toThrow(/reserved/)
  expect(() => readNotices(false, env)).toThrow(/reserved/)
  expect(() => acknowledgeNotice(posted.id, env)).toThrow(/reserved/)
  expect(() => noticeStatus(posted.id, env)).toThrow(/reserved/)
})

test('ack escalation keeps the posting-time audience snapshot across presence refreshes', () => {
  const clock = Date.now() + 10_000
  const insertPresence = db().query(
    `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
     VALUES (?,'claude-code','architect','test','snapshot-project','/tmp',NULL,?)
     ON CONFLICT(session_id) DO UPDATE SET project=excluded.project,last_seen=excluded.last_seen`,
  )
  insertPresence.run('posting-reader', new Date(clock).toISOString())
  const posted = postNotice(
    {
      audience: 'project:snapshot-project',
      title: 'Snapshot audience',
      body: 'Acknowledge this.',
      ackRequired: true,
      deadlineMs: 1_000,
    },
    {},
    clock,
  )
  insertPresence.run('posting-reader', new Date(clock + 500).toISOString())
  insertPresence.run('late-reader', new Date(clock + 500).toISOString())
  readNotices(false, { CLAUDE_CODE_SESSION_ID: 'late-reader' }, clock + 500)
  expect(
    boardEscalations(clock + 1_001)
      .filter((row) => row.subject.startsWith(`board:${posted.id}:`))
      .map((row) => row.subject),
  ).toEqual([`board:${posted.id}:posting-reader`])
})
