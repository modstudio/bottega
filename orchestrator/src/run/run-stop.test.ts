import { beforeEach, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { candidates } from '../route/route.ts'
import {
  abandonRun,
  stoppedRunLine,
  stopRun,
  stopTerminationRefusal,
  type TerminateRunProcessesResult,
} from './run-stop.ts'

const presentation = () => {
  const lines: string[] = []
  return {
    lines,
    value: {
      log: (...values: unknown[]) => lines.push(values.join(' ')),
      error: (...values: unknown[]) => lines.push(values.join(' ')),
      setExitCode: () => {},
      keptBranchLine: (branch: string) => `kept branch ${branch}`,
    },
  }
}
async function invoke(
  action: 'stop' | 'abandon',
  id: number,
  opts: {
    note?: string
    checkpoint?: (name: string) => void
    terminate?: () => TerminateRunProcessesResult
  } = {},
) {
  const shown = presentation()
  try {
    const options = { force: false, auditReason: null, note: opts.note, presentation: shown.value }
    const helpers = {
      lifecycleCheckpoint: opts.checkpoint ?? (() => {}),
      terminateRunProcesses: opts.terminate ?? (() => ({ outcome: 'no-pid' as const })),
    }
    if (action === 'stop') await stopRun(id, options, helpers)
    else await abandonRun(id, options, helpers)
    return { code: 0, out: shown.lines.join('\n'), err: '' }
  } catch (error) {
    return { code: 1, out: shown.lines.join('\n'), err: String(error) }
  }
}
const insert = (status: string, job = 'implement') =>
  addRun({ agent: 'codex', job, status, session: 'orch-test-session' })

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
})

test('stop reports an identity mismatch with an inspect-then-signal remedy and does not claim stopped', () => {
  expect(stopTerminationRefusal({ id: 42 }, { outcome: 'identity-mismatch', pid: 42922 })).toBe(
    'run 42 pid 42922 identity could not be confirmed; the run remains running; after checking ps -p 42922 -o lstart=,command=, run kill -TERM 42922 only if the start time matches the recorded agent_start_time',
  )
})

test('stop reports a vendor that survived SIGKILL and does not claim stopped', () => {
  expect(
    stopTerminationRefusal(
      { id: 42 },
      { outcome: 'still-alive', pid: 42922, reason: 'process did not exit after SIGKILL' },
    ),
  ).toBe(
    'run 42 pid 42922 is still alive after process did not exit after SIGKILL; the run remains running; after checking ps -p 42922 -o lstart=,command=, run kill -TERM 42922',
  )
})

test('stop uses the plain success line after a proven termination', () => {
  expect(stoppedRunLine(42)).toBe('stopped run 42')
  expect(stopTerminationRefusal({ id: 42 }, { outcome: 'no-pid' })).toBeNull()
  expect(stopTerminationRefusal({ id: 42 }, { outcome: 'gone' })).toBeNull()
  expect(stopTerminationRefusal({ id: 42 }, { outcome: 'signaled', signaled: [42922] })).toBeNull()
})

test('abandon retires an asking run from the live inbox and keeps it in all as terminal', async () => {
  const id = insert('asking')
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which design?')
  expect((await invoke('abandon', id, { note: 'superseded' })).code).toBe(0)
  expect(db().query('SELECT status,error,failure_kind FROM run WHERE id=?').get(id)).toEqual({
    status: 'stale',
    error: 'abandoned by architect: superseded',
    failure_kind: 'abandoned',
  })
  expect(
    db()
      .query(
        `SELECT answer,answered_by,answerer_kind,answer_channel,delivery_pending_at
           FROM question WHERE run_id=?`,
      )
      .get(id),
  ).toEqual({
    answer: '(abandoned)',
    answered_by: 'orch-test-session',
    answerer_kind: 'agent',
    answer_channel: 'cli',
    delivery_pending_at: null,
  })
})

