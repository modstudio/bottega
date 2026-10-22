import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { runJson } from '../../test/fixtures/replies.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import type { ProcessSample } from '../process-resource-sampler.ts'
import { runDetail } from '../state/serve.ts'
import { RUN_HOST_WAIT_MAX_MS, RUN_HOST_WAIT_POLL_MS } from './run-host-capacity.ts'
import { runIdentityMap, runListingCommand } from './run-listing.ts'

function command(
  args: Record<string, string[] | boolean> = {},
  thinOutputWarning: Parameters<typeof runListingCommand>[2]['thinOutputWarning'] = () => null,
  observation: Parameters<typeof runListingCommand>[2]['processObservation'] = {
    sampleProcesses: () => [],
    processStartTime: () => null,
  },
  clock: () => number = Date.now,
) {
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
              `SELECT 1 FROM question q JOIN run r ON r.record_id=q.run_record_id
       WHERE (r.record_id=? OR r.parent_run_record_id=?) AND q.delivery_pending_at IS NOT NULL`,
            )
            .get(root, root),
        ),
      strandedRecovery: (root) => `${PLATFORM_SLUG} run retry ${root} --agent`,
      thinOutputWarning,
      processObservation: observation,
      clock,
    },
  ).then(() => lines)
}

function insert(status: string, job = 'implement') {
  return addRun({ agent: 'codex', job, status })
}

function runNumber(recordId: string): number {
  return db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(recordId)!.number
}

