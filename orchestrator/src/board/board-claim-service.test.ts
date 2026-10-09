import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { db, SESSION_LIVE_MS } from '../database/db.ts'
import {
  listClaims,
  releaseClaim,
  releaseTaskClaims,
  renewClaim,
  takeClaim,
} from './board-claim-service.ts'
import { BOARD_POST_RATE_LIMIT } from './board-policy.ts'
import { claimNotices, postNotice, reapBoardMessages } from './board-service.ts'

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
const claimNoticesFor = (session: string, clock: number) => claimNotices(false, env(session), clock)

test('a conflicting take is refused and tells the holder with an interrupting notice', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  presence('holder', null, clock)
  takeClaim({ subject: 'path:src/**' }, env('holder'), clock, cwd)
  expect(() => takeClaim({ subject: 'path:src/a.ts' }, env('other'), clock + 1, cwd)).toThrow(
    /session holder.*orch board ask --audience session:holder/,
  )
  const notices = claimNoticesFor('holder', clock + 2)
  expect(notices).toHaveLength(1)
  expect(notices[0]!.text).toContain('Conflicting claim attempt')
})

test('a lapsed claim is taken over, linked, closed, and its holder is told', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  presence('holder', null, clock)
  const first = takeClaim({ subject: 'resource:gpu', durationMs: 1 }, env('holder'), clock, cwd)
  const next = takeClaim({ subject: 'resource:gpu' }, env('other'), clock + 2, cwd)
  expect(next.action).toBe('taken-over')
  expect(next.previousClaimIds).toEqual([first.id])
  expect(listClaims(undefined, true, env('holder'), clock + 2, cwd).claims[0]).toMatchObject({
    id: first.id,
    closeReason: 'lapsed',
    supersededByClaimId: next.id,
  })
  expect(claimNoticesFor('holder', clock + 3)).toHaveLength(1)
})

test('a broad path claim refuses every live conflict and tells every architect holder', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  presence('first-holder', null, clock)
  presence('second-holder', null, clock)
  takeClaim({ subject: 'path:src/a.ts' }, env('first-holder'), clock, cwd)
  takeClaim({ subject: 'path:src/b.ts' }, env('second-holder'), clock, cwd)
  expect(() => takeClaim({ subject: 'path:src/**' }, env('requester'), clock + 1, cwd)).toThrow(
    /session first-holder.*session second-holder/,
  )
  expect(claimNoticesFor('first-holder', clock + 2)).toHaveLength(1)
  expect(claimNoticesFor('second-holder', clock + 2)).toHaveLength(1)
})

test('a holder may take an overlapping path claim without closing or notifying itself', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  presence('holder', null, clock)
  const narrow = takeClaim({ subject: 'path:src/a.ts' }, env('holder'), clock, cwd)
  const broad = takeClaim({ subject: 'path:src/**' }, env('holder'), clock + 1, cwd)
  expect(broad.action).toBe('taken')
  expect(listClaims(undefined, false, env('holder'), clock + 1, cwd).claims).toEqual([
    expect.objectContaining({ id: narrow.id, live: true }),
    expect.objectContaining({ id: broad.id, live: true }),
  ])
  expect(claimNoticesFor('holder', clock + 2)).toEqual([])
})

test('an overlapping take ignores the holder own claim but refuses and tells another holder', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  presence('holder', null, clock)
  presence('other', null, clock)
  const own = takeClaim({ subject: 'path:src/a.ts' }, env('holder'), clock, cwd)
  takeClaim({ subject: 'path:src/b.ts' }, env('other'), clock, cwd)
  expect(() => takeClaim({ subject: 'path:src/**' }, env('holder'), clock + 1, cwd)).toThrow(
    /claim conflicts with: session other/,
  )
  expect(listClaims(undefined, false, env('holder'), clock + 1, cwd).claims).toContainEqual(
    expect.objectContaining({ id: own.id, live: true }),
  )
  expect(claimNoticesFor('holder', clock + 2)).toEqual([])
  expect(claimNoticesFor('other', clock + 2)).toHaveLength(1)
})

