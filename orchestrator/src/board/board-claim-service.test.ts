import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { db } from '../database/db.ts'
import {
  listClaims,
  releaseClaim,
  releaseTaskClaims,
  renewClaim,
  takeClaim,
} from './board-claim-service.ts'
import { claimInterruptNotices, postNotice, reapBoardMessages } from './board-service.ts'

function fixtureProject() {
  const cwd = resolve(import.meta.dir, '../../..')
  db().query("INSERT INTO project(name,path,settings) VALUES ('claims',?,'{}')").run(cwd)
  return { cwd, project: 'claims' }
}

function presence(session: string, task: string | null, clock: number) {
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
       VALUES (?,'claude-code','architect','test','claims','/tmp',?,?)`,
    )
    .run(session, task, new Date(clock).toISOString())
}

const env = (session: string) => ({ CLAUDE_CODE_SESSION_ID: session })

test('a conflicting take is refused and tells the holder with an interrupting notice', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  presence('holder', null, clock)
  takeClaim({ subject: 'path:src/**' }, env('holder'), clock, cwd)
  expect(() => takeClaim({ subject: 'path:src/a.ts' }, env('other'), clock + 1, cwd)).toThrow(
    /session holder.*orch board ask --audience session:holder/,
  )
  const notices = claimInterruptNotices('holder', clock + 2)
  expect(notices).toHaveLength(1)
  expect(notices[0]!.detail).toContain('Conflicting claim attempt')
})

test('a lapsed claim is taken over, linked, closed, and its holder is told', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  presence('holder', null, clock)
  const first = takeClaim({ subject: 'resource:gpu', durationMs: 1 }, env('holder'), clock, cwd)
  const next = takeClaim({ subject: 'resource:gpu' }, env('other'), clock + 2, cwd)
  expect(next.action).toBe('taken-over')
  expect(next.previousClaimId).toBe(first.id)
  expect(listClaims(undefined, true, env('holder'), clock + 2, cwd).claims[0]).toMatchObject({
    id: first.id,
    closeReason: 'taken-over',
  })
  expect(claimInterruptNotices('holder', clock + 3)).toHaveLength(1)
})

test('a tied claim follows the chain latest turn and renewal restarts its lease', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  const root = db()
    .query(
      `INSERT INTO run
       (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id,turn)
       VALUES (?,'codex','implement','sha',1,'prompt','running','holder',1)`,
    )
    .run(new Date(clock).toISOString())
  const runId = Number(root.lastInsertRowid)
  const claim = takeClaim({ subject: 'task:DEV-1', runId }, env('holder'), clock, cwd)
  const renewed = renewClaim(claim.id, env('holder'), clock + 100)
  expect(Date.parse(renewed.lapsesAt)).toBe(Date.parse(claim.lapsesAt) + 100)
  db().query("UPDATE run SET status='ok' WHERE id=?").run(runId)
  expect(listClaims(undefined, false, env('holder'), clock + 101, cwd).claims).toEqual([])
})

test('a foreign architect cannot release, and release-task closes only that task key', () => {
  const { cwd, project } = fixtureProject()
  const clock = Date.now()
  const first = takeClaim({ subject: 'task:DEV-1' }, env('holder'), clock, cwd)
  takeClaim({ subject: 'task:DEV-2' }, env('other'), clock, cwd)
  expect(() => releaseClaim(first.id, env('other'), clock + 1)).toThrow(/holder or operator/)
  expect(releaseTaskClaims('DEV-1', project, {}, clock + 2)).toEqual({ released: 1 })
  expect(listClaims(project, true, {}, clock + 2).claims).toEqual([
    expect.objectContaining({ id: first.id, closeReason: 'task-closed' }),
    expect.objectContaining({ subject: { kind: 'task', value: 'DEV-2' }, live: true }),
  ])
})

test('claims survive board message reaping', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  const claim = takeClaim({ subject: 'resource:durable evidence' }, env('holder'), clock, cwd)
  reapBoardMessages(clock + 100 * 24 * 60 * 60 * 1000)
  expect(listClaims(undefined, true, env('holder'), clock + 1, cwd).claims[0]!.id).toBe(claim.id)
})

test('task audience reaches its claim holder, current architect, and live launch key only', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  for (const [session, task] of [
    ['claim-holder', null],
    ['current-task', 'DEV-9'],
    ['unrelated', 'DEV-8'],
  ] as const)
    presence(session, task, clock)
  takeClaim({ subject: 'task:DEV-9' }, env('claim-holder'), clock, cwd)
  const run = db()
    .query(
      `INSERT INTO run
       (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id,turn,repo,launch_key)
       VALUES (?,'codex','implement','sha',1,'prompt','running','owner',1,'claims','DEV-9')`,
    )
    .run(new Date(clock).toISOString())
  const posted = postNotice(
    { audience: 'task:DEV-9', title: 'Task notice', body: 'Coordination fact.' },
    {},
    clock + 1,
    cwd,
  )
  expect(posted.reached).toBe(3)
  expect(
    db()
      .query('SELECT reader_session FROM board_receipt WHERE message_id=? ORDER BY reader_session')
      .all(posted.id),
  ).toEqual([
    { reader_session: 'claim-holder' },
    { reader_session: 'current-task' },
    { reader_session: `run:${Number(run.lastInsertRowid)}` },
  ])
})
