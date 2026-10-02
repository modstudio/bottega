import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import { acknowledgeNotice, noticeStatus, postNotice, readNotices } from './board-service.ts'

test('notice store round-trip resolves, renders, delivers, and explicitly acknowledges', () => {
  const clock = Date.now()
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
     VALUES ('board-reader','claude-code','architect','test','bottega','/tmp',NULL,?)`,
    )
    .run(new Date(clock).toISOString())
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
