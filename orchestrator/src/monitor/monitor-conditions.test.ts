import { describe, expect, spyOn, test } from 'bun:test'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { liveMemberStall } from '../run/live-run-member.ts'
import {
  abandonedBootstrapConditions,
  askingRuns,
  deadRunningProcessConditions,
  idleRunCondition,
  orphanDockerNetworkConditions,
  orphanSandboxDirectoryConditions,
  pidBornAfterRun,
  reconcileHub,
  recordTunnelCondition,
  rulingConditions,
  staleTrustEntryConditions,
  stalledRunConditions,
  terminalProcessPgid,
  unsettledClaimConditions,
  workerGateToolingCondition,
} from './monitor-conditions.ts'
import { claimMonitorNotices } from './monitor-notices.ts'

describe('record tunnel monitor condition', () => {
  test('is absent when the tunnel is not configured', () => {
    expect(recordTunnelCondition({ app: '', port: 15432, reachable: false })).toBeNull()
  })

  test('names the endpoint and kickstart remedy when configured but unreachable', () => {
    expect(
      recordTunnelCondition({ app: 'record-app', port: 15432, reachable: false }),
    ).toMatchObject({
      kind: 'record-tunnel-down',
      subject: '127.0.0.1:15432',
      detail: expect.stringContaining('com.user.record-tunnel'),
      action: 'run launchctl kickstart -k gui/$(id -u)/com.user.record-tunnel',
    })
  })

  test('is absent when the configured endpoint is reachable', () => {
    expect(recordTunnelCondition({ app: 'record-app', port: 15432, reachable: true })).toBeNull()
  })
})

test('worker gate tooling changes produce a run condition with paths and command', () => {
  expect(
    workerGateToolingCondition({
      runId: 73,
      startedAt: '2026-09-25T12:00:00.000Z',
      ownerSession: 'session-73',
      executions: [{ paths: ['package.json', 'scripts/gate'], command: 'bun run check' }],
    }),
  ).toEqual({
    kind: 'worker-gate-tooling-change',
    subject: 'run:73',
    since: '2026-09-25T12:00:00.000Z',
    ageMs: null,
    detail:
      'worker gate executed with changed tooling: paths package.json, scripts/gate; command bun run check',
    action: 'review those tooling changes before landing',
    ownerSession: 'session-73',
  })
  expect(
    workerGateToolingCondition({
      runId: 73,
      startedAt: '2026-09-25T12:00:00.000Z',
      ownerSession: null,
      executions: [{ paths: [], command: 'bun run check' }],
    }),
  ).toBeNull()
})

