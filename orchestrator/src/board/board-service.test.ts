import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import {
  acknowledgeNotice,
  boardEscalations,
  noticeStatus,
  postNotice,
  readNotices,
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
  expect(noticeStatus(posted.id).unacknowledged).toEqual(['board-reader'])
  acknowledgeNotice(posted.id, env, clock + 2)
  expect(noticeStatus(posted.id).unacknowledged).toEqual([])
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
