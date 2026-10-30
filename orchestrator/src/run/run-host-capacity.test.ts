import { describe, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { clearMigrationDrain, setMigrationDrain } from '../database/migration-drain.ts'
import { CAPACITY_SAMPLE_MIN_WINDOW_MS, type HostLoad } from '../gate-load.ts'
import { HOST_RESERVATION_FLOOR_CORES, HOST_RESERVATION_MIN_SAMPLES } from './host-reservation.ts'
import {
  RUN_HOST_CAPACITY_WAITERS_SQL,
  RUN_HOST_RESERVATION_SAMPLES_SQL,
  RUN_HOST_WAIT_MAX_MS,
  RUNNING_REPOSITORY_FACTS_SQL,
  runHostCapacityQueue,
  startRunAfterHostCapacity,
  waitForRunHostCapacity,
} from './run-host-capacity.ts'

const loaded = (): HostLoad => ({
  gates: 0,
  loadavg: 16,
  cpuBusy: 16,
  ncpu: 8,
  freeMem: 8 * 1024 * 1024 * 1024,
  pressure: 'unknown',
  swapUsed: 0,
  swapTotal: 0,
  swapGrowthBytesPerSec: null,
  recentAdmissions: 0,
  waitingRequests: 0,
  oldestWaitMs: 0,
})

const repositoryRun = (repo: string | null = '/repo', agent = 'codex') => {
  const runId = addRun({
    agent,
    job: 'implement',
    status: 'running',
    repo: repo ?? undefined,
  })
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run(`/worktrees/${runId}`, runId)
  return runId
}

const addRecentAdmissions = (count: number, now: number, agent: string) => {
  for (let index = 0; index < count; index++) {
    const runId = repositoryRun('/repo', agent)
    db()
      .query('UPDATE run SET agent_start_time=? WHERE record_id=?')
      .run(new Date(now - 1_000).toISOString(), runId)
  }
}

const addCpuSamples = (count: number, now: number, agent: string, cores: number) => {
  for (let index = 0; index < count; index++) {
    const latency = 1_000
    const startedAt = now - 60_000 - index
    const runId = addRun({
      agent,
      job: 'implement',
      status: 'ok',
      latency,
      startedAt: new Date(startedAt).toISOString(),
    })
    db()
      .query('UPDATE run SET resource_cpu_ms=?, agent_start_time=? WHERE record_id=?')
      .run(cores * latency, new Date(startedAt).toString(), runId)
  }
}

describe('run host capacity', () => {
  test('running repository queries use the partial host-capacity index', () => {
    const plans = [
      db()
        .query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${RUNNING_REPOSITORY_FACTS_SQL}`)
        .all('other-run'),
      db()
        .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${RUN_HOST_CAPACITY_WAITERS_SQL}`)
        .all(),
    ]

    for (const plan of plans) {
      const details = plan.map((step) => step.detail).join('\n')
      expect(details).toContain('run_running_repository_idx')
      expect(details).not.toMatch(/SCAN run(?! USING)/)
    }
  })

  test('the named reservation sample query accepts an agent set', () => {
    expect(
      db()
        .query(RUN_HOST_RESERVATION_SAMPLES_SQL)
        .all('2026-01-01T00:00:00.000Z', JSON.stringify([])),
    ).toEqual([])
  })

  test('a pre-spawn host-capacity waiter stops when a migration drain appears', async () => {
    const runId = repositoryRun()
    repositoryRun()
    let insertedDrain = false
    const result = await waitForRunHostCapacity({
      database: db(),
      runId,
      env: {},
      platform: 'linux',
      measure: loaded,
      sleep: async () => {
        insertedDrain = true
        setMigrationDrain(db(), '0155_rebuild')
      },
    })
    expect(insertedDrain).toBe(true)
    expect(result).toMatchObject({
      outcome: 'stopped',
      heldOn: ['load', 'migration'],
      drainingFor: '0155_rebuild',
    })
    expect(
      (
        db().query('SELECT host_wait_since FROM run WHERE record_id=?').get(runId) as {
          host_wait_since: string | null
        }
      ).host_wait_since,
    ).toBeNull()
    clearMigrationDrain(db())
  })

  test('a resume already waiting for host capacity continues through the draining phase', async () => {
    const runId = repositoryRun()
    const blocker = repositoryRun()
    const result = await waitForRunHostCapacity({
      database: db(),
      runId,
      existingChain: true,
      env: {},
      platform: 'linux',
      measure: loaded,
      sleep: async () => {
        setMigrationDrain(db(), '0155_rebuild')
        db().query("UPDATE run SET status='ok' WHERE record_id=?").run(blocker)
      },
    })
    expect(result).toMatchObject({ outcome: 'admitted', heldOn: ['load'], drainingFor: null })
    clearMigrationDrain(db())
  })

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

  test('sequential siblings reserve capacity from the admitting decision', async () => {
    const now = Date.parse('2026-10-30T12:00:00.000Z')
    const runIds = Array.from({ length: 3 }, () => repositoryRun())
    const sample = () => ({ ...loaded(), loadavg: 1, cpuBusy: 1, ncpu: 2 })

    for (const [index, runId] of runIds.entries()) {
      const result = await waitForRunHostCapacity({
        database: db(),
        runId,
        env: {},
        platform: 'linux',
        now: () => now,
        measure: sample,
        sleep: async () => {
          db().query("UPDATE run SET status='stopped' WHERE record_id=?").run(runId)
        },
      })
      if (index === 0) expect(result).toBeNull()
      else expect(result).toMatchObject({ outcome: 'stopped', heldOn: ['load'] })
    }

    const rows = db()
      .query<{ host_admission_first: string; host_admission: string | null }, [string]>(
        `SELECT host_admission_first,host_admission FROM run
          WHERE record_id IN (SELECT value FROM json_each(?)) ORDER BY number`,
      )
      .all(JSON.stringify(runIds))
    expect(JSON.parse(rows[0]!.host_admission!)).toMatchObject({
      decision: 'admit',
      sample: { recentAdmissions: 0 },
    })
    for (const row of rows.slice(1)) {
      expect(JSON.parse(row.host_admission_first)).toMatchObject({
        decision: 'hold',
        heldOn: ['load'],
        sample: { recentAdmissions: 1 },
      })
      expect(row.host_admission).toBeNull()
    }
  })

  test('an admitted sibling still building its tree is held work for the next decision', async () => {
    const now = Date.parse('2026-10-30T12:00:00.000Z')
    const admitted = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: '/repo' })
    await waitForRunHostCapacity({
      database: db(),
      runId: admitted,
      env: {},
      platform: 'linux',
      now: () => now,
      measure: loaded,
    })
    const sibling = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: '/repo' })

    const result = await waitForRunHostCapacity({
      database: db(),
      runId: sibling,
      env: {},
      platform: 'linux',
      now: () => now,
      measure: loaded,
      sleep: async () => {
        db().query("UPDATE run SET status='stopped' WHERE record_id=?").run(sibling)
      },
    })

    expect(result).toMatchObject({ outcome: 'stopped', heldOn: ['load'] })
    const first = db()
      .query<{ host_admission_first: string }, [string]>(
        'SELECT host_admission_first FROM run WHERE record_id=?',
      )
      .get(sibling)!
    expect(JSON.parse(first.host_admission_first)).toMatchObject({
      decision: 'hold',
      sample: { heldWork: 1 },
    })
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
        measure: () => ({ ...loaded(), loadavg: 7, cpuBusy: 7 }),
        sleep: async () => {
          slept = true
        },
      }),
    ).toBeNull()
    expect(slept).toBe(false)
  })

  test('recent runs reserve the measured cores for their agent', async () => {
    const now = Date.parse('2026-01-01T00:02:00.000Z')
    addRecentAdmissions(12, now, 'codex')
    addCpuSamples(HOST_RESERVATION_MIN_SAMPLES, now, 'codex', 0.05)
    const runId = repositoryRun()
    let slept = false

    expect(
      await waitForRunHostCapacity({
        database: db(),
        runId,
        env: {},
        platform: 'linux',
        now: () => now,
        measure: () => ({ ...loaded(), cpuBusy: 6, ncpu: 16 }),
        sleep: async () => {
          slept = true
        },
      }),
    ).toBeNull()
    expect(slept).toBe(false)
  })

  test('recent runs reserve a full core when their agent has too little evidence', async () => {
    const now = Date.parse('2026-01-01T00:02:00.000Z')
    addRecentAdmissions(12, now, 'grok')
    addCpuSamples(HOST_RESERVATION_MIN_SAMPLES - 1, now, 'grok', 0.05)
    const runId = repositoryRun()

    const result = await waitForRunHostCapacity({
      database: db(),
      runId,
      env: {},
      platform: 'linux',
      now: () => now,
      measure: () => ({ ...loaded(), cpuBusy: 6, ncpu: 16 }),
      sleep: async () => {
        db().query("UPDATE run SET status='stopped' WHERE record_id=?").run(runId)
      },
    })

    expect(result).toMatchObject({ outcome: 'stopped', heldOn: ['load'] })
  })

  test('floor-sized reservations hold when their sum reaches host capacity', async () => {
    const now = Date.parse('2026-01-01T00:02:00.000Z')
    addRecentAdmissions(12, now, 'codex')
    addCpuSamples(HOST_RESERVATION_MIN_SAMPLES, now, 'codex', 0.05)
    const runId = repositoryRun()

    const result = await waitForRunHostCapacity({
      database: db(),
      runId,
      env: {},
      platform: 'linux',
      now: () => now,
      measure: () => ({ ...loaded(), cpuBusy: 13, ncpu: 16 }),
      sleep: async () => {
        db().query("UPDATE run SET status='stopped' WHERE record_id=?").run(runId)
      },
    })

    expect(HOST_RESERVATION_FLOOR_CORES * 12).toBe(3)
    expect(result).toMatchObject({ outcome: 'stopped', heldOn: ['load'] })
    const contention = db()
      .query<{ host_load: string }, [string]>(
        "SELECT host_load FROM contention WHERE run_record_id=? AND resource_key='host-capacity'",
      )
      .get(runId)!
    expect(JSON.parse(contention.host_load)).toMatchObject({
      recentAdmissions: 0,
      reservedCores: 3,
    })
  })

  test('samples CPU before recording a load-average wait', async () => {
    repositoryRun()
    const runId = repositoryRun()
    let now = Date.parse('2026-01-01T00:02:00.000Z')
    let measurements = 0
    const sleeps: number[] = []

    const result = await waitForRunHostCapacity({
      database: db(),
      runId,
      env: {},
      platform: 'linux',
      now: () => now,
      measure: () => ({
        ...loaded(),
        cpuBusy: measurements++ === 0 ? null : 2,
        ncpu: 16,
      }),
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
      },
    })

    expect(result).toBeNull()
    expect(sleeps).toEqual([CAPACITY_SAMPLE_MIN_WINDOW_MS])
    expect(db().query('SELECT host_wait_since FROM run WHERE record_id=?').get(runId)).toEqual({
      host_wait_since: null,
    })
    expect(
      db()
        .query(
          "SELECT count(*) AS count FROM contention WHERE run_record_id=? AND resource_key='host-capacity'",
        )
        .get(runId),
    ).toEqual({ count: 0 })
  })

  test('a second holding decision after a resample records the sampled source', async () => {
    const blocker = repositoryRun()
    const older = repositoryRun()
    db()
      .query('UPDATE run SET host_wait_since=? WHERE record_id=?')
      .run('2026-01-01T00:01:00.000Z', older)
    const runId = repositoryRun()
    let now = Date.parse('2026-01-01T00:02:00.000Z')
    let measurements = 0
    const sleeps: number[] = []
    let recordedWait = false

    const result = await waitForRunHostCapacity({
      database: db(),
      runId,
      env: {},
      platform: 'linux',
      now: () => now,
      random: () => 0.5,
      measure: () => ({
        ...loaded(),
        cpuBusy: measurements++ === 0 ? null : 16,
      }),
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
        if (sleeps.length === 2) {
          recordedWait =
            (
              db().query('SELECT host_wait_since FROM run WHERE record_id=?').get(runId) as {
                host_wait_since: string | null
              }
            ).host_wait_since !== null
          db().query("UPDATE run SET status='ok' WHERE record_id=?").run(blocker)
        }
        if (sleeps.length === 3) {
          setMigrationDrain(db(), '0155_rebuild')
        }
      },
    })

    expect(measurements).toBe(3)
    expect(sleeps).toEqual([CAPACITY_SAMPLE_MIN_WINDOW_MS, 1_000, 2_000])
    expect(recordedWait).toBe(true)
    expect(result).toMatchObject({
      outcome: 'stopped',
      heldOn: ['load', 'queue', 'migration'],
      drainingFor: '0155_rebuild',
    })
    const contention = db()
      .query<{ host_load: string }, [string]>(
        "SELECT host_load FROM contention WHERE run_record_id=? AND resource_key='host-capacity'",
      )
      .get(runId)!
    expect(JSON.parse(contention.host_load)).toMatchObject({
      cpuBusy: 16,
      cpuBusySource: 'sampled',
      reservedCores: 0,
    })
    clearMigrationDrain(db())
  })

  test('the first holding decision after a resample records the resampled source', async () => {
    repositoryRun()
    const runId = repositoryRun()
    let now = Date.parse('2026-01-01T00:02:00.000Z')
    let measurements = 0
    let sleeps = 0

    await waitForRunHostCapacity({
      database: db(),
      runId,
      env: {},
      platform: 'linux',
      now: () => now,
      measure: () => ({
        ...loaded(),
        cpuBusy: measurements++ === 0 ? null : 16,
      }),
      sleep: async (ms) => {
        now += ms
        sleeps += 1
        if (sleeps === 2) db().query("UPDATE run SET status='stopped' WHERE record_id=?").run(runId)
      },
    })

    const contention = db()
      .query<{ host_load: string }, [string]>(
        "SELECT host_load FROM contention WHERE run_record_id=? AND resource_key='host-capacity'",
      )
      .get(runId)!
    expect(JSON.parse(contention.host_load)).toMatchObject({
      cpuBusy: 16,
      cpuBusySource: 'resampled',
    })
  })

  test('a load-average wait records the fallback source and decision figures', async () => {
    repositoryRun()
    const runId = repositoryRun()
    let now = Date.parse('2026-01-01T00:02:00.000Z')
    let sleeps = 0

    await waitForRunHostCapacity({
      database: db(),
      runId,
      env: {},
      platform: 'linux',
      now: () => now,
      measure: () => ({ ...loaded(), cpuBusy: null }),
      sleep: async (ms) => {
        now += ms
        sleeps += 1
        if (sleeps === 2) db().query("UPDATE run SET status='stopped' WHERE record_id=?").run(runId)
      },
    })

    const contention = db()
      .query<{ host_load: string }, [string]>(
        "SELECT host_load FROM contention WHERE run_record_id=? AND resource_key='host-capacity'",
      )
      .get(runId)!
    expect(JSON.parse(contention.host_load)).toEqual({
      loadavg: 16,
      cpuBusy: null,
      ncpu: 8,
      recentAdmissions: 0,
      freeMem: 8 * 1024 * 1024 * 1024,
      pressure: 'unknown',
      swapGrowthBytesPerSec: null,
      cpuBusySource: 'loadavg',
      reservedCores: 0,
    })
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
        drainingFor: null,
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

  test('the queue summary includes a waiter whose tree is not built yet', () => {
    repositoryRun()
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: '/repo' })
    db()
      .query('UPDATE run SET host_wait_since=? WHERE record_id=?')
      .run('2026-01-01T00:00:00.000Z', runId)
    expect(
      runHostCapacityQueue(db(), Date.parse('2026-01-01T00:01:00.000Z'), {
        env: {},
        platform: 'linux',
        measure: loaded,
      }),
    ).toEqual({ waiting: 1, oldestWaitMs: 60_000, heldOn: ['load'] })
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
    const sleeps: number[] = []
    const result = await startRunAfterHostCapacity({
      wait: () =>
        waitForRunHostCapacity({
          database: db(),
          runId,
          env: {},
          platform: 'linux',
          measure: loaded,
          now: () => now,
          random: () => 0,
          sleep: async (ms) => {
            sleeps.push(ms)
            now += ms
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
    expect(sleeps.slice(0, 3)).toEqual([1_000, 1_600, 3_200])
    expect(now).toBe(RUN_HOST_WAIT_MAX_MS)
    expect(sleeps.at(-1)).toBeLessThan(12_000)
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
