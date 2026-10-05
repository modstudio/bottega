import { expect, test } from 'bun:test'
import { markRunNoticesDelivered, postNotice, readRunNotices } from '../board/board-service.ts'
import { db } from '../database/db.ts'
import {
  appendInitialRunBoardPrompt,
  BOARD_PACK_MAX_CHARS,
  BOARD_PACK_MAX_NOTICES,
  renderRunBoardSection,
} from './run-board-prompt.ts'

const notice = (id: number, ackRequired: boolean, createdAt: string, text = `notice ${id}`) => ({
  id,
  ackRequired,
  createdAt,
  text,
})

test('a dispatch-delivered notice is not returned by the worker pull path', () => {
  const clock = Date.now() + 400_000
  const run = db()
    .query(
      `INSERT INTO run
       (started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,launch_key)
       VALUES (?,'codex','implement','dispatch-board-project','sha',1,'prompt','running','DEV-DISPATCH')
       RETURNING id`,
    )
    .get(new Date(clock).toISOString()) as { id: number }
  const posted = postNotice(
    { audience: `run:${run.id}`, title: 'At dispatch', body: 'Delivered once.' },
    {},
    clock,
  )
  const bound = appendInitialRunBoardPrompt('PROMPT', run.id)
  expect(bound.noticeIds).toEqual([posted.id])
  markRunNoticesDelivered(run.id, bound.noticeIds, clock + 1)
  expect(readRunNotices(run.id, false, clock + 2)).toEqual([])
})

test('dispatch board section orders acknowledgements first, then newest, and reports overflow', () => {
  const notices = [
    notice(1, false, '2026-10-01T00:00:00.000Z'),
    notice(2, true, '2026-09-01T00:00:00.000Z'),
    notice(3, false, '2026-10-03T00:00:00.000Z'),
    notice(4, false, '2026-10-04T00:00:00.000Z'),
    notice(5, false, '2026-10-05T00:00:00.000Z'),
    notice(6, false, '2026-10-06T00:00:00.000Z'),
  ]
  const rendered = renderRunBoardSection(notices)
  expect(rendered.includedIds).toEqual([2, 6, 5, 4, 3])
  expect(rendered.includedIds).toHaveLength(BOARD_PACK_MAX_NOTICES)
  expect(rendered.text).toContain(
    '1 more notice omitted; check_orchestrator_messages returns them.',
  )
  expect(rendered.text.length).toBeLessThanOrEqual(BOARD_PACK_MAX_CHARS)
})

test('dispatch board section keeps the character bound and counts every omitted notice', () => {
  const rendered = renderRunBoardSection([
    notice(1, true, '2026-10-02T00:00:00.000Z', 'x'.repeat(BOARD_PACK_MAX_CHARS)),
    notice(2, false, '2026-10-01T00:00:00.000Z'),
  ])
  expect(rendered.includedIds).toEqual([])
  expect(rendered.text).toContain(
    '2 more notices omitted; check_orchestrator_messages returns them.',
  )
  expect(rendered.text.length).toBeLessThanOrEqual(BOARD_PACK_MAX_CHARS)
})
