import { beforeEach,expect,test } from 'bun:test'
import { addRun } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { candidates } from './route.ts'
import { abandonRun,stopRun } from './run-stop.ts'

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
async function invoke(action: 'stop' | 'abandon', id: number, opts: { note?: string; checkpoint?: (name: string) => void } = {}) {
  const shown = presentation()
  try {
    const options = { force: false, auditReason: null, note: opts.note, presentation: shown.value }
    const helpers = { lifecycleCheckpoint: opts.checkpoint ?? (() => {}), terminateRunProcesses: () => {} }
    if (action === 'stop') await stopRun(id, options, helpers)
    else await abandonRun(id, options, helpers)
    return { code: 0, out: shown.lines.join('\n'), err: '' }
  } catch (error) {
    return { code: 1, out: shown.lines.join('\n'), err: String(error) }
  }
}
const insert = (status: string, job = 'implement') =>
  addRun({ agent: 'codex', job, status, session: 'orch-test-session' })

beforeEach(() => { process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session' })

test('abandon retires an asking run from the live inbox and keeps it in all as terminal', async () => {
  const id = insert('asking')
  db().query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which design?')
  expect((await invoke('abandon', id, { note: 'superseded' })).code).toBe(0)
  expect(db().query('SELECT status,error,failure_kind FROM run WHERE id=?').get(id))
    .toEqual({ status: 'stale', error: 'abandoned by architect: superseded', failure_kind: 'abandoned' })
  expect(db().query('SELECT answer,answered_by,delivery_pending_at FROM question WHERE run_id=?').get(id))
    .toEqual({ answer: '(abandoned)', answered_by: 'orch-test-session', delivery_pending_at: null })
})

test('a foreign session can neither stop nor abandon an owned run', async () => {
  const running = insert('running'); const asking = insert('asking')
  db().query('UPDATE run SET session_id=? WHERE id IN (?,?)').run('other-session', running, asking)
  db().query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)').run(asking, new Date().toISOString(), 'which shape?')
  expect((await invoke('stop', running)).err).toContain('owned by session other-session')
  expect((await invoke('abandon', asking)).err).toContain('owned by session other-session')
  expect(db().query('SELECT status FROM run WHERE id IN (?,?) ORDER BY id').all(running, asking))
    .toEqual([{ status: 'running' }, { status: 'asking' }])
})

test('stop refuses a run that is not running without changing it', async () => {
  const id = insert('ok'); const result = await invoke('stop', id)
  expect(result.err).toContain(`${id} turn 1 ok`)
  expect(db().query('SELECT status FROM run WHERE id=?').get(id)).toEqual({ status: 'ok' })
})

test('stopping a running turn records the conversation root as stopped', async () => {
  const root = insert('asking'); const turn = insert('running')
  db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
  expect((await invoke('stop', turn)).code).toBe(0)
  expect(db().query('SELECT id,status FROM run WHERE id IN (?,?) ORDER BY id').all(root, turn))
    .toEqual([{ id: root, status: 'stopped' }, { id: turn, status: 'stopped' }])
})

test('stop by a chain root stops its running child turn', async () => {
  const root = insert('ok'); const turn = insert('running')
  db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
  const result = await invoke('stop', root)
  expect(result.out).toContain(`stopped run ${turn}`)
  expect(db().query('SELECT action FROM run_mutation_audit WHERE root_id=?').all(root)).toEqual([{ action: 'stop' }])
})

test('stop waits for a concurrent continuation claim and stops the claimed turn', async () => {
  const root = insert('asking'); let turn = 0
  const result = await invoke('stop', root, { checkpoint: () => {
    turn = insert('running'); db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
  } })
  expect(result.out).toContain(`stopped run ${turn}`)
  expect(db().query('SELECT status FROM run WHERE id=?').get(turn)).toEqual({ status: 'stopped' })
})

test('abandon loses cleanly to a concurrent continuation claim', async () => {
  const root = insert('asking'); let turn = 0
  const result = await invoke('abandon', root, { checkpoint: () => {
    turn = insert('running'); db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
  } })
  expect(result.err).toContain(`${turn} turn 2 running`)
  expect(db().query('SELECT status FROM run WHERE id=?').get(root)).toEqual({ status: 'asking' })
})

test('stop refuses when its candidate completes before the immediate transaction', async () => {
  const root = insert('asking'); const turn = insert('running')
  db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
  const result = await invoke('stop', root, { checkpoint: () => {
    db().query("UPDATE run SET status='ok' WHERE id=?").run(turn)
  } })
  expect(result.err).toContain(`${turn} turn 2 ok`)
  expect(db().query('SELECT action FROM run_mutation_audit WHERE root_id=?').all(root)).toEqual([])
})

test('abandon refuses a completed run without changing it', async () => {
  const id = insert('ok'); const result = await invoke('abandon', id)
  expect(result.err).toContain(`${id} turn 1 ok`)
  expect(db().query('SELECT status FROM run WHERE id=?').get(id)).toEqual({ status: 'ok' })
})

test('an abandoned run is not routing evidence', async () => {
  const id = insert('asking'); expect((await invoke('abandon', id)).code).toBe(0)
  const candidate = candidates('implement').find((item) => item.agent === 'codex')!
  expect(candidate.evidence).toBe(0); expect(candidate.failures).toBe(0)
})

test("abandoning a resumed turn keeps the root's prior failure kind", async () => {
  const root = insert('failed'); db().query("UPDATE run SET failure_kind='timeout',error='timed out' WHERE id=?").run(root)
  const child = insert('asking'); db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, child)
  db().query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)').run(child, new Date().toISOString(), 'child question?')
  expect((await invoke('abandon', child)).code).toBe(0)
  expect(db().query('SELECT status,error,failure_kind FROM run WHERE id=?').get(root))
    .toEqual({ status: 'stale', error: 'abandoned by architect', failure_kind: 'timeout' })
})

test('abandon by a chain root retires its asking child turn', async () => {
  const root = insert('asking'); const child = insert('asking')
  db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, child)
  db().query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)').run(child, new Date().toISOString(), 'last question?')
  const result = await invoke('abandon', root, { note: 'superseded' })
  expect(result.out).toContain(`abandoned run ${child}`)
  expect(db().query('SELECT id,status FROM run WHERE id IN (?,?) ORDER BY id').all(root, child))
    .toEqual([{ id: root, status: 'stale' }, { id: child, status: 'stale' }])
})
