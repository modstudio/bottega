import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { db } from '../database/db.ts'
import { claimNotices } from './board-service.ts'
import {
  declineBoardSuggestion,
  postBoardSuggestion,
  suggestBoardPost,
} from './board-suggestions.ts'

function projectFixture() {
  const cwd = resolve(import.meta.dir, '../../..')
  db()
    .query(`INSERT OR IGNORE INTO project(name,path,settings) VALUES ('suggestion-project',?,'{}')`)
    .run(cwd)
  return cwd
}

function runFixture(session: string | null, status = 'running') {
  return db()
    .query(
      `INSERT INTO run
       (started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id,launch_key)
       VALUES ('2026-10-04','codex','implement','suggestion-project','sha',1,'prompt',?,?, 'DEV-968')
       RETURNING id`,
    )
    .get(status, session) as { id: number }
}

test('worker suggestion can be edited, posted with both origins, and withdrawn', () => {
  const clock = Date.now() + 100_000
  const cwd = projectFixture()
  const run = runFixture('owning-architect')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,last_seen)
       VALUES ('owning-architect','claude-code','architect','test','suggestion-project',?,?)`,
    )
    .run(cwd, new Date(clock).toISOString())
  const suggested = suggestBoardPost(
    run.id,
    { title: 'Original title', body: 'Proposed body', task: 'DEV-968', topics: ['mcp'] },
    clock,
  )
  expect(
    claimNotices(false, { CLAUDE_CODE_SESSION_ID: 'owning-architect' }, clock + 1)[0]!.text,
  ).toContain(`Origin: worker run ${run.id}`)

  const posted = postBoardSuggestion(
    suggested.id,
    { audience: 'operator', title: 'Edited title' },
    { CLAUDE_CODE_SESSION_ID: 'owning-architect' },
    clock + 2,
    cwd,
  )
  const rendered = claimNotices(false, {}, clock + 3).find((notice) => notice.id === posted.id)!
  expect(rendered.text).toContain('Title: Edited title')
  expect(rendered.text).toContain(
    `architect owning-architect (claude-code, suggestion-project), from run ${run.id}`,
  )
  expect(db().query('SELECT withdrawn_at FROM board_message WHERE id=?').get(suggested.id)).toEqual(
    { withdrawn_at: new Date(clock + 2).toISOString() },
  )
})

test('worker suggestion can be declined', () => {
  const clock = Date.now() + 200_000
  const run = runFixture('declining-architect')
  const suggested = suggestBoardPost(run.id, { title: 'Decline', body: 'No longer needed' }, clock)
  declineBoardSuggestion(suggested.id, { CLAUDE_CODE_SESSION_ID: 'declining-architect' }, clock + 1)
  expect(db().query('SELECT withdrawn_at FROM board_message WHERE id=?').get(suggested.id)).toEqual(
    { withdrawn_at: new Date(clock + 1).toISOString() },
  )
})

test('suggestion refuses a run without an owner and disposal by another session', () => {
  const clock = Date.now() + 300_000
  const unowned = runFixture(null)
  expect(() => suggestBoardPost(unowned.id, { title: 'Unowned', body: 'Fallback' }, clock)).toThrow(
    /put the suggestion in the final reply instead/,
  )
  const owned = runFixture('right-session')
  const suggested = suggestBoardPost(owned.id, { title: 'Owned', body: 'Guarded' }, clock + 1)
  expect(() =>
    declineBoardSuggestion(suggested.id, { CLAUDE_CODE_SESSION_ID: 'wrong-session' }, clock + 2),
  ).toThrow(/only session right-session or the operator/)
})