describe('idle run classification', () => {
  const row = {
    id: 73,
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
      action: 'run orch stop 73',
    })
  })

  test('a quiet running row without a recorded pid retains idle behavior', () => {
    expect(idleRunCondition({ ...row, pidAlive: null }, clock, 5 * 60_000)).toMatchObject({
      kind: 'idle',
      subject: 'run:73',
      ageMs: 6 * 60_000,
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
      .query('UPDATE run SET agent_pid=?,agent_start_time=?,last_event_at=? WHERE id=?')
      .run(process.pid, 'recorded birth', '2026-09-17T12:01:00.000Z', turn)

    const clock = Date.parse('2026-09-17T12:30:00.000Z')
    const samples = [{ pid: process.pid, ppid: 1, pgid: process.pid, cpu: 0, state: 'S' }]
    const member = {
      id: turn,
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
function insertAnsweredQuestion(runId: number): void {
  db()
    .query(
      `INSERT INTO question (run_id,asked_at,question,why,answer,answered_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(runId, nowIso(), 'which way?', 'needed', 'go left', nowIso())
}

function persistAddressedCondition(
  kind: string,
  subject: string,
  ownerSession: string,
  since = nowIso(),
): number {
  const invocation = (
    db()
      .query(
        `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
     VALUES (?,?, 'backstop', 1, 0) RETURNING id`,
      )
      .get(since, since) as { id: number }
  ).id
  return (
    db()
      .query(
        `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action,owner_session_id)
     VALUES (?,?,?,?,0,'recorded condition','reported',?) RETURNING id`,
      )
      .get(invocation, kind, subject, since, ownerSession) as { id: number }
  ).id
}

describe('operational monitor conditions', () => {
  describe('finished-run pid identity', () => {
    const finishedAt = Date.parse('2026-09-17T08:00:00')

    test('catches removal of the after-finish reuse verdict', () => {
      expect(pidBornAfterRun('Wed Sep 17 08:00:03 2026', finishedAt)).toBe(true)
    })

    test('catches reversal of the birth and finish comparison', () => {
      expect(pidBornAfterRun('Wed Sep 17 07:59:59 2026', finishedAt)).toBe(false)
    })

    test('catches removal of the pid birth tolerance', () => {
      expect(pidBornAfterRun('Wed Sep 17 08:00:02 2026', finishedAt)).toBe(false)
    })

    test('catches treating an unknown birth as reused', () => {
      expect(pidBornAfterRun(null, finishedAt)).toBe(false)
    })

    test('catches treating an unknown finish as reused', () => {
      expect(pidBornAfterRun('Wed Sep 17 08:00:03 2026', null)).toBe(false)
    })

    test('catches treating a malformed lstart as reused', () => {
      expect(pidBornAfterRun('not a process start time', finishedAt)).toBe(false)
    })

    test('catches passing a reused vendor pgid as descendant evidence', () => {
      expect(terminalProcessPgid('reused', 66547)).toBe(null)
    })
  })

  test('reports claimed allocations only after a conversation has been terminal over one hour', () => {
    const clock = Date.parse('2026-09-15T12:00:00Z')
    const claim = {
      kind: 'sandbox_dir' as const,
      rootId: 52,
      allocationKeys: ['/runs/sandbox-52'],
      terminal: true,
      terminalAt: '2026-09-15T10:59:59Z',
    }
    expect(unsettledClaimConditions({ ascertainable: true, claims: [claim] }, clock)).toEqual({
      conditions: [
        {
          kind: 'unsettled-claim',
          subject: 'sandbox_dir:52',
          since: '2026-09-15T10:59:59Z',
          ageMs: 3_601_000,
          detail:
            'sandbox_dir claim for terminal conversation 52 remains claimed; allocation key /runs/sandbox-52',
          action: 'run orch sweep',
        },
      ],
      errors: [],
    })
    expect(
      unsettledClaimConditions(
        {
          ascertainable: true,
          claims: [
            { ...claim, terminalAt: '2026-09-15T11:00:01Z' },
            { ...claim, rootId: 53, terminal: false },
          ],
        },
        clock,
      ),
    ).toEqual({ conditions: [], errors: [] })
    expect(
      unsettledClaimConditions(
        { ascertainable: false, reason: 'unsettled claim inventory unavailable: denied' },
        clock,
      ),
    ).toEqual({
      conditions: [],
      errors: ['unsettled claim inventory unavailable: denied'],
    })
  })

  test('reports only orphan Docker networks and preserves an unavailable detector', () => {
    const clock = Date.parse('2026-09-15T12:00:00Z')
    const orphan = {
      name: 'app-orch-41-default',
      createdAt: '2026-09-15T11:00:00Z',
      workingDir: '/trees/orch-41',
      workingDirExists: false,
      runId: 41,
    }
    const terminalOwner = {
      name: 'app-orch-42-default',
      createdAt: null,
      workingDir: null,
      workingDirExists: false,
      runId: 42,
    }
    expect(
      orphanDockerNetworkConditions(
        {
          ascertainable: true,
          networks: [orphan, terminalOwner],
          owners: [
            { rootId: 41, terminal: true, hasWorktree: false },
            { rootId: 42, terminal: true, hasWorktree: false },
          ],
        },
        clock,
      ),
    ).toEqual({
      conditions: [
        {
          kind: 'orphan-docker-network',
          subject: 'app-orch-41-default',
          since: '2026-09-15T11:00:00.000Z',
          ageMs: 3_600_000,
          detail:
            'Docker network app-orch-41-default; compose working directory is gone: /trees/orch-41',
          action: 'reported; no established removal verb',
        },
        {
          kind: 'orphan-docker-network',
          subject: 'app-orch-42-default',
          since: null,
          ageMs: null,
          detail: 'Docker network app-orch-42-default; terminal conversation 42 has no worktree',
          action: 'reported; no established removal verb',
        },
      ],
      errors: [],
    })
    expect(
      orphanDockerNetworkConditions(
        {
          ascertainable: true,
          networks: [{ ...orphan, workingDirExists: true }],
          owners: [{ rootId: 41, terminal: false, hasWorktree: true }],
        },
        clock,
      ),
    ).toEqual({ conditions: [], errors: [] })
    expect(
      orphanDockerNetworkConditions(
        { ascertainable: false, reason: 'docker network inventory unavailable: denied' },
        clock,
      ),
    ).toEqual({
      conditions: [],
      errors: ['docker network inventory unavailable: denied'],
    })
  })

  test('reports sandbox directories only after every conversation turn is terminal', () => {
    expect(
      orphanSandboxDirectoryConditions({
        ascertainable: true,
        directories: [{ rootId: 52, path: '/runs/sandbox-52', sizeBytes: 8192 }],
        conversations: [{ rootId: 52, terminal: true }],
      }),
    ).toEqual({
      conditions: [
        {
          kind: 'orphan-sandbox-dir',
          subject: '/runs/sandbox-52',
          since: null,
          ageMs: null,
          detail: 'sandbox directory for terminal conversation 52 uses 8192 bytes',
          action: 'run orch reclaim sandbox 52 --dry-run, then orch reclaim sandbox 52',
        },
      ],
      errors: [],
    })
    expect(
      orphanSandboxDirectoryConditions({
        ascertainable: true,
        directories: [{ rootId: 52, path: '/runs/sandbox-52', sizeBytes: 8192 }],
        conversations: [{ rootId: 52, terminal: false }],
      }),
    ).toEqual({ conditions: [], errors: [] })
    expect(
      orphanSandboxDirectoryConditions({
        ascertainable: false,
        reason: 'sandbox directory inventory unavailable: denied',
      }),
    ).toEqual({
      conditions: [],
      errors: ['sandbox directory inventory unavailable: denied'],
    })
  })

  test('reports an absent unregistered trust heading after its recorded worktree disappears', () => {
    expect(
      staleTrustEntryConditions({
        ascertainable: true,
        entries: [
          {
            runId: 63,
            heading: '[folders."/trees/63"]',
            path: '/trees/63',
            pathExists: false,
            registeredProjectPath: false,
            worktreeExists: false,
          },
        ],
      }),
    ).toEqual({
      conditions: [
        {
          kind: 'stale-trust-entry',
          subject: 'run:63:[folders."/trees/63"]',
          since: null,
          ageMs: null,
          detail:
            'run 63 recorded Grok trust heading [folders."/trees/63"] after its worktree disappeared',
          action: 'run orch reclaim trust 63 --dry-run, then orch reclaim trust 63',
        },
      ],
      errors: [],
    })
  })

  test('does not report a registered project trust heading when the run worktree is gone', () => {
    expect(
      staleTrustEntryConditions({
        ascertainable: true,
        entries: [
          {
            runId: 63,
            heading: '[folders."/projects/main-checkout"]',
            path: '/projects/main-checkout',
            pathExists: false,
            registeredProjectPath: true,
            worktreeExists: false,
          },
        ],
      }),
    ).toEqual({ conditions: [], errors: [] })
  })

  test('does not report an existing unregistered trust heading', () => {
    expect(
      staleTrustEntryConditions({
        ascertainable: true,
        entries: [
          {
            runId: 63,
            heading: '[folders."/other/checkout"]',
            path: '/other/checkout',
            pathExists: true,
            registeredProjectPath: false,
            worktreeExists: false,
          },
        ],
      }),
    ).toEqual({ conditions: [], errors: [] })
  })

  test('does not report a trust heading while its recorded worktree exists', () => {
    expect(
      staleTrustEntryConditions({
        ascertainable: true,
        entries: [
          {
            runId: 63,
            heading: '[folders."/trees/63"]',
            path: '/trees/63',
            pathExists: false,
            registeredProjectPath: false,
            worktreeExists: true,
          },
        ],
      }),
    ).toEqual({ conditions: [], errors: [] })
  })

  test('does not report a trust heading without a quoted path and records an error', () => {
    expect(
      staleTrustEntryConditions({
        ascertainable: true,
        entries: [
          {
            runId: 63,
            heading: '[folders.invalid]',
            path: null,
            pathExists: false,
            registeredProjectPath: false,
            worktreeExists: false,
          },
        ],
      }),
    ).toEqual({
      conditions: [],
      errors: ['run 63 recorded Grok trust heading without a quoted path: [folders.invalid]'],
    })
  })

  test('reports an unavailable trust inventory as an error', () => {
    expect(
      staleTrustEntryConditions({
        ascertainable: false,
        reason: 'Grok trust inventory unavailable: unreadable row',
      }),
    ).toEqual({
      conditions: [],
      errors: ['Grok trust inventory unavailable: unreadable row'],
    })
  })

  test('reports a pending row whose launch handoff was abandoned', () => {
    const clock = Date.parse('2026-09-04T20:02:00Z')
    const id = addRun({
      agent: '(pending)',
      job: 'implement',
      status: 'running',
      startedAt: '2026-09-04T20:00:00Z',
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(4_194_304, id)

    expect(abandonedBootstrapConditions(clock)).toEqual([
      expect.objectContaining({
        kind: 'abandoned-bootstrap',
        subject: `run:${id}`,
        since: '2026-09-04T20:00:00Z',
        ageMs: 120_000,
        detail: expect.stringContaining('dead coordinator pid 4194304'),
        action: 'run orch sweep to terminalize the abandoned bootstrap',
      }),
    ])
  })

  test('reports a running row whose agent process is gone with elapsed time and output size', () => {
    const clock = Date.parse('2026-09-04T20:00:10Z')
    const id = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'running',
      startedAt: '2026-09-04T20:00:00Z',
    })
    // The live worker makes this a fixture the old worker-pid detector missed.
    db()
      .query('UPDATE run SET pid=?, agent_pid=?, output_bytes=? WHERE id=?')
      .run(process.pid, 4_194_304, 53, id)

    expect(deadRunningProcessConditions(clock)).toEqual([
      expect.objectContaining({
        kind: 'dead-running-process',
        subject: `run:${id}`,
        since: '2026-09-04T20:00:00Z',
        ageMs: 10_000,
        detail: expect.stringContaining('worker pid'),
        action: 'reported; disposition and status repair require intent',
      }),
    ])
    const [condition] = deadRunningProcessConditions(clock)
    expect(condition!.detail).toContain('elapsed 10s')
    expect(condition!.detail).toContain('output 53 bytes')
    expect(db().query('SELECT status FROM run WHERE id=?').get(id)).toEqual({ status: 'running' })
  })

  test('derives ghost interval ages from the audited hub reconcile command', () => {
    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from(
        'closed:\n  interval 747618  orch:1205  starship/STAR-1  agent codex  run 1205 is terminal (ok); removes 19h engaged time\nleft open:\n  none\n',
      ),
      stderr: Buffer.from(''),
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>)
    try {
      const clock = Date.parse('2026-09-04T20:00:00Z')
      expect(reconcileHub(clock).conditions).toEqual([
        expect.objectContaining({
          kind: 'ghost-open-interval',
          subject: 'interval:747618',
          ageMs: 68_400_000,
          action: 'reconciled through hub reconcile',
        }),
      ])
    } finally {
      spawn.mockRestore()
    }
  })

  test('reports a task waiting past the rulings threshold and names the session', () => {
    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from(
        JSON.stringify({
          stale_after: '1h',
          questions: [
            {
              question_id: 11,
              task_key: 'DEV-215',
              session_id: 'sess-1',
              asked_at: '2026-09-04T18:00:00.000Z',
              age: 7_200_000,
            },
            {
              question_id: 12,
              task_key: 'DEV-1',
              session_id: 'sess-2',
              asked_at: '2026-09-04T19:30:00.000Z',
              age: 1_800_000,
            },
          ],
        }),
      ),
      stderr: Buffer.from(''),
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>)
    try {
      const clock = Date.parse('2026-09-04T20:00:00.000Z')
      expect(rulingConditions(clock)).toEqual({
        conditions: [
          expect.objectContaining({
            kind: 'task-waiting-on-ruling',
            subject: 'question:12',
            severity: 'informational',
            since: '2026-09-04T19:30:00.000Z',
            ageMs: 1_800_000,
            detail: 'task DEV-1 waiting on a ruling; session sess-2; elapsed 30m',
            action: 'reported; it does not answer',
          }),
          expect.objectContaining({
            kind: 'task-waiting-on-ruling',
            subject: 'question:11',
            severity: 'attention',
            since: '2026-09-04T18:00:00.000Z',
            ageMs: 7_200_000,
            detail: 'task DEV-215 waiting on a ruling; session sess-1; elapsed 2.0h',
            action: 'reported; it does not answer',
          }),
        ],
        errors: [],
      })
    } finally {
      spawn.mockRestore()
    }
  })

  test('answered asking root with a running later turn is not reported', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    insertAnsweredQuestion(root)
    addRun({ agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2 })
    expect(askingRuns().map((run) => run.id)).toEqual([])
  })

  test('answered asking root whose latest turn is also asking with no open question is reported once under the root id', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    insertAnsweredQuestion(root)
    addRun({ agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 2 })
    expect(askingRuns().map((run) => run.id)).toEqual([root])
  })

  test('an open question on a later turn suppresses the report', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    insertAnsweredQuestion(root)
    const child = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      parent: root,
      turn: 2,
    })
    db()
      .query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, nowIso(), 'and now what?')
    expect(askingRuns().map((run) => run.id)).toEqual([])
  })

  test('does not deliver an asking-run condition after the run resumes', () => {
    const owner = 'resolved-asking-owner'
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: owner })
    persistAddressedCondition('asking-run', `run:${runId}`, owner)

    db().query("UPDATE run SET status='ok' WHERE id=?").run(runId)

    expect(claimMonitorNotices(owner)).toEqual([])
  })

  test('does not deliver an unscored-run condition after the run is scored', () => {
    const owner = 'resolved-unscored-owner'
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: owner })
    persistAddressedCondition('unscored-run', `run:${runId}`, owner)

    score(runId, 'full', 'right', 'faithful')

    expect(claimMonitorNotices(owner)).toEqual([])
  })

  // Residual, untested here: claimMonitorNotices re-validates and returns synchronously,
  // so a condition that resolves AFTER the claim and BEFORE the heartbeat emits it is
  // still delivered. That window lives at the heartbeat emission boundary, not inside
  // the claim, and no assertion on the claim's returned array can observe it.

  test('append-only event and terminal-fact notices still deliver after current state moves on', () => {
    const owner = 'append-only-owner'
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'stale', session: owner })
    persistAddressedCondition('ghost-open-interval', 'interval:already-closed', owner)
    persistAddressedCondition('observation-error', 'invocation:recovered-observer', owner)
    persistAddressedCondition('stale-run', `run:${runId}`, owner)

    db().query("UPDATE run SET status='ok' WHERE id=?").run(runId)

    expect(
      claimMonitorNotices(owner)
        .map((notice) => notice.kind)
        .sort(),
    ).toEqual(['ghost-open-interval', 'observation-error', 'stale-run'])
  })

  test('a missing hub rulings document is an observation error, not emptiness', () => {
    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({
      exitCode: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('hub database is absent at /tmp/none'),
      success: false,
    } as unknown as ReturnType<typeof Bun.spawnSync>)
    try {
      expect(rulingConditions()).toEqual({
        conditions: [],
        errors: ['hub database is absent at /tmp/none'],
      })
    } finally {
      spawn.mockRestore()
    }
  })
})