test('abandon retires an older answered pending delivery through the chain service', async () => {
  const id = insert('asking')
  db()
    .query(
      `INSERT INTO question
        (run_id,asked_at,question,answer,answered_at,delivery_pending_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      id,
      new Date().toISOString(),
      'earlier question?',
      'earlier ruling',
      new Date().toISOString(),
      new Date().toISOString(),
    )

  expect((await invoke('abandon', id)).code).toBe(0)
  expect(
    db().query('SELECT answer,delivery_pending_at FROM question WHERE run_id=?').get(id),
  ).toEqual({ answer: 'earlier ruling', delivery_pending_at: null })
  expect(
    db()
      .query(
        `SELECT mode,outcome,error FROM question_delivery
         WHERE question_id=(SELECT id FROM question WHERE run_id=?)`,
      )
      .get(id),
  ).toEqual({ mode: 'record-only', outcome: 'retired', error: 'abandoned' })
})

test('a foreign session can neither stop nor abandon an owned run', async () => {
  const running = insert('running')
  const asking = insert('asking')
  db().query('UPDATE run SET session_id=? WHERE id IN (?,?)').run('other-session', running, asking)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(asking, new Date().toISOString(), 'which shape?')
  expect((await invoke('stop', running)).err).toContain('owned by session other-session')
  expect((await invoke('abandon', asking)).err).toContain('owned by session other-session')
  expect(
    db().query('SELECT status FROM run WHERE id IN (?,?) ORDER BY id').all(running, asking),
  ).toEqual([{ status: 'running' }, { status: 'asking' }])
})

test('stop refuses a run that is not running without changing it', async () => {
  const id = insert('ok')
  const result = await invoke('stop', id)
  expect(result.err).toContain(`${id} turn 1 ok`)
  expect(db().query('SELECT status FROM run WHERE id=?').get(id)).toEqual({ status: 'ok' })
})

test('stop refuses an identity mismatch and leaves the run running', async () => {
  const id = insert('running')
  db().query('UPDATE run SET pid=?, agent_pid=? WHERE id=?').run(42402, 42922, id)
  const result = await invoke('stop', id, {
    terminate: () => ({ outcome: 'identity-mismatch', pid: 42922 }),
  })
  expect(result.code).toBe(1)
  expect(result.err).toContain('pid 42922 identity could not be confirmed')
  expect(result.err).toContain('the run remains running')
  expect(result.err).toContain('kill -TERM 42922')
  expect(result.out).not.toContain(`stopped run ${id}`)
  expect(db().query('SELECT status FROM run WHERE id=?').get(id)).toEqual({ status: 'running' })
})

test('stop refuses when the vendor stays alive and leaves the run running', async () => {
  const id = insert('running')
  db().query('UPDATE run SET pid=?, agent_pid=? WHERE id=?').run(42402, 42922, id)
  const result = await invoke('stop', id, {
    terminate: () => ({
      outcome: 'still-alive',
      pid: 42922,
      reason: 'process did not exit after SIGKILL',
    }),
  })
  expect(result.code).toBe(1)
  expect(result.err).toContain('pid 42922 is still alive')
  expect(result.err).toContain('the run remains running')
  expect(db().query('SELECT status FROM run WHERE id=?').get(id)).toEqual({ status: 'running' })
})

test('stop commits stopped only after the vendor is gone', async () => {
  const id = insert('running')
  db().query('UPDATE run SET pid=?, agent_pid=? WHERE id=?').run(42402, 42922, id)
  let statusDuringTerminate: string | undefined
  const result = await invoke('stop', id, {
    terminate: () => {
      statusDuringTerminate = (
        db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }
      ).status
      return { outcome: 'signaled', signaled: [42922] }
    },
  })
  expect(statusDuringTerminate).toBe('running')
  expect(result.code).toBe(0)
  expect(result.out).toContain(`stopped run ${id}`)
  expect(db().query('SELECT status FROM run WHERE id=?').get(id)).toEqual({ status: 'stopped' })
})

test('stopping a running turn records the conversation root as stopped', async () => {
  const root = insert('asking')
  const turn = insert('running')
  db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
  expect((await invoke('stop', turn)).code).toBe(0)
  expect(
    db().query('SELECT id,status FROM run WHERE id IN (?,?) ORDER BY id').all(root, turn),
  ).toEqual([
    { id: root, status: 'stopped' },
    { id: turn, status: 'stopped' },
  ])
})

test('stop closes an unanswered question on the chain', async () => {
  const id = insert('running')
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which design?')
  expect((await invoke('stop', id)).code).toBe(0)
  expect(db().query('SELECT close_reason FROM question WHERE run_id=?').get(id)).toEqual({
    close_reason: 'chain-stopped',
  })
})

test('stop by a chain root stops its running child turn', async () => {
  const root = insert('ok')
  const turn = insert('running')
  db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
  const result = await invoke('stop', root)
  expect(result.out).toContain(`stopped run ${turn}`)
  expect(db().query('SELECT action FROM run_mutation_audit WHERE root_id=?').all(root)).toEqual([
    { action: 'stop' },
  ])
})

test('stop omits a reviewed branch that the conversation did not mint', async () => {
  const id = insert('running', 'review-lens')
  db()
    .query('UPDATE run SET worktree=?, branch=?, minted_branch=NULL WHERE id=?')
    .run('/tmp/review-tree', 'DEV-930-orch-6210', id)

  const result = await invoke('stop', id)

  expect(result.out).toContain('kept worktree /tmp/review-tree for continuation')
  expect(result.out).not.toContain('DEV-930-orch-6210')
})

test('stop names a branch minted by its conversation', async () => {
  const id = insert('running')
  const branch = `DEV-934-orch-${id}`
  db()
    .query('UPDATE run SET worktree=?, branch=?, minted_branch=? WHERE id=?')
    .run('/tmp/writer-tree', branch, branch, id)

  const result = await invoke('stop', id)

  expect(result.out).toContain(
    `kept worktree /tmp/writer-tree and branch ${branch} for continuation`,
  )
})

test('stop waits for a concurrent continuation claim and stops the claimed turn', async () => {
  const root = insert('asking')
  let turn = 0
  const result = await invoke('stop', root, {
    checkpoint: () => {
      turn = insert('running')
      db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
    },
  })
  expect(result.out).toContain(`stopped run ${turn}`)
  expect(db().query('SELECT status FROM run WHERE id=?').get(turn)).toEqual({ status: 'stopped' })
})

test('abandon loses cleanly to a concurrent continuation claim', async () => {
  const root = insert('asking')
  let turn = 0
  const result = await invoke('abandon', root, {
    checkpoint: () => {
      turn = insert('running')
      db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
    },
  })
  expect(result.err).toContain(`${turn} turn 2 running`)
  expect(result.err).toContain(`run orch stop ${root}`)
  expect(db().query('SELECT status FROM run WHERE id=?').get(root)).toEqual({ status: 'asking' })
})

test('stop refuses when its candidate completes before the immediate transaction', async () => {
  const root = insert('asking')
  const turn = insert('running')
  db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
  const result = await invoke('stop', root, {
    checkpoint: () => {
      db().query("UPDATE run SET status='ok' WHERE id=?").run(turn)
    },
  })
  expect(result.err).toContain(`${turn} turn 2 ok`)
  expect(db().query('SELECT action FROM run_mutation_audit WHERE root_id=?').all(root)).toEqual([])
})

test('abandon refuses a completed run without changing it', async () => {
  const id = insert('ok')
  const result = await invoke('abandon', id)
  expect(result.err).toContain(`${id} turn 1 ok`)
  expect(db().query('SELECT status FROM run WHERE id=?').get(id)).toEqual({ status: 'ok' })
})

test('an abandoned run is not routing evidence', async () => {
  const id = insert('asking')
  expect((await invoke('abandon', id)).code).toBe(0)
  const candidate = candidates('implement').find((item) => item.agent === 'codex')!
  expect(candidate.evidence).toBe(0)
  expect(candidate.failures).toBe(0)
})

test("abandoning a resumed turn keeps the root's prior failure kind", async () => {
  const root = insert('failed')
  db().query("UPDATE run SET failure_kind='timeout',error='timed out' WHERE id=?").run(root)
  const child = insert('asking')
  db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, child)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(child, new Date().toISOString(), 'child question?')
  expect((await invoke('abandon', child)).code).toBe(0)
  expect(db().query('SELECT status,error,failure_kind FROM run WHERE id=?').get(root)).toEqual({
    status: 'stale',
    error: 'abandoned by architect',
    failure_kind: 'timeout',
  })
})

test('abandon by a chain root retires its asking child turn', async () => {
  const root = insert('asking')
  const child = insert('asking')
  db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, child)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(child, new Date().toISOString(), 'last question?')
  const result = await invoke('abandon', root, { note: 'superseded' })
  expect(result.out).toContain(`abandoned run ${child}`)
  expect(
    db().query('SELECT id,status FROM run WHERE id IN (?,?) ORDER BY id').all(root, child),
  ).toEqual([
    { id: root, status: 'stale' },
    { id: child, status: 'stale' },
  ])
})
