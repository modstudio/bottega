import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { discardRun } from '../cleanup/cleanup.ts'
import * as closeOut from '../close/close-out.ts'
import { cleanFixture, closeOutFixture } from '../close/reader-scratch-close-out.fixture.ts'
import { db } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import * as dockerResources from '../resources/docker-resources.ts'
import { candidates } from '../route/route.ts'
import { enqueueRunRecord } from './run-outbox.ts'
import type { RunProcessTerminationPlan, TerminateRunProcessesResult } from './run-process.ts'
import { abandonRun, stoppedRunLine, stopRun, stopTerminationRefusal } from './run-stop.ts'

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
  id: string,
  opts: {
    note?: string
    checkpoint?: (name: string) => void
    plan?: () => RunProcessTerminationPlan
    terminate?: () => TerminateRunProcessesResult
    checkSharedGitConfig?: () => string | null
  } = {},
) {
  const shown = presentation()
  try {
    const options = { force: false, auditReason: null, note: opts.note, presentation: shown.value }
    const helpers = {
      lifecycleCheckpoint: opts.checkpoint ?? (() => {}),
      planRunProcessTermination: opts.plan ?? (() => ({ outcome: 'no-pid' as const })),
      terminateRunProcesses: opts.terminate ?? (() => ({ outcome: 'no-pid' as const })),
      checkSharedGitConfig: opts.checkSharedGitConfig ?? (() => null),
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
const verifiedVendor = {
  outcome: 'verified' as const,
  rootPid: 42922,
  pids: [42922],
  pgid: 42922,
  signalGroup: false,
}

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
})

afterEach(() => {
  mock.restore()
})

function runningReaderClone() {
  const fixture = closeOutFixture()
  db()
    .query("UPDATE run SET status='running', session_id=? WHERE record_id=?")
    .run('orch-test-session', fixture.id)
  return fixture
}

async function discardStopped(id: string): Promise<string> {
  const shown = presentation()
  await discardRun(id, { force: false, auditReason: null, presentation: shown.value })
  return shown.lines.join('\n')
}

test('stop reports an identity mismatch with an inspect-then-signal remedy and does not claim stopped', () => {
  expect(
    stopTerminationRefusal({ record_id: '42' }, { outcome: 'identity-mismatch', pid: 42922 }),
  ).toBe(
    'run 42 pid 42922 identity could not be confirmed; the run remains running; after checking ps -p 42922 -o lstart=,command=, run kill -TERM 42922 only if the start time matches the recorded agent_start_time',
  )
})

test('stop reports a vendor that survived SIGKILL after the row is recorded stopped', () => {
  expect(
    stopTerminationRefusal(
      { record_id: '42' },
      { outcome: 'still-alive', pid: 42922, reason: 'process did not exit after SIGKILL' },
    ),
  ).toBe(
    'run 42 is recorded stopped; process 42922 is still alive; after checking ps -p 42922 -o lstart=,command=, run kill -KILL 42922',
  )
})

test('stop uses the plain success line after a proven termination', () => {
  expect(stoppedRunLine('42')).toBe('stopped run 42')
  expect(stopTerminationRefusal({ record_id: '42' }, { outcome: 'no-pid' })).toBeNull()
  expect(stopTerminationRefusal({ record_id: '42' }, { outcome: 'no-vendor' })).toBeNull()
  expect(stopTerminationRefusal({ record_id: '42' }, { outcome: 'gone' })).toBeNull()
  expect(
    stopTerminationRefusal({ record_id: '42' }, { outcome: 'signaled', signaled: [42922] }),
  ).toBeNull()
})

test('abandon retires an asking run from the live inbox and keeps it in all as terminal', async () => {
  const id = insert('asking')
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
    )
    .run(id, new Date().toISOString(), 'which design?')
  expect((await invoke('abandon', id, { note: 'superseded' })).code).toBe(0)
  expect(db().query('SELECT status,error,failure_kind FROM run WHERE record_id=?').get(id)).toEqual(
    {
      status: 'stale',
      error: 'abandoned by architect: superseded',
      failure_kind: 'abandoned',
    },
  )
  expect(
    db()
      .query(
        `SELECT answer,answered_by,answerer_kind,answer_channel,delivery_pending_at
           FROM question WHERE run_record_id=?`,
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
        (number,record_id,run_record_id,asked_at,question,answer,answered_at,delivery_pending_at)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?,?,?)`,
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
    db().query('SELECT answer,delivery_pending_at FROM question WHERE run_record_id=?').get(id),
  ).toEqual({ answer: 'earlier ruling', delivery_pending_at: null })
  expect(
    db()
      .query(
        `SELECT mode,outcome,error FROM question_delivery
         WHERE question_record_id=(SELECT record_id FROM question WHERE run_record_id=?)`,
      )
      .get(id),
  ).toEqual({ mode: 'record-only', outcome: 'retired', error: 'abandoned' })
})

test('a foreign session can neither stop nor abandon an owned run', async () => {
  const running = insert('running')
  const asking = insert('asking')
  db()
    .query('UPDATE run SET session_id=? WHERE record_id IN (?,?)')
    .run('other-session', running, asking)
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
    )
    .run(asking, new Date().toISOString(), 'which shape?')
  expect((await invoke('stop', running)).err).toContain('owned by session other-session')
  expect((await invoke('abandon', asking)).err).toContain('owned by session other-session')
  expect(
    db()
      .query('SELECT status FROM run WHERE record_id IN (?,?) ORDER BY number')
      .all(running, asking),
  ).toEqual([{ status: 'running' }, { status: 'asking' }])
})

test('stop refuses a run that is not running without changing it', async () => {
  const id = insert('ok')
  const result = await invoke('stop', id)
  expect(result.err).toContain(`${id} turn 1 ok`)
  expect(db().query('SELECT status FROM run WHERE record_id=?').get(id)).toEqual({ status: 'ok' })
})

test('stop refuses an identity mismatch and leaves the run running', async () => {
  const id = insert('running')
  db().query('UPDATE run SET pid=?, agent_pid=? WHERE record_id=?').run(42402, 42922, id)
  let terminated = false
  const result = await invoke('stop', id, {
    plan: () => ({ outcome: 'identity-mismatch', pid: 42922 }),
    terminate: () => {
      terminated = true
      return { outcome: 'identity-mismatch', pid: 42922 }
    },
  })
  expect(terminated).toBe(false)
  expect(result.code).toBe(1)
  expect(result.err).toContain('pid 42922 identity could not be confirmed')
  expect(result.err).toContain('the run remains running')
  expect(result.err).toContain('kill -TERM 42922')
  expect(result.out).not.toContain(`stopped run ${id}`)
  expect(db().query('SELECT status FROM run WHERE record_id=?').get(id)).toEqual({
    status: 'running',
  })
})

test('stop refuses when the vendor stays alive after the row is recorded stopped', async () => {
  const id = insert('running')
  db().query('UPDATE run SET pid=?, agent_pid=? WHERE record_id=?').run(42402, 42922, id)
  const result = await invoke('stop', id, {
    plan: () => verifiedVendor,
    terminate: () => ({
      outcome: 'still-alive',
      pid: 42922,
      reason: 'process did not exit after SIGKILL',
    }),
  })
  expect(result.code).toBe(1)
  expect(result.err).toContain('is recorded stopped')
  expect(result.err).toContain('process 42922 is still alive')
  expect(result.err).toContain('kill -KILL 42922')
  expect(db().query('SELECT status FROM run WHERE record_id=?').get(id)).toEqual({
    status: 'stopped',
  })
})

test('stop calls terminate only after the row already reads stopped', async () => {
  const id = insert('running')
  db().query('UPDATE run SET pid=?, agent_pid=? WHERE record_id=?').run(42402, 42922, id)
  const statusesDuringTerminate: string[] = []
  const result = await invoke('stop', id, {
    plan: () => verifiedVendor,
    terminate: () => {
      statusesDuringTerminate.push(
        (db().query('SELECT status FROM run WHERE record_id=?').get(id) as { status: string })
          .status,
      )
      return { outcome: 'signaled', signaled: [42922] }
    },
  })
  expect(statusesDuringTerminate).toEqual(['stopped'])
  expect(result.code).toBe(0)
  expect(result.out).toContain(`stopped run ${id}`)
  expect(db().query('SELECT status FROM run WHERE record_id=?').get(id)).toEqual({
    status: 'stopped',
  })
})

test('stop appends and presents a shared git config result header', async () => {
  const id = insert('running')
  const header = 'shared git config repair failed for core.worktree in /repo/.git/config'

  const result = await invoke('stop', id, { checkSharedGitConfig: () => header })

  expect(result.code).toBe(0)
  expect(result.out).toContain(header)
  expect(
    (db().query('SELECT error FROM run WHERE record_id=?').get(id) as { error: string }).error,
  ).toBe(`stopped by architect\n${header}`)
})

test('abandon appends and presents a shared git config result header', async () => {
  const id = insert('asking')
  const header = 'shared git config repair failed for core.worktree in /repo/.git/config'

  const result = await invoke('abandon', id, { checkSharedGitConfig: () => header })

  expect(result.code).toBe(0)
  expect(result.out).toContain(header)
  expect(
    (db().query('SELECT error FROM run WHERE record_id=?').get(id) as { error: string }).error,
  ).toBe(`abandoned by architect\n${header}`)
})

test('stop records a setup run with no vendor and signals nothing', async () => {
  const id = insert('running')
  db().query('UPDATE run SET pid=? WHERE record_id=?').run(42402, id)
  let terminated = false
  const result = await invoke('stop', id, {
    plan: () => ({ outcome: 'no-vendor' }),
    terminate: () => {
      terminated = true
      return { outcome: 'signaled', signaled: [42402] }
    },
  })
  expect(terminated).toBe(false)
  expect(result.code).toBe(0)
  expect(result.out).toContain(`stopped run ${id}`)
  expect(db().query('SELECT status FROM run WHERE record_id=?').get(id)).toEqual({
    status: 'stopped',
  })
})

test('stopping a running turn records the conversation root as stopped', async () => {
  const root = insert('asking')
  const turn = insert('running')
  db().query('UPDATE run SET parent_run_record_id=?,turn=2 WHERE record_id=?').run(root, turn)
  expect((await invoke('stop', turn)).code).toBe(0)
  expect(
    db()
      .query('SELECT record_id AS id,status FROM run WHERE record_id IN (?,?) ORDER BY number')
      .all(root, turn),
  ).toEqual([
    { id: root, status: 'stopped' },
    { id: turn, status: 'stopped' },
  ])
})

test('stop closes an unanswered question on the chain', async () => {
  const id = insert('running')
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
    )
    .run(id, new Date().toISOString(), 'which design?')
  expect((await invoke('stop', id)).code).toBe(0)
  expect(db().query('SELECT close_reason FROM question WHERE run_record_id=?').get(id)).toEqual({
    close_reason: 'chain-stopped',
  })
})

test('stop by a chain root stops its running child turn', async () => {
  const root = insert('ok')
  const turn = insert('running')
  db().query('UPDATE run SET parent_run_record_id=?,turn=2 WHERE record_id=?').run(root, turn)
  const result = await invoke('stop', root)
  expect(result.out).toContain(`stopped run ${turn}`)
  expect(
    db().query('SELECT action FROM run_mutation_audit WHERE root_run_record_id=?').all(root),
  ).toEqual([{ action: 'stop' }])
})

test('stop omits a reviewed branch that the conversation did not mint', async () => {
  const fixture = runningReaderClone()
  db()
    .query('UPDATE run SET branch=?, minted_branch=NULL WHERE record_id=?')
    .run('DEV-930-orch-6210', fixture.id)
  try {
    const result = await invoke('stop', fixture.id)

    expect(result.out).toContain(`released worktree ${fixture.worktree}`)
    expect(result.out).not.toContain('for continuation')
    expect(result.out).not.toContain('DEV-930-orch-6210')
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

test('stop then discard after a completed reader-clone release', async () => {
  const fixture = runningReaderClone()
  try {
    const result = await invoke('stop', fixture.id)
    expect(result.code).toBe(0)
    expect(result.out).toContain(`released worktree ${fixture.worktree}`)
    expect(
      db().query('SELECT worktree, close_out_outcome FROM run WHERE record_id=?').get(fixture.id),
    ).toEqual({
      worktree: null,
      close_out_outcome: 'released',
    })
    expect(existsSync(fixture.worktree)).toBe(false)
    expect(await discardStopped(fixture.id)).toContain(
      `run ${fixture.id}'s worktree was already released by stop or close-out`,
    )
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

test('stop then discard when the coordinator is absent', async () => {
  const fixture = runningReaderClone()
  db().query('UPDATE run SET pid=? WHERE record_id=?').run(999_999_999, fixture.id)
  try {
    const result = await invoke('stop', fixture.id)
    expect(result.code).toBe(0)
    expect(result.out).toContain(`released worktree ${fixture.worktree}`)
    expect(db().query('SELECT worktree FROM run WHERE record_id=?').get(fixture.id)).toEqual({
      worktree: null,
    })
    expect(await discardStopped(fixture.id)).toContain(
      `run ${fixture.id}'s worktree was already released by stop or close-out`,
    )
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

test('stop then discard when close-out is already recorded', async () => {
  const fixture = runningReaderClone()
  try {
    rmSync(fixture.worktree, { recursive: true, force: true })
    db()
      .query(
        `UPDATE run SET worktree=NULL, close_out_outcome='released',
           close_out_detail='released reader clone' WHERE record_id=?`,
      )
      .run(fixture.id)
    const result = await invoke('stop', fixture.id)
    expect(result.code).toBe(0)
    expect(result.out).toContain(`stopped run ${fixture.id}`)
    expect(result.out).not.toContain('kept worktree')
    expect(result.out).not.toContain('has no worktree to discard')
    expect(await discardStopped(fixture.id)).toContain(
      `run ${fixture.id}'s worktree was already released by stop or close-out`,
    )
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

test('stop and discard agree when clone removal precedes failed close-out recording', async () => {
  const fixture = runningReaderClone()
  spyOn(closeOut, 'closeOutRun').mockImplementation(() => {
    rmSync(fixture.worktree, { recursive: true, force: true })
    throw new Error('recording transaction failed')
  })
  spyOn(dockerResources, 'resourcesForRuns').mockReturnValue({
    ascertainable: true,
    resources: [],
  })
  try {
    const result = await invoke('stop', fixture.id)
    expect(result.code).toBe(0)
    expect(result.out).toContain(`released worktree ${fixture.worktree}`)
    expect(
      db().query('SELECT worktree, close_out_outcome FROM run WHERE record_id=?').get(fixture.id),
    ).toEqual({ worktree: fixture.worktree, close_out_outcome: null })

    expect(await discardStopped(fixture.id)).toContain(
      `run ${fixture.id}'s worktree was already released by stop or close-out`,
    )
    expect(db().query('SELECT worktree FROM run WHERE record_id=?').get(fixture.id)).toEqual({
      worktree: null,
    })
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

test('stop names a branch minted by its conversation', async () => {
  const id = insert('running')
  const branch = `DEV-934-orch-${id}`
  db()
    .query('UPDATE run SET worktree=?, branch=?, minted_branch=? WHERE record_id=?')
    .run('/tmp/writer-tree', branch, branch, id)

  const result = await invoke('stop', id)

  expect(result.out).toContain(
    `kept worktree /tmp/writer-tree and branch ${branch} for continuation`,
  )
  expect(
    db().query('SELECT worktree, close_out_outcome FROM run WHERE record_id=?').get(id),
  ).toEqual({ worktree: '/tmp/writer-tree', close_out_outcome: null })
})

test('stop waits for a concurrent continuation claim and stops the claimed turn', async () => {
  const root = insert('asking')
  let turn = ''
  const result = await invoke('stop', root, {
    checkpoint: () => {
      turn = insert('running')
      db().query('UPDATE run SET parent_run_record_id=?,turn=2 WHERE record_id=?').run(root, turn)
    },
  })
  expect(result.out).toContain(`stopped run ${turn}`)
  expect(db().query('SELECT status FROM run WHERE record_id=?').get(turn)).toEqual({
    status: 'stopped',
  })
})

test('abandon loses cleanly to a concurrent continuation claim', async () => {
  const root = insert('asking')
  let turn = ''
  const result = await invoke('abandon', root, {
    checkpoint: () => {
      turn = insert('running')
      db().query('UPDATE run SET parent_run_record_id=?,turn=2 WHERE record_id=?').run(root, turn)
    },
  })
  expect(result.err).toContain(`${turn} turn 2 running`)
  expect(result.err).toContain(`run ${PLATFORM_SLUG} run stop ${root}`)
  expect(db().query('SELECT status FROM run WHERE record_id=?').get(root)).toEqual({
    status: 'asking',
  })
})

test('stop refuses when its candidate completes before the immediate transaction', async () => {
  const root = insert('asking')
  const turn = insert('running')
  db().query('UPDATE run SET parent_run_record_id=?,turn=2 WHERE record_id=?').run(root, turn)
  const result = await invoke('stop', root, {
    checkpoint: () => {
      db().query("UPDATE run SET status='ok' WHERE record_id=?").run(turn)
    },
  })
  expect(result.err).toContain(`${turn} turn 2 ok`)
  expect(
    db().query('SELECT action FROM run_mutation_audit WHERE root_run_record_id=?').all(root),
  ).toEqual([])
})

test('abandon refuses a completed run without changing it', async () => {
  const id = insert('ok')
  const result = await invoke('abandon', id)
  expect(result.err).toContain(`${id} turn 1 ok`)
  expect(db().query('SELECT status FROM run WHERE record_id=?').get(id)).toEqual({ status: 'ok' })
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
  db().query("UPDATE run SET failure_kind='timeout',error='timed out' WHERE record_id=?").run(root)
  enqueueRunRecord(db(), root, machineId(), new Date().toISOString())
  const child = insert('asking')
  db().query('UPDATE run SET parent_run_record_id=?,turn=2 WHERE record_id=?').run(root, child)
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
    )
    .run(child, new Date().toISOString(), 'child question?')
  expect((await invoke('abandon', child)).code).toBe(0)
  expect(
    db().query('SELECT status,error,failure_kind FROM run WHERE record_id=?').get(root),
  ).toEqual({
    status: 'stale',
    error: 'abandoned by architect',
    failure_kind: 'timeout',
  })
  const rootPayloads = db()
    .query<{ payload: string }, [string]>(
      `SELECT payload FROM outbox
       WHERE kind='run' AND row_id=(SELECT record_id FROM run WHERE record_id=?) ORDER BY id`,
    )
    .all(root)
  expect(rootPayloads.map(({ payload }) => JSON.parse(payload))).toMatchObject([
    { status: 'failed', failureKind: 'timeout' },
    { status: 'stale', failureKind: 'timeout' },
  ])
})

test('abandon by a chain root retires its asking child turn', async () => {
  const root = insert('asking')
  const child = insert('asking')
  db().query('UPDATE run SET parent_run_record_id=?,turn=2 WHERE record_id=?').run(root, child)
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
    )
    .run(child, new Date().toISOString(), 'last question?')
  const result = await invoke('abandon', root, { note: 'superseded' })
  expect(result.out).toContain(`abandoned run ${child}`)
  expect(
    db()
      .query('SELECT record_id AS id,status FROM run WHERE record_id IN (?,?) ORDER BY number')
      .all(root, child),
  ).toEqual([
    { id: root, status: 'stale' },
    { id: child, status: 'stale' },
  ])
})
