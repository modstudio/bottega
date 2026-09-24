import { describe, expect, test } from 'bun:test'
import { runJson } from '../../test/fixtures/replies.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { runDetail } from '../state/serve.ts'
import { runListingCommand } from './run-listing.ts'

function command(args: Record<string, string[] | boolean> = {}) {
  const lines: string[] = []
  const values = (name: string) => (Array.isArray(args[name]) ? (args[name] as string[]) : [])
  const flag = (name: string) => values(name)[0]
  return runListingCommand(
    { jsonV1: false },
    {
      has: (name) => args[name] === true || values(name).length > 0,
      flag,
      values,
    },
    {
      log: (...parts) => lines.push(parts.join(' ')),
      dur: (ms) => String(ms ?? 0),
      chainIsStranded: (root) =>
        Boolean(
          db()
            .query(
              `SELECT 1 FROM question q JOIN run r ON r.id=q.run_id
       WHERE (r.id=? OR r.parent_run_id=?) AND q.delivery_pending_at IS NOT NULL`,
            )
            .get(root, root),
        ),
      strandedRecovery: (root) => `orch retry ${root} --agent`,
      thinOutputWarning: () => null,
    },
  ).then(() => lines)
}

function insert(status: string, job = 'implement') {
  return addRun({ agent: 'codex', job, status })
}