describe('run listing', () => {
  test('run identity mapping includes roots and turns', () => {
    const root = insert('asking')
    const turn = insert('running')
    db().query('UPDATE run SET parent_run_record_id=?,turn=2 WHERE record_id=?').run(root, turn)

    const recordId = (id: string) =>
      db()
        .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
        .get(id)!.record_id
    expect(recordId(root)).not.toBe(recordId(turn))
    expect(
      runIdentityMap().filter((row) => row.record_id === root || row.record_id === turn),
    ).toEqual([
      { number: runNumber(root), record_id: recordId(root) },
      { number: runNumber(turn), record_id: recordId(turn) },
    ])
  })

  test('human runs renders lifecycle rows without resolving a dispatch job or warning', async () => {
    const id = insert('ok', 'landing-tree')
    let warningCalls = 0
    const lines = await command({ job: ['landing-tree'] }, () => {
      warningCalls++
      return 'unexpected warning'
    })

    expect(lines.join('\n')).toMatch(new RegExp(`\\b${runNumber(id)}\\s+codex\\s+landing-tree\\b`))
    expect(lines.join('\n')).not.toContain('unexpected warning')
    expect(warningCalls).toBe(0)
  })

  test('runs shows asking in the status column', async () => {
    const id = insert('asking')
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
      )
      .run(id, new Date().toISOString(), 'which shape?')
    expect((await command()).join('\n')).toMatch(
      new RegExp(`\\b${runNumber(id)}\\s+codex\\s+implement\\s+asking\\b`),
    )
  })

  test('runs emits one canonical row per resume chain', async () => {
    const root = insert('asking')
    const turn = insert('running')
    db().query('UPDATE run SET parent_run_record_id=?,turn=2 WHERE record_id=?').run(root, turn)
    const text = (await command()).join('\n')
    expect(text).toMatch(new RegExp(`\\b${runNumber(root)}\\s+codex\\s+implement\\s+running\\b`))
    expect(text).not.toMatch(
      new RegExp(`\\b${runNumber(turn)}\\s+codex\\s+implement\\s+running\\b`),
    )
    expect((await command({ json: true })).map(runJson).map((row) => row.record_id)).toEqual([root])
  })

  test('runs JSON publishes the stalled live member', async () => {
    const observedAt = Date.parse('2026-09-22T12:30:00.000Z')
    const id = addRun({
      agent: 'codex',
      job: 'review-lens',
      status: 'running',
      startedAt: '2026-09-22T12:00:00.000Z',
      session: 'stalled-listing',
    })
    db()
      .query('UPDATE run SET agent_pid=?,agent_start_time=?,last_event_at=? WHERE record_id=?')
      .run(process.pid, 'recorded birth', '2026-09-22T12:00:00.000Z', id)
    const samples: ProcessSample[] = [
      { pid: process.pid, ppid: 1, pgid: process.pid, cpu: 0, state: 'S' },
    ]

    const row = runJson(
      (
        await command(
          { json: true, id: [String(id)] },
          () => null,
          {
            sampleProcesses: () => samples,
            processStartTime: () => 'recorded birth',
          },
          () => observedAt,
        )
      )[0]!,
    )

    expect(row).toMatchObject({
      number: runNumber(id),
      record_id: id,
      live_member_id: id,
      live_member_number: runNumber(id),
      stall_state: 'stalled',
    })
    expect(row.stall).toBeString()
    expect((row.stall as string).length).toBeGreaterThan(0)
  })

  test('runs publish capacity waits and live throttle details instead of idle', async () => {
    const waiting = addRun({ agent: '(pending)', job: 'review-lens', status: 'running' })
    appendRunEvent(waiting, {
      ts: '2026-10-21T12:00:00.000Z',
      type: 'capacity_wait',
      waiting: true,
    })
    const throttled = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
    appendRunEvent(throttled, {
      ts: '2026-10-21T12:01:00.000Z',
      type: 'throttled',
      attempt: 1,
      max: 5,
      retryDelayMs: 225_000,
      retryAt: '2026-10-21T12:04:45.000Z',
      status: 429,
      concurrency: 6,
    })

    const rows = (await command({ json: true, id: [waiting, throttled] })).map(runJson)
    expect(rows.find((row) => row.record_id === waiting)).toMatchObject({
      waiting_for_capacity: true,
      capacity_wait_since: '2026-10-21T12:00:00.000Z',
    })
    expect(rows.find((row) => row.record_id === throttled)).toMatchObject({
      throttled: {
        attempt: 1,
        max: 5,
        retry_at: '2026-10-21T12:04:45.000Z',
        status: 429,
        concurrency: 6,
      },
    })
    expect(runDetail(waiting)).toMatchObject({
      live_status_detail: 'waiting for capacity since 2026-10-21T12:00:00.000Z',
    })
    expect(runDetail(throttled)).toMatchObject({
      live_status_detail: 'throttled (429), retry 1/5 at 2026-10-21T12:04:45.000Z',
      throttled: {
        attempt: 1,
        max: 5,
        retry_delay_ms: 225_000,
        retry_at: '2026-10-21T12:04:45.000Z',
        status: 429,
        concurrency: 6,
      },
    })
  })

  test('runs JSON and run detail publish all run resource fields', async () => {
    const id = insert('ok')
    db()
      .query(
        `UPDATE run SET resource_cpu_ms=?,resource_peak_rss_bytes=?,resource_samples=?,resource_source=?
          WHERE record_id=?`,
      )
      .run(12_345, 67_890, 4, 'sampled', id)
    const expected = {
      resource_cpu_ms: 12_345,
      resource_peak_rss_bytes: 67_890,
      resource_samples: 4,
      resource_source: 'sampled',
    }

    expect(runJson((await command({ json: true, id: [String(id)] }))[0]!)).toMatchObject(expected)
    expect(runDetail(id)).toMatchObject(expected)
  })

  test('runs JSON evaluates whether the host-capacity wait is fresh', async () => {
    const observedAt = Date.parse('2026-10-21T12:00:00.000Z')
    const fresh = insert('running')
    const stale = insert('running')
    db()
      .query('UPDATE run SET host_wait_since=? WHERE record_id=?')
      .run(new Date(observedAt - 1_000).toISOString(), fresh)
    db()
      .query('UPDATE run SET host_wait_since=? WHERE record_id=?')
      .run(
        new Date(observedAt - RUN_HOST_WAIT_MAX_MS - RUN_HOST_WAIT_POLL_MS - 1).toISOString(),
        stale,
      )

    const rows = (
      await command(
        { json: true },
        () => null,
        { sampleProcesses: () => [], processStartTime: () => null },
        () => observedAt,
      )
    )
      .map(runJson)
      .filter((row) => row.record_id === fresh || row.record_id === stale)
    expect(rows.find((row) => row.record_id === fresh)?.waiting_for_host_capacity).toBe(true)
    expect(rows.find((row) => row.record_id === stale)?.waiting_for_host_capacity).toBe(false)
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
        .map((row) => row.record_id),
    ).toEqual(older.reverse())
  })

  test('runs --id returns the union requested and reports unknown ids', async () => {
    const first = insert('ok')
    insert('ok')
    const second = insert('running', 'review-lens')
    const secondNumber = runNumber(second)
    const unknown = secondNumber + 1000
    const rows = (
      await command({
        id: [String(first), String(second), String(unknown)],
        json: true,
      })
    ).map(runJson)
    expect(rows.slice(0, 2).map((row) => row.record_id)).toEqual([second, first])
    expect(rows.at(-1) as unknown).toEqual({
      number: unknown,
      status: 'unknown',
      unknown: true,
    })
  })

  test('human runs --id reports an unknown UUID and an unknown number instead of printing nothing', async () => {
    const missingRecordId = '01a10000-0000-7000-8000-000000000000'
    const known = insert('ok')
    const missingNumber = runNumber(known) + 1000
    const lines = (await command({ id: [missingRecordId, String(missingNumber)] })).join('\n')
    expect(lines).toContain(`${missingRecordId}  unknown run id`)
    expect(lines).toContain(`${missingNumber}  unknown run id`)
  })

  test('runs --id identifies a requested turn while returning its chain root', async () => {
    const root = insert('asking')
    const turn = insert('ok')
    db().query('UPDATE run SET parent_run_record_id=?,turn=2 WHERE record_id=?').run(root, turn)
    expect(runJson((await command({ id: [String(turn)], json: true }))[0]!)).toMatchObject({
      record_id: root,
      requested_id: turn,
      resolved_from: 'turn',
    })
    expect((await command({ id: [String(turn)] })).join('\n')).toContain(
      `${runNumber(root)} (asked as turn ${runNumber(turn)})`,
    )
  })

  test('runs --id resolves a machine UUID without deriving identity from its number', async () => {
    const id = insert('ok')
    const recordId = db()
      .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
      .get(id)!.record_id
    expect(runJson((await command({ id: [recordId], json: true }))[0]!)).toMatchObject({
      record_id: recordId,
      requested_record_id: recordId,
    })
  })

  test('runs --id preserves both requested identities when they resolve to one root', async () => {
    const root = insert('asking')
    const turn = insert('ok')
    db().query('UPDATE run SET parent_run_record_id=?,turn=2 WHERE record_id=?').run(root, turn)
    expect(
      (await command({ id: [String(root), String(turn)], json: true }))
        .map(runJson)
        .map((row) => [row.record_id, row.requested_id, row.resolved_from]),
    ).toEqual([
      [root, root, 'root'],
      [root, turn, 'turn'],
    ])
  })

  test('runs --id refuses a time window', async () => {
    const id = insert('ok')
    await expect(
      command({
        id: [String(id)],
        since: ['2026-09-01T00:00:00Z'],
        json: true,
      }),
    ).rejects.toThrow(`${PLATFORM_SLUG} run list --id and --since cannot be combined`)
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
    const root = addRun({
      agent: 'codex',
      job: 'implement',
      startedAt: starts[0],
    })
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
      db().query('UPDATE run SET vendor_tokens=? WHERE record_id=?').run(tokenCount, id)
    })
    const row = runJson((await command({ json: true, since: ['2026-09-01T12:20:00.000Z'] }))[0]!)
    expect(row.turns.map((turn) => turn.record_id)).toEqual(ids)
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
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
      )
      .run(id, '2026-09-04T19:55:00.000Z', 'need a ruling')
    const row = runJson((await command({ json: true, since: ['2026-09-04T18:00:00.000Z'] }))[0]!)
    expect(row).toMatchObject({
      record_id: id,
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
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question,answered_at) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?)`,
      )
      .run(id, '2026-09-04T16:00:00.000Z', 'need a ruling', '2026-09-04T19:55:00.000Z')
    const question = runJson(
      (await command({ json: true, since: ['2026-09-04T18:00:00.000Z'] }))[0]!,
    ).questions[0]
    expect(question).toBeDefined()
    expect(question?.answered_at).toBe('2026-09-04T19:55:00.000Z')
  })

  test('runs --json --since republishes a question closed with no new turn', async () => {
    const id = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      startedAt: '2026-09-04T15:00:00.000Z',
    })
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question,closed_at,close_reason)
         VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?,?)`,
      )
      .run(
        id,
        '2026-09-04T16:00:00.000Z',
        'obsolete question',
        '2026-09-04T19:55:00.000Z',
        'run closed',
      )
    const question = runJson(
      (await command({ json: true, since: ['2026-09-04T18:00:00.000Z'] }))[0]!,
    ).questions[0]
    expect(question).toMatchObject({
      closed_at: '2026-09-04T19:55:00.000Z',
      close_reason: 'run closed',
    })
  })

  test('runs --json publishes question closure', async () => {
    const id = insert('ok')
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question,closed_at,close_reason)
         VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?,?)`,
      )
      .run(
        id,
        '2026-09-04T16:00:00.000Z',
        'obsolete question',
        '2026-09-04T19:55:00.000Z',
        'run closed',
      )
    const question = runJson((await command({ json: true, id: [String(id)] }))[0]!).questions[0]
    expect(question).toMatchObject({
      closed_at: '2026-09-04T19:55:00.000Z',
      close_reason: 'run closed',
    })
  })

  test('runs --json --since still publishes an unanswered question older than the cutoff', async () => {
    const id = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      startedAt: '2026-09-04T15:00:00.000Z',
    })
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
      )
      .run(id, '2026-09-04T16:00:00.000Z', 'still waiting')
    expect(
      (await command({ json: true, since: ['2026-09-04T18:00:00.000Z'] }))
        .map(runJson)
        .map((row) => row.record_id),
    ).toEqual([id])
  })

  test('runs --json publishes started_by_user_id', async () => {
    const id = insert('ok')
    const starter = '01990000-0000-7000-8000-000000000123'
    db().query('UPDATE run SET started_by_user_id=? WHERE record_id=?').run(starter, id)
    expect(runJson((await command({ json: true, id: [String(id)] }))[0]!).started_by_user_id).toBe(
      starter,
    )
  })

  test('runs --json publishes the root launch_key', async () => {
    const id = insert('ok')
    db().query('UPDATE run SET launch_key=? WHERE record_id=?').run('DEV-7777', id)
    expect(runJson((await command({ json: true, id: [String(id)] }))[0]!).launch_key).toBe(
      'DEV-7777',
    )
  })

  test('runs --json publishes the same evidence exclusion as run detail', async () => {
    const id = insert('ok', 'understand')
    db().query('UPDATE run SET evidence_excluded=? WHERE record_id=?').run('operator void', id)
    expect(runJson((await command({ json: true, id: [String(id)] }))[0]!).evidence_excluded).toBe(
      'operator void',
    )
    expect(runDetail(id)).toBeTruthy()
  })

  test('runs, runs --json, and --follow report the same failover chain', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'understand',
      status: 'failed',
      kind: 'quota',
    })
    const successor = addRun({ agent: 'grok', job: 'understand' })
    db()
      .query(
        'UPDATE run SET retry_of_record_id=?,automatic_failover=1,vendor_tokens=222,vendor_cost_usd=0.22 WHERE record_id=?',
      )
      .run(root, successor)
    db().query('UPDATE run SET vendor_tokens=111,vendor_cost_usd=0.11 WHERE record_id=?').run(root)
    const human = (await command()).join('\n')
    expect(human.match(new RegExp(`\\b${runNumber(root)}\\s+codex→grok`, 'g'))).toHaveLength(1)
    expect(human).not.toMatch(new RegExp(`\\b${runNumber(successor)}\\s+`))
    const rows = (await command({ json: true })).map(runJson) as unknown as {
      record_id: string
      retry_record_id: string | null
      failover_chain: string[]
      vendor_tokens: number
      vendor_cost_usd: number
    }[]
    expect(
      rows.map((row) => [
        row.record_id,
        row.retry_record_id,
        row.vendor_tokens,
        row.vendor_cost_usd,
      ]),
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
    db().query('UPDATE run SET parent_run_record_id=?,turn=2 WHERE record_id=?').run(root, child)
    db()
      .query(
        `INSERT INTO question
           (number,record_id,run_record_id,asked_at,question,answered_at,asked_via,answerer_kind,answer_channel)
         VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?,?,?,?)`,
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
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
      )
      .run(child, '2026-09-04T10:10:00.000Z', 'child q')
    const rootQuestion = db()
      .query('SELECT record_id FROM question WHERE run_record_id=?')
      .get(root) as {
      record_id: string
    }
    db()
      .query(
        `INSERT INTO question_delivery (record_id, question_record_id,run_record_id,mode,outcome,at,error)
         VALUES ('${newRecordId()}', ?,?,?,?,?,?)`,
      )
      .run(rootQuestion.record_id, child, 'resume', 'delivered', '2026-09-04T10:06:00.000Z', null)
    const row = runJson((await command({ json: true, id: [String(root)] }))[0]!)
    expect(row.questions).toEqual([
      expect.objectContaining({
        run_record_id: root,
        answered_at: '2026-09-04T10:05:00.000Z',
        asked_via: 'reply',
        answerer_kind: 'operator',
        answer_channel: 'cli',
        deliveries: [
          expect.objectContaining({
            id: expect.any(Number),
            question_record_id: rootQuestion.record_id,
            run_record_id: child,
            mode: 'resume',
            outcome: 'delivered',
            at: '2026-09-04T10:06:00.000Z',
            error: null,
          }),
        ],
      }),
      expect.objectContaining({
        run_record_id: child,
        answered_at: null,
        asked_via: null,
        answerer_kind: null,
        answer_channel: null,
        deliveries: [],
      }),
    ])
    expect(row.questions.every((question: Record<string, unknown>) => question.record_id)).toBe(
      true,
    )
    expect(
      (row.questions[0] as unknown as { deliveries: Record<string, unknown>[] }).deliveries.every(
        (delivery: Record<string, unknown>) =>
          delivery.question_record_id && delivery.run_record_id,
      ),
    ).toBe(true)
    expect(
      row.questions.every(
        (question: object) =>
          Object.keys(question).sort().join() ===
          'answer_channel,answered_at,answerer_kind,asked_at,asked_via,close_reason,closed_at,deliveries,id,overturned_at,record_id,run_number,run_record_id',
      ),
    ).toBe(true)
  })

  test('a deliberate retry remains separate from an automatic failover chain', async () => {
    const first = addRun({
      agent: 'codex',
      job: 'understand',
      status: 'failed',
      kind: 'quota',
    })
    const retry = addRun({ agent: 'grok', job: 'understand' })
    db().query('UPDATE run SET retry_of_record_id=? WHERE record_id=?').run(first, retry)
    const human = (await command()).join('\n')
    expect(human).toMatch(new RegExp(`\\b${runNumber(first)}\\s+codex\\s+`))
    expect(human).toMatch(new RegExp(`\\b${runNumber(retry)}\\s+grok\\s+`))
    expect(human).not.toContain('codex→grok')
  })

  test('a resumed turn can also fail over forward without confusing the two axes', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'understand',
      status: 'failed',
    })
    const turn = addRun({
      agent: 'codex',
      job: 'understand',
      status: 'failed',
      kind: 'quota',
      parent: root,
      turn: 2,
    })
    const successor = addRun({ agent: 'grok', job: 'understand' })
    db()
      .query('UPDATE run SET retry_of_record_id=?,automatic_failover=1 WHERE record_id=?')
      .run(turn, successor)
    const human = (await command()).join('\n')
    expect(human.match(new RegExp(`\\b${runNumber(root)}\\s+codex→grok`, 'g'))).toHaveLength(1)
    expect(human).not.toMatch(new RegExp(`\\b${runNumber(successor)}\\s+`))
    const rows = (await command({ json: true })).map(runJson)
    expect(rows.find((row) => row.record_id === root)?.failover_chain).toEqual(['codex', 'grok'])
    expect(rows.find((row) => row.record_id === successor)?.retry_record_id).toBe(turn)
  })
})
