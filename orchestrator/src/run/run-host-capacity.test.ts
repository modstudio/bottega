import { describe, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { HostLoad } from '../gate-load.ts'
import {
  RUN_HOST_WAIT_MAX_MS,
  runHostCapacityQueue,
  startRunAfterHostCapacity,
  waitForRunHostCapacity,
} from './run-host-capacity.ts'

const loaded = (): HostLoad => ({
  gates: 0,
  loadavg: 16,
  ncpu: 8,
  freeMem: 8 * 1024 * 1024 * 1024,
  pressure: 'unknown',
  swapUsed: 0,
  swapTotal: 0,
  recentAdmissions: 0,
  waitingRequests: 0,
  oldestWaitMs: 0,
})

const repositoryRun = (repo: string | null = '/repo') => {
  const runId = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'running',
    repo: repo ?? undefined,
  })
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run(`/worktrees/${runId}`, runId)
  return runId
}

describe('run host capacity', () => {
  test('a run never counts itself as held work', async () => {
    const runId = repositoryRun()
    let slept = false
    expect(
      await waitForRunHostCapacity({
        database: db(),
        runId,
        env: {},
        platform: 'linux',
        measure: loaded,
        sleep: async () => {
          slept = true
        },
      }),
    ).toBeNull()
    expect(slept).toBe(false)
  })

  test('an unregistered checkout is repository work for admission', async () => {
    repositoryRun(null)
    const runId = repositoryRun(null)
    let now = 0
    const result = await waitForRunHostCapacity({
      database: db(),
      runId,
      env: {},
      platform: 'linux',
      measure: loaded,
      now: () => now,
      sleep: async () => {
        now = RUN_HOST_WAIT_MAX_MS
      },
    })
    expect(result).toMatchObject({ outcome: 'admitted', heldOn: ['load'], boundReached: true })
  })

  test('a waiter is not held work and the oldest waiter gets solo admission', async () => {
    const runId = repositoryRun()
    const waiter = repositoryRun()
    db()
      .query('UPDATE run SET host_wait_since=? WHERE record_id=?')
      .run('2026-01-01T00:00:01.000Z', waiter)
    expect(
      await waitForRunHostCapacity({
        database: db(),
        runId,
        env: {},
        platform: 'linux',
        measure: loaded,
      }),
    ).toBeNull()
  })

  test('waiters are admitted in arrival order', async () => {
    const older = repositoryRun()
    const younger = repositoryRun()
    db()
      .query('UPDATE run SET host_wait_since=? WHERE record_id=?')
      .run('2026-01-01T00:00:00.000Z', older)
    db()
      .query('UPDATE run SET host_wait_since=? WHERE record_id=?')
      .run('2026-01-01T00:00:01.000Z', younger)
    let now = Date.parse('2026-01-01T00:00:01.000Z')
    const result = await waitForRunHostCapacity({
      database: db(),
      runId: younger,
      env: {},
      platform: 'linux',
      measure: loaded,
      now: () => now,
      sleep: async (ms) => {
        now += ms
        db().query("UPDATE run SET status='ok', host_wait_since=NULL WHERE record_id=?").run(older)
      },
    })
    expect(result).toMatchObject({ outcome: 'admitted', heldOn: ['queue'] })
  })

  test('a long-running agent with a recent event is not a recent admission', async () => {
    const now = Date.parse('2026-01-01T00:02:00.000Z')
    const established = repositoryRun()
    db()
      .query('UPDATE run SET agent_start_time=?, last_event_at=? WHERE record_id=?')
      .run(
        new Date(now - 2 * 60_000).toUTCString(),
        new Date(now - 1_000).toISOString(),
        established,
      )
    const runId = repositoryRun()
    let slept = false
    expect(
      await waitForRunHostCapacity({
        database: db(),
        runId,
        env: {},
        platform: 'linux',
        now: () => now,
        measure: () => ({ ...loaded(), loadavg: 7 }),
        sleep: async () => {
          slept = true
        },
      }),
    ).toBeNull()
    expect(slept).toBe(false)
  })

  test('holding records host_wait_since before sleeping', async () => {
    repositoryRun()
    const runId = repositoryRun()
    let recorded: string | null = null
    const result = await waitForRunHostCapacity({
      database: db(),
      runId,
      env: {},
      platform: 'linux',
      measure: loaded,
      sleep: async () => {
        recorded = (
          db().query('SELECT host_wait_since FROM run WHERE record_id=?').get(runId) as {
            host_wait_since: string | null
          }
        ).host_wait_since
        db().query("UPDATE run SET status='stopped' WHERE record_id=?").run(runId)
      },
    })
    expect(recorded).not.toBeNull()
    expect(result?.outcome).toBe('stopped')
  })

  test('an admitted wait does not spawn when the final running check fails', async () => {
    let spawned = false
    const result = await startRunAfterHostCapacity({
      wait: async () => ({
        outcome: 'admitted',
        waitedMs: 1,
        heldOn: ['load'],
        boundReached: false,
      }),
      isRunning: () => false,
      spawn: async () => {
        spawned = true
        return 'handle'
      },
      stop: async () => {},
    })
    expect(result.handle).toBeNull()
    expect(spawned).toBe(false)
  })

  test('a stop while transport start resolves cancels the child before it is returned', async () => {
    const runId = repositoryRun()
    let cancelled = false
    const fakeTransport = {
      start: async () => {
        db()
          .query("UPDATE run SET status='stopped', host_wait_since=NULL WHERE record_id=?")
          .run(runId)
        return { pid: 123 }
      },
      cancel: async (_handle: { pid: number }) => {
        cancelled = true
      },
    }
    const result = await startRunAfterHostCapacity({
      wait: async () => null,
      isRunning: () =>
        (db().query('SELECT status FROM run WHERE record_id=?').get(runId) as { status: string })
          .status === 'running',
      spawn: () => fakeTransport.start(),
      stop: (handle) => fakeTransport.cancel(handle),
    })
    expect(result.handle).toBeNull()
    expect(cancelled).toBe(true)
  })

  test('a stop during the wait prevents the spawn', async () => {
    const blocker = repositoryRun()
    db()
      .query('UPDATE run SET last_event_at=? WHERE record_id=?')
      .run(new Date().toISOString(), blocker)
    const runId = repositoryRun()
    let spawned = false
    const result = await startRunAfterHostCapacity({
      wait: () =>
        waitForRunHostCapacity({
          database: db(),
          runId,
          env: {},
          platform: 'linux',
          measure: loaded,
          sleep: async () => {
            db().query("UPDATE run SET status='stopped' WHERE record_id=?").run(runId)
          },
        }),
      isRunning: () =>
        (db().query('SELECT status FROM run WHERE record_id=?').get(runId) as { status: string })
          .status === 'running',
      spawn: async () => {
        spawned = true
        return 'handle'
      },
      stop: async () => {},
    })
    expect(result.handle).toBeNull()
    expect(result.wait?.outcome).toBe('stopped')
    expect(spawned).toBe(false)
    expect(db().query('SELECT host_wait_since FROM run WHERE record_id=?').get(runId)).toEqual({
      host_wait_since: null,
    })
  })

  test('the queue summary is empty when no run is waiting', () => {
    repositoryRun()
    expect(
      runHostCapacityQueue(db(), Date.parse('2026-01-01T00:01:00.000Z'), {
        env: {},
        platform: 'linux',
        measure: loaded,
      }),
    ).toEqual({ waiting: 0, oldestWaitMs: 0, heldOn: [] })
  })

  test('the queue summary uses the oldest waiter and the head hold reason', () => {
    repositoryRun()
    const older = repositoryRun()
    const younger = repositoryRun()
    db()
      .query('UPDATE run SET host_wait_since=? WHERE record_id=?')
      .run('2026-01-01T00:00:00.000Z', older)
    db()
      .query('UPDATE run SET host_wait_since=? WHERE record_id=?')
      .run('2026-01-01T00:00:10.000Z', younger)
    expect(
      runHostCapacityQueue(db(), Date.parse('2026-01-01T00:01:00.000Z'), {
        env: {},
        platform: 'linux',
        measure: loaded,
      }),
    ).toEqual({ waiting: 2, oldestWaitMs: 60_000, heldOn: ['load'] })
  })

  test('the wait bound starts the run and records contention', async () => {
    const blocker = repositoryRun()
    db()
      .query('UPDATE run SET last_event_at=? WHERE record_id=?')
      .run(new Date().toISOString(), blocker)
    const runId = repositoryRun()
    let now = 0
    let spawned = false
    const result = await startRunAfterHostCapacity({
      wait: () =>
        waitForRunHostCapacity({
          database: db(),
          runId,
          env: {},
          platform: 'linux',
          measure: loaded,
          now: () => now,
          sleep: async () => {
            now = RUN_HOST_WAIT_MAX_MS
          },
        }),
      isRunning: () => true,
      spawn: async () => {
        spawned = true
        return 'handle'
      },
      stop: async () => {},
    })
    expect(result.wait).toMatchObject({ outcome: 'admitted', boundReached: true })
    expect(spawned).toBe(true)
    expect(
      db()
        .query(
          "SELECT cause FROM contention WHERE run_record_id=? AND resource_key='host-capacity'",
        )
        .get(runId),
    ).toEqual({ cause: 'load:bound-reached' })
  })
})
