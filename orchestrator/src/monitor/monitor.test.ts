import { describe, expect, spyOn, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { groupMonitorConditions, monitor, monitorHistory } from './monitor.ts'
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
  const root = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
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

describe('operational monitor conditions', () => {
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

  test('addresses stale and unscored runs to the session that owns their judgment', async () => {
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
})