describe('run listing', () => {
  test('runs shows asking in the status column', async () => {
    const id = insert('asking')
    db()
      .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which shape?')
    expect((await command()).join('\n')).toMatch(
      new RegExp(`\\b${id}\\s+codex\\s+implement\\s+asking\\b`),
    )
  })

  test('runs emits one canonical row per resume chain', async () => {
    const root = insert('asking')
    const turn = insert('running')
    db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
    const text = (await command()).join('\n')
    expect(text).toMatch(new RegExp(`\\b${root}\\s+codex\\s+implement\\s+running\\b`))
    expect(text).not.toMatch(new RegExp(`\\b${turn}\\s+codex\\s+implement\\s+running\\b`))
    expect((await command({ json: true })).map(runJson).map((row) => row.id)).toEqual([root])
  })

  test('runs --unscored applies its filter before --limit', async () => {
    const older = [insert('ok', 'understand'), insert('ok', 'understand')]
    const newer = [
      insert('ok', 'understand'),
      insert('ok', 'understand'),
      insert('ok', 'understand'),
    ]
    for (const id of newer) score(id, 'full', 'right')
    expect(
      (await command({ unscored: true, json: true, limit: ['2'] }))
        .map(runJson)
        .map((row) => row.id),
    ).toEqual(older.reverse())
  })

  test('runs --id returns the union requested and reports unknown ids', async () => {
    const first = insert('ok')
    insert('ok')
    const second = insert('running', 'review-lens')
    const unknown = second + 1000
    const rows = (
      await command({ id: [String(first), String(second), String(unknown)], json: true })
    ).map(runJson)
    expect(rows.map((row) => row.id)).toEqual([second, first, unknown])
    expect(rows.at(-1) as unknown).toEqual({
      id: unknown,
      status: 'unknown',
      unknown: true,
    })
  })

  test('runs --id identifies a requested turn while returning its chain root', async () => {
    const root = insert('asking')
    const turn = insert('ok')
    db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
    expect(runJson((await command({ id: [String(turn)], json: true }))[0]!)).toMatchObject({
      id: root,
      requested_id: turn,
      resolved_from: 'turn',
    })
    expect((await command({ id: [String(turn)] })).join('\n')).toContain(
      `${root} (asked as turn ${turn})`,
    )
  })

  test('runs --id preserves both requested identities when they resolve to one root', async () => {
    const root = insert('asking')
    const turn = insert('ok')
    db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, turn)
    expect(
      (await command({ id: [String(root), String(turn)], json: true }))
        .map(runJson)
        .map((row) => [row.id, row.requested_id, row.resolved_from]),
    ).toEqual([
      [root, root, 'root'],
      [root, turn, 'turn'],
    ])
  })

  test('runs --id refuses a time window', async () => {
    const id = insert('ok')
    await expect(
      command({ id: [String(id)], since: ['2026-09-01T00:00:00Z'], json: true }),
    ).rejects.toThrow('orch runs --id and --since cannot be combined')
  })

  test('runs JSON emits every execution interval in a resumed chain', async () => {
    const starts = [
      '2026-09-01T12:00:00.000Z',
      '2026-09-01T12:10:00.000Z',
      '2026-09-01T12:30:00.000Z',
      '2026-09-01T13:00:00.000Z',
      '2026-09-01T13:40:00.000Z',
    ]
    const tokens = [260552, 62612, 1904392, 261452, 9309615]
    const root = addRun({ agent: 'codex', job: 'implement', startedAt: starts[0] })
    const ids = [root]
    for (let turn = 2; turn <= 5; turn++) {
      const startedAt = starts[turn - 1]
      if (!startedAt) throw new Error(`missing start for turn ${turn}`)
      ids.push(
        addRun({
          agent: 'codex',
          job: 'implement',
          parent: root,
          turn,
          startedAt,
        }),
      )
    }
    ids.forEach((id, i) => {
      const tokenCount = tokens[i]
      if (tokenCount === undefined) throw new Error(`missing token count for run ${id}`)
      db().query('UPDATE run SET vendor_tokens=? WHERE id=?').run(tokenCount, id)
    })
    const row = runJson((await command({ json: true, since: ['2026-09-01T12:20:00.000Z'] }))[0]!)
    expect(row.turns.map((turn: { id: number }) => turn.id)).toEqual(ids)
    expect(
      row.turns.reduce(
        (sum: number, turn: { vendor_tokens: number }) => sum + turn.vendor_tokens,
        0,
      ),
    ).toBe(11798623)
  })

  test('runs --json --since includes a chain whose only recent fact is a question', async () => {
    const id = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      startedAt: '2026-09-04T15:00:00.000Z',
    })
    db()
      .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
      .run(id, '2026-09-04T19:55:00.000Z', 'need a ruling')
    const row = runJson((await command({ json: true, since: ['2026-09-04T18:00:00.000Z'] }))[0]!)
    expect(row).toMatchObject({
      id,
      questions: [{ asked_at: '2026-09-04T19:55:00.000Z', answered_at: null }],
    })
  })

  test('runs --json --since republishes a question answered with no new turn', async () => {
    const id = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      startedAt: '2026-09-04T15:00:00.000Z',
    })
    db()
      .query('INSERT INTO question (run_id,asked_at,question,answered_at) VALUES (?,?,?,?)')
      .run(id, '2026-09-04T16:00:00.000Z', 'need a ruling', '2026-09-04T19:55:00.000Z')
    const question = runJson(
      (await command({ json: true, since: ['2026-09-04T18:00:00.000Z'] }))[0]!,
    ).questions[0]
    expect(question).toBeDefined()
    expect(question?.answered_at).toBe('2026-09-04T19:55:00.000Z')
  })

  test('runs --json --since still publishes an unanswered question older than the cutoff', async () => {
    const id = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      startedAt: '2026-09-04T15:00:00.000Z',
    })
    db()
      .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
      .run(id, '2026-09-04T16:00:00.000Z', 'still waiting')
    expect(
      (await command({ json: true, since: ['2026-09-04T18:00:00.000Z'] }))
        .map(runJson)
        .map((row) => row.id),
    ).toEqual([id])
  })

  test('runs --json publishes started_by_user_id', async () => {
    const id = insert('ok')
    const starter = '01990000-0000-7000-8000-000000000123'
    db().query('UPDATE run SET started_by_user_id=? WHERE id=?').run(starter, id)
    expect(runJson((await command({ json: true, id: [String(id)] }))[0]!).started_by_user_id).toBe(
      starter,
    )
  })

  test('runs --json publishes the root launch_key', async () => {
    const id = insert('ok')
    db().query('UPDATE run SET launch_key=? WHERE id=?').run('DEV-7777', id)
    expect(runJson((await command({ json: true, id: [String(id)] }))[0]!).launch_key).toBe(
      'DEV-7777',
    )
  })

  test('runs --json publishes the same evidence exclusion as run detail', async () => {
    const id = insert('ok', 'understand')
    db().query('UPDATE run SET evidence_excluded=? WHERE id=?').run('operator void', id)
    expect(runJson((await command({ json: true, id: [String(id)] }))[0]!).evidence_excluded).toBe(
      'operator void',
    )
    expect(runDetail(id)).toBeTruthy()
  })

  test('runs, runs --json, and --follow report the same failover chain', async () => {
    const root = addRun({ agent: 'codex', job: 'understand', status: 'failed', kind: 'quota' })
    const successor = addRun({ agent: 'grok', job: 'understand' })
    db()
      .query(
        'UPDATE run SET retry_of=?,automatic_failover=1,vendor_tokens=222,vendor_cost_usd=0.22 WHERE id=?',
      )
      .run(root, successor)
    db().query('UPDATE run SET vendor_tokens=111,vendor_cost_usd=0.11 WHERE id=?').run(root)
    const human = (await command()).join('\n')
    expect(human.match(new RegExp(`\\b${root}\\s+codex→grok`, 'g'))).toHaveLength(1)
    expect(human).not.toMatch(new RegExp(`\\b${successor}\\s+`))
    const rows = (await command({ json: true })).map(runJson) as unknown as {
      id: number
      retry_of: number | null
      failover_chain: string[]
      vendor_tokens: number
      vendor_cost_usd: number
    }[]
    expect(
      rows.map((row) => [row.id, row.retry_of, row.vendor_tokens, row.vendor_cost_usd]),
    ).toEqual([
      [successor, root, 222, 0.22],
      [root, null, 111, 0.11],
    ])
    expect(
      rows.every((row) => JSON.stringify(row.failover_chain) === JSON.stringify(['codex', 'grok'])),
    ).toBe(true)
  })

  test('runs --json publishes every question on the root, including child turns', async () => {
    const root = insert('asking')
    const child = insert('asking')
    db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, child)
    db()
      .query(
        `INSERT INTO question
           (run_id,asked_at,question,answered_at,asked_via,answerer_kind,answer_channel)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        root,
        '2026-09-04T10:00:00.000Z',
        'root q',
        '2026-09-04T10:05:00.000Z',
        'reply',
        'operator',
        'cli',
      )
    db()
      .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
      .run(child, '2026-09-04T10:10:00.000Z', 'child q')
    const rootQuestion = db().query('SELECT id FROM question WHERE run_id=?').get(root) as {
      id: number
    }
    db()
      .query(
        `INSERT INTO question_delivery (question_id,run_id,mode,outcome,at,error)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(rootQuestion.id, child, 'resume', 'delivered', '2026-09-04T10:06:00.000Z', null)
    const row = runJson((await command({ json: true, id: [String(root)] }))[0]!)
    expect(row.questions).toEqual([
      expect.objectContaining({
        run_id: root,
        answered_at: '2026-09-04T10:05:00.000Z',
        asked_via: 'reply',
        answerer_kind: 'operator',
        answer_channel: 'cli',
        deliveries: [
          {
            id: expect.any(Number),
            question_id: rootQuestion.id,
            run_id: child,
            mode: 'resume',
            outcome: 'delivered',
            at: '2026-09-04T10:06:00.000Z',
            error: null,
          },
        ],
      }),
      expect.objectContaining({
        run_id: child,
        answered_at: null,
        asked_via: null,
        answerer_kind: null,
        answer_channel: null,
        deliveries: [],
      }),
    ])
    expect(
      row.questions.every(
        (question: object) =>
          Object.keys(question).sort().join() ===
          'answer_channel,answered_at,answerer_kind,asked_at,asked_via,deliveries,id,run_id',
      ),
    ).toBe(true)
  })

  test('a deliberate retry remains separate from an automatic failover chain', async () => {
    const first = addRun({ agent: 'codex', job: 'understand', status: 'failed', kind: 'quota' })
    const retry = addRun({ agent: 'grok', job: 'understand' })
    db().query('UPDATE run SET retry_of=? WHERE id=?').run(first, retry)
    const human = (await command()).join('\n')
    expect(human).toMatch(new RegExp(`\\b${first}\\s+codex\\s+`))
    expect(human).toMatch(new RegExp(`\\b${retry}\\s+grok\\s+`))
    expect(human).not.toContain('codex→grok')
  })

  test('a resumed turn can also fail over forward without confusing the two axes', async () => {
    const root = addRun({ agent: 'codex', job: 'understand', status: 'failed' })
    const turn = addRun({
      agent: 'codex',
      job: 'understand',
      status: 'failed',
      kind: 'quota',
      parent: root,
      turn: 2,
    })
    const successor = addRun({ agent: 'grok', job: 'understand' })
    db().query('UPDATE run SET retry_of=?,automatic_failover=1 WHERE id=?').run(turn, successor)
    const human = (await command()).join('\n')
    expect(human.match(new RegExp(`\\b${root}\\s+codex→grok`, 'g'))).toHaveLength(1)
    expect(human).not.toMatch(new RegExp(`\\b${successor}\\s+`))
    const rows = (await command({ json: true })).map(runJson)
    expect(rows.find((row) => row.id === root)?.failover_chain).toEqual(['codex', 'grok'])
    expect(rows.find((row) => row.id === successor)?.retry_of).toBe(turn)
  })
})
