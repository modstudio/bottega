import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import * as resourceOwnership from '../resources/resource-ownership.ts'
import { candidates } from '../route/route.ts'
import { PENDING_BOOTSTRAP_MS } from './run-bootstrap.ts'
import { recordCoordinatorCause, runCoordinatorLogPath } from './run-coordinator-log.ts'
import { runInboxCommand } from './run-inbox.ts'
import { reapStale } from './run-liveness.ts'
import { STALE_AFTER_MS } from './run-liveness-policy.ts'
import { sharedGitConfigCheckSkipReason } from './shared-git-config-check.ts'

const noSharedGitConfigCheck = () => null

beforeEach(() => {
  spyOn(resourceOwnership, 'teardownTerminalRunResources').mockReturnValue({
    complete: true,
    errors: [],
    removed: 0,
    skipped: false,
    outcome: 'nothing',
    reason: null,
  })
})

afterEach(() => {
  mock.restore()
})

test('shared git config skip reasons prioritize a live vendor over worktree sharers', () => {
  expect(
    sharedGitConfigCheckSkipReason({
      vendorPid: 42,
      vendorAlive: true,
      worktree: '/trees/shared',
      sharerCount: 1,
    }),
  ).toBe('shared git config check skipped: vendor pid 42 is still alive')
  expect(
    sharedGitConfigCheckSkipReason({
      vendorPid: 42,
      vendorAlive: false,
      worktree: '/trees/shared',
      sharerCount: 1,
    }),
  ).toBe('shared git config check skipped: another live run still claims /trees/shared')
  expect(
    sharedGitConfigCheckSkipReason({
      vendorPid: null,
      vendorAlive: false,
      worktree: null,
      sharerCount: 0,
    }),
  ).toBeNull()
})

async function inbox(): Promise<string> {
  const lines: string[] = []
  await runInboxCommand(
    { has: () => false },
    {
      log: (...values) => lines.push(values.join(' ')),
      dur: (ms) => String(ms ?? 0),
      chainHasPendingDelivery: (root) =>
        Boolean(
          db()
            .query(
              `SELECT 1 FROM question q JOIN run r ON r.record_id=q.run_record_id
               WHERE (r.record_id=? OR r.parent_run_record_id=?) AND q.delivery_pending_at IS NOT NULL`,
            )
            .get(root, root),
        ),
      strandedRecovery: (root) => `stranded — ${PLATFORM_SLUG} run retry ${root} --agent`,
    },
  )
  return lines.join('\n')
}

const runNumber = (recordId: string): number =>
  (
    db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as {
      number: number
    }
  ).number