test('a broad path takeover closes and links every stale conflict', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  presence('first-holder', null, clock)
  presence('second-holder', null, clock)
  const first = takeClaim(
    { subject: 'path:src/a.ts', durationMs: 1 },
    env('first-holder'),
    clock,
    cwd,
  )
  const second = takeClaim(
    { subject: 'path:src/b.ts', durationMs: 1 },
    env('second-holder'),
    clock,
    cwd,
  )
  const broad = takeClaim({ subject: 'path:src/**' }, env('requester'), clock + 2, cwd)
  expect(broad.previousClaimIds).toEqual([first.id, second.id])
  const history = listClaims(undefined, true, env('requester'), clock + 2, cwd).claims
  expect(history.slice(0, 2).map((claim) => claim.supersededByClaimId)).toEqual([
    broad.id,
    broad.id,
  ])
  expect(claimNoticesFor('first-holder', clock + 3)).toHaveLength(1)
  expect(claimNoticesFor('second-holder', clock + 3)).toHaveLength(1)
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
  const next = takeClaim({ subject: 'task:DEV-1' }, env('other'), clock + 101, cwd)
  expect(next.action).toBe('taken-over')
  expect(listClaims(undefined, true, env('holder'), clock + 101, cwd).claims[0]).toMatchObject({
    id: claim.id,
    closeReason: 'run-ended',
    supersededByClaimId: next.id,
  })
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

test('an architect environment may release task claims', () => {
  const { cwd, project } = fixtureProject()
  const clock = Date.now()
  const claim = takeClaim({ subject: 'task:DEV-1' }, env('holder'), clock, cwd)
  expect(releaseTaskClaims('DEV-1', project, env('architect'), clock + 1)).toEqual({ released: 1 })
  expect(listClaims(undefined, true, env('architect'), clock + 1, cwd).claims[0]).toMatchObject({
    id: claim.id,
    closeReason: 'task-closed',
  })
})

test('a rate-limited claim notice does not replace the conflict refusal', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  presence('holder', null, clock)
  takeClaim({ subject: 'resource:gpu' }, env('holder'), clock, cwd)
  for (let index = 0; index < BOARD_POST_RATE_LIMIT; index++)
    postNotice(
      { audience: 'operator', title: `Notice ${index}`, body: `Rate-cap fixture ${index}.` },
      env('requester'),
      clock,
      cwd,
    )
  expect(() => takeClaim({ subject: 'resource:gpu' }, env('requester'), clock + 1, cwd)).toThrow(
    /claim conflicts with: session holder/,
  )
  expect(claimNoticesFor('holder', clock + 2)).toEqual([])
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

test('a stale architect presence with a live task claim reaches only that task audience', () => {
  const { cwd } = fixtureProject()
  const clock = Date.now()
  presence('stale-holder', null, clock - SESSION_LIVE_MS - 1)
  takeClaim({ subject: 'task:DEV-9' }, env('stale-holder'), clock, cwd)
  const task = postNotice(
    { audience: 'task:DEV-9', title: 'Task notice', body: 'For the live task claim.' },
    {},
    clock + 1,
    cwd,
  )
  expect(task.reached).toBe(1)
  for (const [audience, title] of [
    ['architects', 'Architect notice'],
    ['machine:test', 'Machine notice'],
    ['session:stale-holder', 'Session notice'],
  ] as const)
    expect(
      postNotice({ audience, title, body: 'Not for a stale session.' }, {}, clock + 1, cwd).reached,
    ).toBe(0)
})

test('a task claim tied to an ended chain does not put its holder in the task audience', () => {
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
  takeClaim({ subject: 'task:DEV-9', runId }, env('holder'), clock, cwd)
  db().query("UPDATE run SET status='ok' WHERE id=?").run(runId)
  const posted = postNotice(
    {
      audience: 'task:DEV-9',
      title: 'Ended claim',
      body: 'No live task readers.',
    },
    {},
    clock + 1,
    cwd,
  )
  expect(posted.reached).toBe(0)
})
