import { describe, expect, spyOn, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { groupMonitorConditions, monitor, monitorHistory } from './monitor.ts'
import {
  deadRunningProcessConditions,
  orphanDockerNetworkConditions,
  orphanSandboxDirectoryConditions,
  pidBornAfterRun,
  reconcileHub,
  rulingConditions,
  staleTrustEntryConditions,
  terminalProcessPgid,
  unsettledClaimConditions,
} from './monitor-conditions.ts'
import { claimMonitorNotices, markMonitorNoticesDelivered } from './monitor-notices.ts'

const condition = (overrides: Partial<import('./monitor-types.ts').MonitorCondition> = {}) => ({
  kind: 'sample',
  subject: 'subject',
  since: '2026-09-16T00:00:00.000Z',
  ageMs: 1,
  detail: 'detail',
  action: 'reported',
  ...overrides,
})

function insertRun4177PackRows(): void {
  const root = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
  upsertProject({ name: PLATFORM_SLUG, path: root, settings: { trunk: 'main' } })
  const projectId = (
    db().query('SELECT id FROM project WHERE name=?').get(PLATFORM_SLUG) as { id: number }
  ).id
  const docs = JSON.stringify([
    {
      revisionId: 4177,
      scope: 'global',
      subject: null,
      slug: 'removed-run-4177-doc',
      title: 'Removed',
      bytes: 1,
    },
  ])
  const insert = db().query(
    `INSERT INTO canon_pack
     (job,project,project_id,sha256,bytes,doc_count,doc_revisions,compiled_at,findings)
     VALUES (?,?,?,?,?,?,?,?,0)`,
  )
  insert.run('review-lens', null, null, 'global', 1, 1, docs, '2026-09-16T00:00:00.000Z')
  insert.run(
    'review-lens',
    PLATFORM_SLUG,
    projectId,
    'project',
    1,
    1,
    docs,
    '2026-09-16T00:00:00.000Z',
  )
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

  test('identical conditions collapse without an anomaly', () => {
    const duplicate = condition()
    expect(groupMonitorConditions([duplicate, { ...duplicate }])).toEqual({
      conditions: [duplicate],
      anomalies: [],
    })
  })

  test('conflicting conditions keep the first and report the dropped duplicate', () => {
    const first = condition()
    const grouped = groupMonitorConditions([first, condition({ detail: 'different detail' })])
    expect(grouped.conditions).toEqual([first])
    expect(grouped.anomalies).toEqual([
      expect.objectContaining({
        kind: 'observation-error',
        subject: expect.stringContaining('sample'),
        detail: expect.stringMatching(/sample.*subject.*dropped 1/),
      }),
    ])
  })

  test('unrelated conditions preserve their order', () => {
    const first = condition({ kind: 'first', subject: 'one' })
    const second = condition({ kind: 'second', subject: 'two' })
    expect(groupMonitorConditions([first, second])).toEqual({
      conditions: [first, second],
      anomalies: [],
    })
  })

  test('the persistence path inserts the run 4177 de-duplicated condition set', async () => {
    insertRun4177PackRows()
    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>)
    try {
      const result = await monitor('invoked')
      const subject = `review-lens/${PLATFORM_SLUG}`
      const drift = result.conditions.filter(
        (condition) => condition.kind === 'canon-pack-drift' && condition.subject === subject,
      )
      expect(drift).toHaveLength(1)
      expect(
        db()
          .query(
            `SELECT kind, subject FROM monitor_condition
           WHERE invocation_id=? AND kind='canon-pack-drift' AND subject=?`,
          )
          .all(result.id, subject),
      ).toEqual([{ kind: 'canon-pack-drift', subject }])
    } finally {
      spawn.mockRestore()
    }
  })

  test('a persistence failure completes the invocation with an error before rethrowing', async () => {
    addRun({ agent: 'codex', job: 'implement', status: 'stale' })
    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>)
    db().exec(
      `CREATE TRIGGER fail_monitor_condition
       BEFORE INSERT ON monitor_condition BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END`,
    )
    try {
      await expect(monitor('invoked')).rejects.toThrow('fixture persistence failure')
      const invocation = db()
        .query(
          `SELECT finished_at IS NOT NULL finished, findings, errors
           FROM monitor_invocation ORDER BY id DESC LIMIT 1`,
        )
        .get() as { finished: number; findings: number; errors: number }
      expect(invocation.finished).toBe(1)
      expect(invocation.findings).toBe(0)
      expect(invocation.errors).toBeGreaterThan(0)
    } finally {
      spawn.mockRestore()
    }
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

  test('reports trust headings only after their recorded worktree disappears', () => {
    expect(
      staleTrustEntryConditions({
        ascertainable: true,
        entries: [{ runId: 63, heading: '[folders."/trees/63"]', worktreeExists: false }],
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
    expect(
      staleTrustEntryConditions({
        ascertainable: true,
        entries: [{ runId: 63, heading: '[folders."/trees/63"]', worktreeExists: true }],
      }),
    ).toEqual({ conditions: [], errors: [] })
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

  test('records condition ages and reads them back by invocation', () => {
    const invocation = (
      db()
        .query(
          `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
       VALUES ('2026-09-04T00:00:00Z','2026-09-04T00:00:01Z','backstop',1,0) RETURNING id`,
        )
        .get() as { id: number }
    ).id
    db()
      .query(
        `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action)
       VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        invocation,
        'stale-run',
        'run:7',
        '2026-09-03T08:00:00Z',
        57_600_000,
        'process is gone',
        'reported',
      )
    expect(monitorHistory(1)).toEqual([
      expect.objectContaining({
        id: invocation,
        trigger: 'backstop',
        findings: 1,
        conditions: [
          expect.objectContaining({ kind: 'stale-run', subject: 'run:7', age_ms: 57_600_000 }),
        ],
      }),
    ])
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

  test('two sessions stale on one task are two conditions and do not collide', async () => {
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
      const argv = cmd.map(String)
      if (argv.includes('rulings')) {
        return {
          exitCode: 0,
          stdout: Buffer.from(
            JSON.stringify({
              stale_after: '1h',
              questions: [
                {
                  question_id: 101,
                  task_key: 'DEV-1896',
                  session_id: 'sess-D',
                  asked_at: '2026-09-04T18:00:00.000Z',
                  age: 7_200_000,
                },
                {
                  question_id: 102,
                  task_key: 'DEV-1896',
                  session_id: 'sess-E',
                  asked_at: '2026-09-04T18:10:00.000Z',
                  age: 6_600_000,
                },
              ],
            }),
          ),
          stderr: Buffer.from(''),
          success: true,
        }
      }
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), success: true }
    }) as unknown as typeof Bun.spawnSync)
    try {
      const clock = Date.parse('2026-09-04T20:00:00.000Z')
      const result = await monitor('invoked', clock)
      expect(result.conditions.filter((c) => c.kind === 'task-waiting-on-ruling')).toEqual([
        expect.objectContaining({
          subject: 'question:101',
          detail: expect.stringContaining('session sess-D'),
        }),
        expect.objectContaining({
          subject: 'question:102',
          detail: expect.stringContaining('session sess-E'),
        }),
      ])
      expect(
        result.conditions.filter((c) => c.kind === 'task-waiting-on-ruling').map((c) => c.detail),
      ).toEqual([
        expect.stringContaining('task DEV-1896'),
        expect.stringContaining('task DEV-1896'),
      ])
    } finally {
      spawn.mockRestore()
    }
  })

  test('two untracked questions from one session are two conditions', async () => {
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
      const argv = cmd.map(String)
      if (argv.includes('rulings')) {
        return {
          exitCode: 0,
          stdout: Buffer.from(
            JSON.stringify({
              stale_after: '1h',
              questions: [
                {
                  question_id: 201,
                  task_key: null,
                  session_id: 'sess-U',
                  asked_at: '2026-09-04T18:00:00.000Z',
                  age: 7_200_000,
                },
                {
                  question_id: 202,
                  task_key: null,
                  session_id: 'sess-U',
                  asked_at: '2026-09-04T18:05:00.000Z',
                  age: 6_900_000,
                },
              ],
            }),
          ),
          stderr: Buffer.from(''),
          success: true,
        }
      }
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), success: true }
    }) as unknown as typeof Bun.spawnSync)
    try {
      const result = await monitor('invoked', Date.parse('2026-09-04T20:00:00.000Z'))
      expect(
        result.conditions
          .filter((c) => c.kind === 'task-waiting-on-ruling')
          .map((c) => c.subject)
          .sort(),
      ).toEqual(['question:201', 'question:202'])
    } finally {
      spawn.mockRestore()
    }
  })

  test('an open question is not also misclassified as a stranded asking run', async () => {
    const runId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      session: 'sess-1',
      startedAt: '2026-09-04T19:30:00.000Z',
    })
    db()
      .query('INSERT INTO question (id, run_id, asked_at, question) VALUES (?,?,?,?)')
      .run(2000, runId, '2026-09-04T19:30:00.000Z', 'which way?')
    const clock = Date.parse('2026-09-04T20:00:00.000Z')
    const payload = (staleAfter: string) =>
      JSON.stringify({
        stale_after: staleAfter,
        questions: [
          {
            question_id: 2000,
            task_key: 'DEV-215',
            session_id: 'sess-1',
            asked_at: '2026-09-04T19:30:00.000Z',
            age: 1_800_000,
          },
        ],
      })
    const spawnFor = (staleAfter: string) =>
      spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
        const argv = cmd.map(String)
        if (argv.includes('rulings')) {
          return {
            exitCode: 0,
            stdout: Buffer.from(payload(staleAfter)),
            stderr: Buffer.from(''),
            success: true,
          }
        }
        return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), success: true }
      }) as unknown as typeof Bun.spawnSync)
    const related = (result: { conditions: { kind: string; subject: string }[] }) =>
      result.conditions.filter(
        (c) =>
          c.kind === 'task-waiting-on-ruling' ||
          c.kind === 'unanswered-question' ||
          c.kind === 'asking-run' ||
          c.subject === 'question:2000' ||
          c.subject === `run:${runId}`,
      )

    const young = spawnFor('1h')
    try {
      const result = await monitor('invoked', clock)
      expect(related(result)).toEqual([
        expect.objectContaining({
          kind: 'task-waiting-on-ruling',
          subject: 'question:2000',
          severity: 'informational',
          ageMs: 1_800_000,
          ownerSession: 'sess-1',
          detail: 'task DEV-215 waiting on a ruling; session sess-1; elapsed 30m',
          action: 'reported; it does not answer',
        }),
      ])
      const notices = claimMonitorNotices('sess-1')
      expect(notices).toEqual([
        expect.objectContaining({
          kind: 'task-waiting-on-ruling',
          subject: 'question:2000',
          ownerSession: 'sess-1',
        }),
      ])
      expect(claimMonitorNotices('sess-1')).toEqual(notices)
      markMonitorNoticesDelivered(
        'sess-1',
        notices.map((notice) => notice.noticeId),
        '2026-09-04T20:01:00.000Z',
      )
      expect(claimMonitorNotices('sess-1')).toEqual([])
    } finally {
      young.mockRestore()
    }

    const late = spawnFor('10m')
    try {
      const result = await monitor('invoked', clock)
      expect(related(result)).toEqual([
        expect.objectContaining({
          kind: 'task-waiting-on-ruling',
          subject: 'question:2000',
          severity: 'attention',
          ageMs: 1_800_000,
          ownerSession: 'sess-1',
          detail: 'task DEV-215 waiting on a ruling; session sess-1; elapsed 30m',
          action: 'reported; it does not answer',
        }),
      ])
      expect(claimMonitorNotices('sess-1')).toEqual([])
    } finally {
      late.mockRestore()
    }
  })

  test('answered questions leave an asking run visibly stranded', async () => {
    const id = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      session: 'sess-recover',
    })
    db()
      .query(
        `INSERT INTO question (run_id,asked_at,question,why,answer,answered_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(id, nowIso(), 'fixture question', 'catches stale asking status', 'answered', nowIso())
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
      const argv = cmd.map(String)
      if (argv.includes('rulings')) {
        return {
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify({ stale_after: '1h', questions: [] })),
          stderr: Buffer.from(''),
          success: true,
        }
      }
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), success: true }
    }) as unknown as typeof Bun.spawnSync)
    try {
      const result = await monitor('invoked')
      expect(result.conditions.filter((c) => c.kind === 'asking-run')).toEqual([
        expect.objectContaining({
          subject: `run:${id}`,
          ownerSession: 'sess-recover',
          detail: `run ${id} is marked asking but has no unanswered question (stranded)`,
          action: `run orch abandon ${id} to close it, or orch continue ${id} to resume it; an intent decision`,
        }),
      ])
      expect(result.conditions.some((c) => c.kind === 'task-waiting-on-ruling')).toBe(false)
      expect(result.conditions.some((c) => c.kind === 'unanswered-question')).toBe(false)
    } finally {
      spawn.mockRestore()
    }
  })

  test('addresses stale and unscored runs to the session that owns their judgement', async () => {
    const stale = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'stale',
      session: 'run-reader',
    })
    const unscored = addRun({ agent: 'grok', job: 'fix', status: 'ok', session: 'run-reader' })
    const unowned = addRun({ agent: 'agy', job: 'craft', status: 'stale', session: null })
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
      if (cmd.map(String).includes('rulings')) {
        return {
          exitCode: 0,
          stdout: Buffer.from('{"stale_after":"1h","questions":[]}'),
          stderr: Buffer.from(''),
          success: true,
        }
      }
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), success: true }
    }) as unknown as typeof Bun.spawnSync)
    try {
      const result = await monitor('backstop')
      expect(result.conditions).toContainEqual(
        expect.objectContaining({
          kind: 'stale-run',
          subject: `run:${stale}`,
          ownerSession: 'run-reader',
        }),
      )
      expect(result.conditions).toContainEqual(
        expect.objectContaining({
          kind: 'unscored-run',
          subject: `run:${unscored}`,
          ownerSession: 'run-reader',
        }),
      )
      expect(result.conditions).toContainEqual(
        expect.objectContaining({
          kind: 'stale-run',
          subject: `run:${unowned}`,
          ownerSession: null,
        }),
      )
      expect(
        claimMonitorNotices('run-reader')
          .map((condition) => condition.subject)
          .sort(),
      ).toEqual([`run:${stale}`, `run:${unscored}`].sort())
      expect(claimMonitorNotices('somebody-else')).toEqual([])
    } finally {
      spawn.mockRestore()
    }
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