describe('reapStale', () => {
  test('elapsed time does not kill a legacy run while its pid is alive', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    // process.pid is certainly alive: this is the recycled-pid case, and the
    // elapsed time must not decide liveness.
    db()
      .query('UPDATE run SET started_at=?, pid=? WHERE record_id=?')
      .run(new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString(), process.pid, id)

    expect(reapStale(db(), noSharedGitConfigCheck)).toBe(0)
    expect(
      (
        db().query('SELECT status FROM run WHERE record_id=?').get(id) as {
          status: string
        }
      ).status,
    ).toBe('running')
    expect(
      db().query('SELECT rowid FROM run_mutation_audit WHERE run_record_id=?').get(id),
    ).toBeNull()
  })

  test('a recent run whose process is gone is swept at once, not in thirty minutes', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    // Nothing owns pid 2^22; it is above every configured pid_max.
    db().query('UPDATE run SET pid=?, agent_pid=? WHERE record_id=?').run(4194304, 4194304, id)
    const prior = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = 'session-B'
    try {
      expect(reapStale(db(), noSharedGitConfigCheck)).toBe(1)
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = prior
    }
    expect(
      db()
        .query('SELECT action, actor_session, reason FROM run_mutation_audit WHERE run_record_id=?')
        .get(id),
    ).toEqual({
      action: 'reap',
      actor_session: 'session-B',
      reason: 'pid 4194304 is not alive',
    })
  })

  test('a stale writing run checks shared config before recording its terminal result', () => {
    const id = addRun({ agent: 'grok', job: 'implement', status: 'running' })
    db()
      .query('UPDATE run SET pid=?, agent_pid=?, worktree=? WHERE record_id=?')
      .run(4194304, 4194304, '/trees/run', id)
    const checked: unknown[] = []

    expect(
      reapStale(db(), (input) => {
        checked.push(input)
        return 'shared git config changed: user.name (changed; value names run tree: no) in /repo/.git/config'
      }),
    ).toBe(1)
    expect(checked).toEqual([{ runId: id, job: 'implement', worktree: '/trees/run' }])
    expect(
      (
        db().query('SELECT error FROM run WHERE record_id=?').get(id) as {
          error: string
        }
      ).error,
    ).toContain('shared git config changed: user.name')
  })

  test('a stale run keeps shared config untouched while its vendor is alive', () => {
    const id = addRun({ agent: 'grok', job: 'implement', status: 'running' })
    db()
      .query('UPDATE run SET pid=?, agent_pid=?, worktree=? WHERE record_id=?')
      .run(4194304, process.pid, '/trees/run', id)
    let checks = 0

    expect(
      reapStale(db(), () => {
        checks++
        return null
      }),
    ).toBe(1)
    expect(checks).toBe(0)
    expect(
      (db().query('SELECT error FROM run WHERE record_id=?').get(id) as { error: string }).error,
    ).toContain(`vendor pid ${process.pid} is still alive`)
  })

  test('a stale run keeps shared config untouched while another live run claims its tree', () => {
    const id = addRun({ agent: 'grok', job: 'implement', status: 'running' })
    const sharer = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db()
      .query('UPDATE run SET pid=?, agent_pid=?, worktree=? WHERE record_id=?')
      .run(4194304, 4194304, '/trees/shared', id)
    db()
      .query('UPDATE run SET pid=?, worktree=? WHERE record_id=?')
      .run(process.pid, '/trees/shared', sharer)
    let checks = 0

    expect(
      reapStale(db(), () => {
        checks++
        return null
      }),
    ).toBe(1)
    expect(checks).toBe(0)
    expect(
      (db().query('SELECT error FROM run WHERE record_id=?').get(id) as { error: string }).error,
    ).toContain('another live run still claims /trees/shared')
  })

  test('a competing stale reaper does not run the shared config check after losing the status guard', () => {
    const id = addRun({ agent: 'grok', job: 'implement', status: 'running' })
    db()
      .query('UPDATE run SET pid=?, agent_pid=?, worktree=? WHERE record_id=?')
      .run(4194304, 4194304, '/trees/run', id)
    let winnerChecks = 0
    let loserChecks = 0

    expect(
      reapStale(db(), () => {
        winnerChecks++
        expect(
          reapStale(db(), () => {
            loserChecks++
            return null
          }),
        ).toBe(0)
        return null
      }),
    ).toBe(1)
    expect(winnerChecks).toBe(1)
    expect(loserChecks).toBe(0)
  })

  test('the reaper says WHY it swept, so routing can discount it', () => {
    // Without the kind these rows are indistinguishable from an agent that
    // simply failed, and the router charges them accordingly.
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=?, agent_pid=? WHERE record_id=?').run(4194304, 4194304, id)
    reapStale(db(), noSharedGitConfigCheck)
    const r = db()
      .query('SELECT status, failure_kind, error FROM run WHERE record_id=?')
      .get(id) as {
      status: string
      failure_kind: 'interrupted'
      error: string
    }
    expect(r.status).toBe('stale')
    expect(r.failure_kind).toBe('interrupted')
    expect(r.error).toBe('abandoned: process gone, no terminal state recorded')
    expect(NOT_EVIDENCE).toContain(r.failure_kind)
  })

  test('a legacy run with no lease and no pid is swept at once', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=NULL WHERE record_id=?').run(id)
    expect(reapStale(db(), noSharedGitConfigCheck)).toBe(1)
  })

  test('a live recent run is left alone', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=? WHERE record_id=?').run(process.pid, id)
    expect(reapStale(db(), noSharedGitConfigCheck)).toBe(0)
  })

  test('reaping a running child inherits stale onto an asking root as evidence', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id, asked_at, question, answer, answered_at)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?,?)`,
      )
      .run(root, nowIso(), 'answered', 'the ruling', nowIso())
    const child = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'running',
      parent: root,
      turn: 2,
    })
    db().query('UPDATE run SET pid=?, agent_pid=? WHERE record_id=?').run(4194304, 4194304, child)

    expect(reapStale(db(), noSharedGitConfigCheck)).toBe(1)
    expect(db().query('SELECT status, failure_kind FROM run WHERE record_id=?').get(child)).toEqual(
      {
        status: 'stale',
        failure_kind: 'interrupted',
      },
    )
    expect(db().query('SELECT status, failure_kind FROM run WHERE record_id=?').get(root)).toEqual({
      status: 'stale',
      failure_kind: null,
    })
    const childPayload = db()
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM outbox
         WHERE kind='run' AND row_id=(SELECT record_id FROM run WHERE record_id=?)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(child)!
    expect(JSON.parse(childPayload.payload)).toMatchObject({
      localId: runNumber(child),
      status: 'stale',
      failureKind: 'interrupted',
    })
    const rootPayload = db()
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM outbox
         WHERE kind='run' AND row_id=(SELECT record_id FROM run WHERE record_id=?)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(root)!
    expect(JSON.parse(rootPayload.payload)).toMatchObject({
      localId: runNumber(root),
      status: 'stale',
      failureKind: null,
    })
    const grok = candidates('implement').find((c) => c.agent === 'grok')!
    expect(grok.failures).toBe(1)
    expect(grok.evidence).toBe(1)
  })

  test('reaping a running child retires an answered pending delivery after root roll-up', async () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db()
      .query(
        `INSERT INTO question
          (number,record_id,run_record_id,asked_at,question,answer,answered_at,delivery_pending_at)
         VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?,?,?)`,
      )
      .run(root, nowIso(), 'answered', 'the ruling', nowIso(), nowIso())
    const child = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'running',
      parent: root,
      turn: 2,
    })
    db().query('UPDATE run SET pid=?, agent_pid=? WHERE record_id=?').run(4194304, 4194304, child)

    expect(reapStale(db(), noSharedGitConfigCheck)).toBe(1)
    expect(db().query('SELECT status FROM run WHERE record_id=?').get(root)).toEqual({
      status: 'stale',
    })
    expect(
      db().query('SELECT delivery_pending_at FROM question WHERE run_record_id=?').get(root),
    ).toEqual({ delivery_pending_at: null })
    expect(
      db()
        .query(
          `SELECT outcome,error FROM question_delivery
           WHERE question_record_id=(SELECT record_id FROM question WHERE run_record_id=?)`,
        )
        .get(root),
    ).toEqual({ outcome: 'retired', error: 'chain-stale' })
    expect(await inbox()).not.toContain(`run ${root}`)
  })

  test('a pid-less (pending) row older than the bootstrap bound is failed/harness', () => {
    const root = addRun({ agent: 'codex', job: 'craft', status: 'asking' })
    const old = addRun({
      agent: '(pending)',
      job: 'craft',
      status: 'running',
      parent: root,
      turn: 2,
    })
    const young = addRun({
      agent: '(pending)',
      job: 'craft',
      status: 'running',
    })
    db()
      .query('UPDATE run SET pid=NULL, started_at=? WHERE record_id=?')
      .run(new Date(Date.now() - PENDING_BOOTSTRAP_MS - 1000).toISOString(), old)
    db()
      .query('UPDATE run SET pid=NULL, started_at=? WHERE record_id=?')
      .run(new Date(Date.now() - 10_000).toISOString(), young)

    expect(reapStale(db(), noSharedGitConfigCheck)).toBe(1)
    const swept = db()
      .query('SELECT status, failure_kind, error FROM run WHERE record_id=?')
      .get(old) as {
      status: string
      failure_kind: string
      error: string
    }
    expect(swept).toEqual({
      status: 'failed',
      failure_kind: 'harness',
      error: 'coordinator exited during setup before the agent started; last output: (no output)',
    })
    const payload = db()
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM outbox
         WHERE kind='run' AND row_id=(SELECT record_id FROM run WHERE record_id=?)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(old)!
    expect(JSON.parse(payload.payload)).toMatchObject({
      localId: runNumber(old),
      status: 'failed',
      failureKind: 'harness',
    })
    expect(
      (
        db().query('SELECT status FROM run WHERE record_id=?').get(young) as {
          status: string
        }
      ).status,
    ).toBe('running')
  })

  test('a pending row with a dead recorded pid past the bootstrap bound is failed/harness', () => {
    const id = addRun({ agent: '(pending)', job: 'craft', status: 'running' })
    db()
      .query('UPDATE run SET pid=?, started_at=? WHERE record_id=?')
      .run(4_194_304, new Date(Date.now() - PENDING_BOOTSTRAP_MS - 1000).toISOString(), id)

    expect(reapStale(db(), noSharedGitConfigCheck)).toBe(1)
    expect(
      db().query('SELECT status, failure_kind, error FROM run WHERE record_id=?').get(id),
    ).toEqual({
      status: 'failed',
      failure_kind: 'harness',
      error: 'coordinator exited during setup before the agent started; last output: (no output)',
    })
  })

  test('a pending claim refusal reaches the run error through the coordinator log', () => {
    const id = addRun({
      agent: '(pending)',
      job: 'implement',
      status: 'running',
    })
    db()
      .query('UPDATE run SET pid=?, started_at=? WHERE record_id=?')
      .run(4_194_304, new Date(Date.now() - PENDING_BOOTSTRAP_MS - 1000).toISOString(), id)
    const recordId = db()
      .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
      .get(id)!.record_id
    const logPath = runCoordinatorLogPath(recordId)
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(
      logPath,
      `orch: run ${id} could not start: Error: refusing to create a worktree on branch DEV-1054-orch-7738\n`,
    )

    expect(reapStale(db(), noSharedGitConfigCheck)).toBe(1)
    expect(db().query('SELECT error FROM run WHERE record_id=?').get(id)).toEqual({
      error:
        `coordinator exited during setup before the agent started; last output: ` +
        `orch: run ${id} could not start: Error: refusing to create a worktree on branch DEV-1054-orch-7738`,
    })
  })

  test('a claimed coordinator that died before starting an agent is failed/harness with its log tail', () => {
    const root = addRun({ agent: 'codex', job: 'craft', status: 'asking' })
    const id = addRun({
      agent: 'codex',
      job: 'craft',
      status: 'running',
      parent: root,
      turn: 2,
    })
    db().query('UPDATE run SET pid=?, agent_pid=NULL WHERE record_id=?').run(4_194_304, id)
    const recordId = db()
      .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
      .get(id)!.record_id
    const logPath = runCoordinatorLogPath(recordId)
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(logPath, 'setup began\nmodule import failed\n')

    expect(reapStale(db(), noSharedGitConfigCheck)).toBe(1)
    const error =
      'coordinator exited during setup before the agent started; last output: setup began\nmodule import failed'
    expect(
      db().query('SELECT status, failure_kind, error FROM run WHERE record_id=?').get(id),
    ).toEqual({
      status: 'failed',
      failure_kind: 'harness',
      error,
    })
    const payload = db()
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM outbox
         WHERE kind='run' AND row_id=(SELECT record_id FROM run WHERE record_id=?)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(id)!
    expect(JSON.parse(payload.payload)).toMatchObject({
      localId: runNumber(id),
      status: 'failed',
      failureKind: 'harness',
      error,
    })
    expect(
      db().query('SELECT action, reason FROM run_mutation_audit WHERE run_record_id=?').get(id),
    ).toEqual({ action: 'reap', reason: error })
  })

  test('a claimed setup death with no coordinator output says so', () => {
    const id = addRun({ agent: 'codex', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=?, agent_pid=NULL WHERE record_id=?').run(4_194_304, id)

    expect(reapStale(db(), noSharedGitConfigCheck)).toBe(1)
    expect(
      db().query('SELECT status, failure_kind, error FROM run WHERE record_id=?').get(id),
    ).toEqual({
      status: 'failed',
      failure_kind: 'harness',
      error: 'coordinator exited during setup before the agent started; last output: (no output)',
    })
  })

  test('a reaped coordinator whose agent started records its preserved migration cause', () => {
    const id = addRun({ agent: 'codex', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=?, agent_pid=? WHERE record_id=?').run(4_194_304, 4_194_305, id)
    const cause =
      "store migrated from version 145 to 146 past this process's version; restart this process, and re-dispatch any run it was coordinating"
    recordCoordinatorCause(id, cause)

    expect(reapStale(db(), noSharedGitConfigCheck)).toBe(1)
    expect(
      db().query('SELECT status, failure_kind, error FROM run WHERE record_id=?').get(id),
    ).toEqual({ status: 'failed', failure_kind: 'harness', error: cause })
  })

  test('a setup death continuation preserves the scored root as routing evidence', () => {
    const root = addRun({ agent: 'codex', job: 'craft', status: 'ok' })
    score(root, 'full', 'right')
    const child = addRun({
      agent: 'codex',
      job: 'craft',
      status: 'running',
      parent: root,
      turn: 2,
    })
    db().query('UPDATE run SET pid=?, agent_pid=NULL WHERE record_id=?').run(4_194_304, child)

    expect(reapStale(db(), noSharedGitConfigCheck)).toBe(1)
    expect(db().query('SELECT status, failure_kind FROM run WHERE record_id=?').get(child)).toEqual(
      {
        status: 'failed',
        failure_kind: 'harness',
      },
    )
    expect(db().query('SELECT status, failure_kind FROM run WHERE record_id=?').get(root)).toEqual({
      status: 'failed',
      failure_kind: null,
    })
    expect(candidates('craft').find((candidate) => candidate.agent === 'codex')).toMatchObject({
      evidence: 1,
      scored: 1,
      failures: 0,
    })
  })
})
