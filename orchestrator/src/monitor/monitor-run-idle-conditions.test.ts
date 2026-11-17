import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { liveMemberStall } from '../run/live-run-member.ts'
import {
  DETACHED_AGENT_CAPACITY_WAIT_MAX_MS,
  RUN_HOST_WAIT_MAX_MS,
  RUN_HOST_WAIT_POLL_MS,
} from '../run/run-liveness-policy.ts'
import {
  idleRunCondition,
  idleRunConditions,
  stalledRunConditions,
} from './monitor-run-idle-conditions.ts'

describe('idle run classification', () => {
  const row = {
    record_id: '73',
    started_at: '2026-09-17T12:00:00.000Z',
    last_event_at: '2026-09-17T12:01:00.000Z',
    agent: 'codex',
    job: 'implement',
    session_id: 'session-73',
  }
  const clock = Date.parse('2026-09-17T12:07:00.000Z')

  test('a live quiet running row is idle', () => {
    expect(idleRunCondition({ ...row, pidAlive: true }, clock, 5 * 60_000)).toMatchObject({
      kind: 'idle',
      subject: 'run:73',
      ageMs: 6 * 60_000,
    })
  })

  test('a running row whose recorded pid is dead is stale, not idle', () => {
    expect(idleRunCondition({ ...row, pidAlive: false }, clock, 5 * 60_000)).toMatchObject({
      kind: 'stale-run',
      subject: 'run:73',
      action: `run ${PLATFORM_SLUG} run stop 73`,
    })
  })

  test('a quiet running row without a recorded pid retains idle behavior', () => {
    expect(idleRunCondition({ ...row, pidAlive: null }, clock, 5 * 60_000)).toMatchObject({
      kind: 'idle',
      subject: 'run:73',
      ageMs: 6 * 60_000,
    })
  })

  test('a fresh host wait is not reported', () => {
    expect(
      idleRunCondition(
        {
          ...row,
          pidAlive: null,
          host_wait_since: new Date(clock - 1_000).toISOString(),
        },
        clock,
        5 * 60_000,
      ),
    ).toBeNull()
  })

  test('the reproduced open agent capacity wait is not reported idle', () => {
    const capacityWaitSince = '2026-09-17T15:26:00.000Z'
    const observedAt = Date.parse('2026-09-17T15:35:00.000Z')
    expect(
      idleRunCondition(
        {
          ...row,
          started_at: capacityWaitSince,
          last_event_at: capacityWaitSince,
          pidAlive: null,
          capacity_wait_since: capacityWaitSince,
        },
        observedAt,
        5 * 60_000,
      ),
    ).toBeNull()
  })

  test('a live coordinator does not make an unlaunched capacity wait idle', () => {
    const capacityWaitSince = '2026-09-17T15:26:00.000Z'
    const observedAt = Date.parse('2026-09-17T15:35:00.000Z')
    expect(
      idleRunCondition(
        {
          ...row,
          started_at: capacityWaitSince,
          last_event_at: capacityWaitSince,
          pid: 4242,
          pidAlive: true,
          agent_pid: null,
          capacity_wait_since: capacityWaitSince,
        },
        observedAt,
        5 * 60_000,
      ),
    ).toBeNull()
  })

  test('an expired or closed agent capacity wait retains idle behavior', () => {
    const observedAt = Date.parse('2026-09-17T16:26:00.001Z')
    const capacityWaitSince = new Date(
      observedAt - DETACHED_AGENT_CAPACITY_WAIT_MAX_MS - 1,
    ).toISOString()
    const facts = {
      ...row,
      started_at: capacityWaitSince,
      last_event_at: capacityWaitSince,
      pidAlive: null,
    }
    expect(
      idleRunCondition(
        { ...facts, capacity_wait_since: capacityWaitSince },
        observedAt,
        5 * 60_000,
      ),
    ).toMatchObject({ kind: 'idle' })
  })

  test('a dead pid with an open agent wait is stale-run', () => {
    expect(
      idleRunCondition(
        {
          ...row,
          pidAlive: false,
          pid: 42,
          capacity_wait_since: new Date(clock - 1_000).toISOString(),
        },
        clock,
      ),
    ).toMatchObject({ kind: 'stale-run' })
  })

  test('the detector reads an open agent wait before reporting an idle row', () => {
    const waitSince = '2026-09-17T15:26:00.000Z'
    const runId = addRun({
      agent: '(pending)',
      job: 'implement',
      status: 'running',
      startedAt: waitSince,
    })
    db().query('UPDATE run SET last_event_at=? WHERE record_id=?').run(waitSince, runId)
    appendRunEvent(runId, { ts: waitSince, type: 'capacity_wait', waiting: true })

    expect(idleRunConditions(Date.parse('2026-09-17T15:35:00.000Z'))).not.toContainEqual(
      expect.objectContaining({ subject: `run:${runId}` }),
    )
  })

  test('an over-bound host wait is stuck-host-wait', () => {
    const since = new Date(clock - RUN_HOST_WAIT_MAX_MS - RUN_HOST_WAIT_POLL_MS - 1).toISOString()
    expect(
      idleRunCondition(
        { ...row, pidAlive: null, pid: null, host_wait_since: since },
        clock,
        5 * 60_000,
      ),
    ).toMatchObject({
      kind: 'stuck-host-wait',
      subject: 'run:73',
      since,
      ageMs: RUN_HOST_WAIT_MAX_MS + RUN_HOST_WAIT_POLL_MS + 1,
      detail: expect.stringContaining('coordinator pid none'),
      action: expect.stringContaining('run stop 73 if it is dead'),
    })
  })
})

describe('stalled run monitor condition', () => {
  test('wraps the running turn stall observation in the monitor envelope', () => {
    const root = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      session: 'session-chain',
    })
    const turn = addRun({
      agent: 'grok',
      job: 'review-lens',
      status: 'running',
      parent: root,
      turn: 2,
      startedAt: '2026-09-17T12:00:00.000Z',
    })
    db()
      .query('UPDATE run SET agent_pid=?,agent_start_time=?,last_event_at=? WHERE record_id=?')
      .run(process.pid, 'recorded birth', '2026-09-17T12:01:00.000Z', turn)

    const clock = Date.parse('2026-09-17T12:30:00.000Z')
    const samples = [{ pid: process.pid, ppid: 1, pgid: process.pid, cpu: 0, state: 'S' }]
    const member = {
      record_id: turn,
      number: 2,
      started_at: '2026-09-17T12:00:00.000Z',
      last_event_at: '2026-09-17T12:01:00.000Z',
      agent: 'grok',
      job: 'review-lens',
      session_id: 'session-chain',
      agent_pid: process.pid,
      agent_start_time: 'recorded birth',
    }
    const observed = liveMemberStall(member, samples, clock, 25 * 60_000, () => 'recorded birth')

    expect(
      stalledRunConditions(clock, {
        samples,
        observedStartTime: () => 'recorded birth',
      }),
    ).toEqual([
      expect.objectContaining({
        subject: `run:${turn}`,
        ownerSession: 'session-chain',
        ageMs: observed.idleMs,
        detail: observed.detail,
      }),
    ])
  })
})
