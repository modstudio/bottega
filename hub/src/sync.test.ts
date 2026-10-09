import { beforeEach, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { hostedCollectLegs } from './collect.ts'
import { db, writeTransaction } from './db.ts'
import { evidenceApi } from './evidence-api.ts'
import type { IntervalEvidence } from './hosted-evidence.ts'
import { batches, contentHash, signedInRecordUserId, syncEvidence } from './sync.ts'

beforeEach(resetFixtureStore)

const identity = (capability = true, intervalRecordId = true, dayRecordId = true) => ({
  userId: 'user-1',
  activeSpaceId: 'space-active',
  memberships: [
    { spaceId: 'space-active', slug: 'active' },
    { spaceId: 'space-a', slug: 'alpha' },
    { spaceId: 'space-b', slug: 'beta' },
  ],
  capabilities: capability
    ? { targetSpaceIntervalEvidence: true, intervalRecordId, dayRecordId }
    : {},
})

function interval(ref: string, project: string | null): IntervalEvidence & { id: string } {
  return {
    id: `00000000-0000-4000-8000-00000000000${ref}`,
    task_key: null,
    project_name: project,
    source: 'orch',
    agent: null,
    job: null,
    start_at: `2026-10-08T00:00:0${ref}.000Z`,
    end_at: `2026-10-08T00:00:0${ref}.000Z`,
    claude_tokens: 0,
    vendor_tokens: 0,
    vendor_cost_usd: null,
    ref: `orch:${ref}`,
    via: null,
    open: 0,
    session_id: null,
    user_id: null,
  }
}

function insertInterval(row: IntervalEvidence & { id: string }) {
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO interval
          (record_id,task_key,project,source,agent,job,start_at,end_at,claude_tokens,vendor_tokens,
           vendor_cost_usd,ref,via,open,session_id,user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.task_key,
        row.project_name,
        row.source,
        row.agent,
        row.job,
        row.start_at,
        row.end_at,
        row.claude_tokens,
        row.vendor_tokens,
        row.vendor_cost_usd,
        row.ref,
        row.via,
        row.open,
        row.session_id,
        row.user_id,
      )
  })
}

const keyOf = (row: IntervalEvidence & { id?: string }) => row.id!

function seedPrePushMove() {
  const row = interval('1', 'two')
  insertInterval(row)
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO record_ledger
           (table_name,local_key,content_hash,synced_at,destination_space_id)
         VALUES ('interval',?,?,?,?)`,
      )
      .run(keyOf(row), contentHash(row), '2026-10-01T00:00:00.000Z', 'space-a'),
  )
  const hosted: HostedIntervalCopy[] = [
    {
      spaceId: 'space-a',
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      source: row.source,
      ref: row.ref,
      start_at: row.start_at,
    },
  ]
  return { row, hosted }
}

type HostedIntervalCopy = {
  spaceId: string
  id: string
  source: string
  ref: string
  start_at: string
}

function applyHostedIntervalWrite(
  hosted: HostedIntervalCopy[],
  method: string,
  spaceId: string,
  body: Record<string, unknown>,
) {
  const ids = (body.ids as string[] | undefined) ?? []
  const keys = (body.keys as HostedIntervalCopy[] | undefined) ?? []
  if (method === 'DELETE') {
    hosted.splice(
      0,
      hosted.length,
      ...hosted.filter(
        (row) =>
          row.spaceId !== spaceId ||
          !(
            ids.includes(row.id) ||
            keys.some(
              (key) =>
                key.source === row.source && key.ref === row.ref && key.start_at === row.start_at,
            )
          ),
      ),
    )
    return
  }
  if (method === 'PUT')
    hosted.push(
      ...((body.rows as IntervalEvidence[]) ?? [])
        .filter((row) => row.id)
        .map((row) => ({
          spaceId,
          id: row.id!,
          source: row.source,
          ref: row.ref,
          start_at: row.start_at,
        })),
    )
}

function syncFetch(
  writes: Array<{ method: string; recordSpace: string | null; body: Record<string, unknown> }>,
  options: {
    capability?: boolean
    intervalRecordId?: boolean
    dayRecordId?: boolean
    failSpace?: string
    hosted?: HostedIntervalCopy[]
  } = {},
) {
  return async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/tasks/identity'))
      return Response.json(
        identity(
          options.capability !== false,
          options.intervalRecordId !== false,
          options.dayRecordId !== false,
        ),
      )
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    const recordSpace = new Headers(init?.headers).get('x-record-space')
    writes.push({ method: init?.method ?? 'GET', recordSpace, body })
    if (recordSpace === options.failSpace)
      return Response.json({ error: 'destination unavailable' }, { status: 503 })
    if (options.hosted && recordSpace)
      applyHostedIntervalWrite(options.hosted, init?.method ?? 'GET', recordSpace, body)
    return Response.json({ ok: true })
  }
}

const registered = [
  { name: 'one', settings: { space: 'alpha' } },
  { name: 'two', settings: { space: 'beta' } },
]

describe('evidence sync planning', () => {
  test('captures the signed-in record user and keeps an absent session null', async () => {
    expect(
      await signedInRecordUserId({
        baseUrl: 'https://record.example.test',
        token: 'session',
        fetch: async (url) => {
          expect(url).toBe('https://record.example.test/v1/tasks/identity')
          return Response.json({ userId: 'user-42' })
        },
      }),
    ).toBe('user-42')
    expect(
      await signedInRecordUserId({ baseUrl: 'https://record.example.test', token: null }),
    ).toBeNull()
    expect(
      await signedInRecordUserId({
        baseUrl: 'https://record.example.test',
        token: 'expired',
        fetch: async () => new Response('signed out', { status: 401 }),
      }),
    ).toBeNull()
  })

  test('names the hosted hub response when identity returns HTML', async () => {
    await expect(
      signedInRecordUserId({
        baseUrl: 'https://record.example.test',
        token: 'session',
        fetch: async () =>
          new Response('<html>app</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      }),
    ).rejects.toThrow(
      'hosted hub refused the response from https://record.example.test/v1/tasks/identity (status 200, content type text/html)',
    )
  })

  test('hashes stable content deterministically', () => {
    const row = { source: 'orch', ref: 'orch:1', start_at: '2026-09-17T00:00:00.000Z' }
    expect(contentHash(row)).toBe(contentHash({ ...row }))
    expect(contentHash({ ...row, ref: 'orch:2' })).not.toBe(contentHash(row))
  })

  test('an absent hosted record skips the push', async () => {
    const hostedUrl = process.env.HUB_HOSTED_URL
    try {
      delete process.env.HUB_HOSTED_URL
      const result = await syncEvidence()
      expect(result.interval.changed).toBe(0)
      expect(result.day.changed).toBe(0)
    } finally {
      if (hostedUrl === undefined) delete process.env.HUB_HOSTED_URL
      else process.env.HUB_HOSTED_URL = hostedUrl
    }
  })

  test('splits writes at the hosted batch limit', () => {
    expect(
      batches(Array.from({ length: 1_001 }, (_, index) => index)).map((x) => x.length),
    ).toEqual([500, 500, 1])
  })

  test('groups project intervals by registered destination, not the third active space', async () => {
    insertInterval(interval('1', 'one'))
    insertInterval(interval('2', 'two'))
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []

    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes),
      registeredProjects: registered,
    })

    expect(writes).toHaveLength(2)
    expect(writes.map((write) => write.recordSpace).sort()).toEqual(['space-a', 'space-b'])
    expect(writes.some((write) => write.recordSpace === 'space-active')).toBe(false)
  })

  test('sends a projectless interval to the active space', async () => {
    insertInterval(interval('1', null))
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes),
      registeredProjects: registered,
    })
    expect(writes.map((write) => write.recordSpace)).toEqual(['space-active'])
  })

  test('reports a refused project without acknowledging it while delivering another', async () => {
    const refused = interval('1', 'missing')
    const delivered = interval('2', 'one')
    insertInterval(refused)
    insertInterval(delivered)
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    const result = await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes),
      registeredProjects: registered,
    })

    expect(result.interval.issues).toEqual([{ project: 'missing', reason: 'unregistered-project' }])
    expect(writes).toHaveLength(1)
    expect(
      db()
        .query<{ local_key: string }, []>(
          `SELECT local_key FROM record_ledger WHERE table_name='interval'`,
        )
        .all(),
    ).toEqual([{ local_key: keyOf(delivered) }])
  })

  test('hosted collection reports a refused project after delivering healthy evidence and continues', async () => {
    const refused = interval('1', 'missing')
    const delivered = interval('2', 'one')
    insertInterval(refused)
    insertInterval(delivered)
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    const ran: string[] = []

    const results = await hostedCollectLegs(undefined, {
      evidence: () =>
        syncEvidence({
          baseUrl: 'https://hub.example.test',
          token: 'session',
          fetch: syncFetch(writes),
          registeredProjects: registered,
        }),
      tasks: async () => {
        ran.push('following leg')
      },
      notes: async () => {},
      reports: async () => {},
    })

    expect(writes.map((write) => write.recordSpace)).toEqual(['space-a'])
    expect(ran).toEqual(['following leg'])
    expect(results).toEqual([
      {
        source: 'hosted evidence',
        ok: false,
        error: 'interval sync issues: missing: unregistered-project',
      },
      { source: 'hosted tasks', ok: true },
      { source: 'hosted notes', ok: true },
      { source: 'hosted reports', ok: true },
    ])
    expect(
      db()
        .query<{ local_key: string }, []>(
          `SELECT local_key FROM record_ledger WHERE table_name='interval'`,
        )
        .all(),
    ).toEqual([{ local_key: keyOf(delivered) }])
  })

  test('resends a legacy acknowledgement with no destination', async () => {
    const row = interval('1', 'one')
    insertInterval(row)
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO record_ledger (table_name,local_key,content_hash,synced_at)
           VALUES ('interval',?,?,?)`,
        )
        .run(keyOf(row), contentHash(row), '2026-10-01T00:00:00.000Z'),
    )
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes),
      registeredProjects: registered,
    })
    expect(writes.map((write) => write.method)).toEqual(['PUT'])
    expect(
      db()
        .query<{ destination_space_id: string }, []>(
          `SELECT destination_space_id FROM record_ledger WHERE table_name='interval'`,
        )
        .get(),
    ).toEqual({ destination_space_id: 'space-a' })
  })

  test('moves an acknowledgement only after sending new and deleting old', async () => {
    const row = interval('1', 'two')
    insertInterval(row)
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO record_ledger
             (table_name,local_key,content_hash,synced_at,destination_space_id)
           VALUES ('interval',?,?,?,?)`,
        )
        .run(keyOf(row), contentHash(row), '2026-10-01T00:00:00.000Z', 'space-a'),
    )
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes),
      registeredProjects: registered,
    })
    expect(writes.map((write) => [write.method, write.recordSpace])).toEqual([
      ['DELETE', 'space-a'],
      ['DELETE', 'space-a'],
      ['PUT', 'space-b'],
    ])
    expect(
      db()
        .query<{ destination_space_id: string }, []>(
          `SELECT destination_space_id FROM record_ledger WHERE table_name='interval'`,
        )
        .get(),
    ).toEqual({ destination_space_id: 'space-b' })
  })

  test('a failed new-destination send preserves the old acknowledgement', async () => {
    const row = interval('1', 'two')
    insertInterval(row)
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO record_ledger
             (table_name,local_key,content_hash,synced_at,destination_space_id)
           VALUES ('interval',?,?,?,?)`,
        )
        .run(keyOf(row), contentHash(row), '2026-10-01T00:00:00.000Z', 'space-a'),
    )
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    const result = await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes, { failSpace: 'space-b' }),
      registeredProjects: registered,
    })
    expect(writes.map((write) => [write.method, write.recordSpace])).toEqual([
      ['DELETE', 'space-a'],
      ['DELETE', 'space-a'],
      ['PUT', 'space-b'],
    ])
    expect(result.interval.issues[0]?.reason).toContain('delivery-failed')
    expect(
      db()
        .query<{ destination_space_id: string }, []>(
          `SELECT destination_space_id FROM record_ledger WHERE table_name='interval'`,
        )
        .get(),
    ).toEqual({ destination_space_id: 'space-a' })
  })

  test('deletes a vanished row from its acknowledged destination', async () => {
    const current = interval('1', 'one')
    const vanished = interval('2', 'two')
    insertInterval(current)
    writeTransaction((conn) => {
      const put = conn.query(
        `INSERT INTO record_ledger
           (table_name,local_key,content_hash,synced_at,destination_space_id)
         VALUES ('interval',?,?,?,?)`,
      )
      put.run(keyOf(current), contentHash(current), '2026-10-01T00:00:00.000Z', 'space-a')
      put.run(keyOf(vanished), contentHash(vanished), '2026-10-01T00:00:00.000Z', 'space-b')
    })
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes),
      registeredProjects: registered,
    })
    expect(writes.map((write) => [write.method, write.recordSpace, write.body])).toEqual([
      ['DELETE', 'space-b', { ids: [keyOf(vanished)] }],
    ])
    expect(db().query(`SELECT COUNT(*) AS n FROM record_ledger`).get()).toEqual({ n: 1 })
  })

  test('an empty local interval table skips deletes and keeps every acknowledgement', async () => {
    const vanished = interval('2', 'two')
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO record_ledger
             (table_name,local_key,content_hash,synced_at,destination_space_id)
           VALUES ('interval',?,?,?,?)`,
        )
        .run(keyOf(vanished), contentHash(vanished), '2026-10-01T00:00:00.000Z', 'space-b'),
    )
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []

    const result = await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes),
      registeredProjects: registered,
    })

    expect(result.interval.deleteSkipped).toBe(true)
    expect(result.interval.deleted).toBe(0)
    expect(writes).toEqual([])
    expect(db().query(`SELECT COUNT(*) AS n FROM record_ledger`).get()).toEqual({ n: 1 })
  })

  test('retires a vanished legacy acknowledgement without guessing its hosted destination', async () => {
    const current = interval('1', 'one')
    const vanished = interval('2', 'two')
    insertInterval(current)
    writeTransaction((conn) => {
      const put = conn.query(
        `INSERT INTO record_ledger
           (table_name,local_key,content_hash,synced_at,destination_space_id)
         VALUES ('interval',?,?,?,?)`,
      )
      put.run(keyOf(current), contentHash(current), '2026-10-01T00:00:00.000Z', 'space-a')
      put.run(keyOf(vanished), contentHash(vanished), '2026-10-01T00:00:00.000Z', null)
    })
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []

    const result = await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes),
      registeredProjects: registered,
    })

    expect(writes).toEqual([])
    expect(result.interval.deleted).toBe(0)
    expect(result.interval.issues).toEqual([
      {
        project: null,
        reason:
          '1 vanished interval acknowledgement had an unknown hosted destination; the hosted row was left in place',
      },
    ])
    expect(
      db()
        .query<{ local_key: string }, []>(
          `SELECT local_key FROM record_ledger WHERE table_name='interval'`,
        )
        .all(),
    ).toEqual([{ local_key: keyOf(current) }])
  })

  test('a failed move PUT leaves the ledger unchanged and the next sync completes the move', async () => {
    const row = interval('1', 'two')
    insertInterval(row)
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO record_ledger
             (table_name,local_key,content_hash,synced_at,destination_space_id)
           VALUES ('interval',?,?,?,?)`,
        )
        .run(keyOf(row), contentHash(row), '2026-10-01T00:00:00.000Z', 'space-a'),
    )
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch([], { failSpace: 'space-b' }),
      registeredProjects: registered,
    })
    expect(
      db()
        .query<{ destination_space_id: string }, []>(
          `SELECT destination_space_id FROM record_ledger WHERE table_name='interval'`,
        )
        .get(),
    ).toEqual({ destination_space_id: 'space-a' })

    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes),
      registeredProjects: registered,
    })
    expect(writes.map((write) => [write.method, write.recordSpace])).toEqual([
      ['DELETE', 'space-a'],
      ['DELETE', 'space-a'],
      ['PUT', 'space-b'],
    ])
    expect(
      db()
        .query<{ destination_space_id: string }, []>(
          `SELECT destination_space_id FROM record_ledger WHERE table_name='interval'`,
        )
        .get(),
    ).toEqual({ destination_space_id: 'space-b' })
  })

  test('a space move before the first push leaves one hosted row in the new space', async () => {
    const { row, hosted } = seedPrePushMove()
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch([], { hosted }),
      registeredProjects: registered,
    })
    expect(hosted).toEqual([
      { spaceId: 'space-b', id: row.id, source: row.source, ref: row.ref, start_at: row.start_at },
    ])
  })

  test('a failed pre-push space-move PUT leaves the ledger and completes on retry', async () => {
    const { row, hosted } = seedPrePushMove()
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch([], { failSpace: 'space-b', hosted }),
      registeredProjects: registered,
    })
    expect(
      db()
        .query<{ destination_space_id: string }, []>(
          `SELECT destination_space_id FROM record_ledger WHERE table_name='interval'`,
        )
        .get(),
    ).toEqual({ destination_space_id: 'space-a' })
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch([], { hosted }),
      registeredProjects: registered,
    })
    expect(
      db()
        .query<{ destination_space_id: string }, []>(
          `SELECT destination_space_id FROM record_ledger WHERE table_name='interval'`,
        )
        .get(),
    ).toEqual({ destination_space_id: 'space-b' })
    expect(hosted).toEqual([
      { spaceId: 'space-b', id: row.id, source: row.source, ref: row.ref, start_at: row.start_at },
    ])
  })

  test('after an unchanged collection the next push sends no interval', async () => {
    insertInterval(interval('1', 'one'))
    const first: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(first),
      registeredProjects: registered,
    })
    expect(first.map((write) => write.method)).toEqual(['PUT'])
    const second: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(second),
      registeredProjects: registered,
    })
    expect(second).toEqual([])
  })

  test('a re-timed row produces one PUT and one DELETE by UUID', async () => {
    const original = interval('1', 'one')
    insertInterval(original)
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch([]),
      registeredProjects: registered,
    })
    const replacement = interval('2', 'one')
    writeTransaction((conn) => {
      conn.query(`DELETE FROM interval WHERE record_id=?`).run(original.id)
      conn
        .query(
          `INSERT INTO interval
            (record_id,task_key,project,source,agent,job,start_at,end_at,claude_tokens,vendor_tokens,
             vendor_cost_usd,ref,via,open,session_id,user_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          replacement.id,
          replacement.task_key,
          replacement.project_name,
          replacement.source,
          replacement.agent,
          replacement.job,
          replacement.start_at,
          replacement.end_at,
          replacement.claude_tokens,
          replacement.vendor_tokens,
          replacement.vendor_cost_usd,
          original.ref,
          replacement.via,
          replacement.open,
          replacement.session_id,
          replacement.user_id,
        )
    })
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes),
      registeredProjects: registered,
    })
    expect(writes.map((write) => [write.method, write.recordSpace, write.body])).toEqual([
      ['PUT', 'space-a', { rows: [{ ...replacement, ref: original.ref }] }],
      ['DELETE', 'space-a', { ids: [original.id] }],
    ])
  })

  test('a vanished tuple acknowledgement deletes by tuple one last time', async () => {
    const current = interval('1', 'one')
    insertInterval(current)
    writeTransaction((conn) => {
      const put = conn.query(
        `INSERT INTO record_ledger
           (table_name,local_key,content_hash,synced_at,destination_space_id)
         VALUES ('interval',?,?,?,?)`,
      )
      put.run(current.id, contentHash(current), '2026-10-01T00:00:00.000Z', 'space-a')
      put.run(
        '["orch","orch:gone","2026-10-08T00:00:00.000Z"]',
        'hash-gone',
        '2026-10-01T00:00:00.000Z',
        'space-b',
      )
    })
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    await syncEvidence({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: syncFetch(writes),
      registeredProjects: registered,
    })
    expect(writes).toEqual([
      {
        method: 'DELETE',
        recordSpace: 'space-b',
        body: {
          keys: [{ source: 'orch', ref: 'orch:gone', start_at: '2026-10-08T00:00:00.000Z' }],
        },
      },
    ])
  })

  test('refuses a server without interval target-space support before any write', async () => {
    insertInterval(interval('1', 'one'))
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    await expect(
      syncEvidence({
        baseUrl: 'https://hub.example.test',
        token: 'session',
        fetch: syncFetch(writes, { capability: false }),
        registeredProjects: registered,
      }),
    ).rejects.toThrow('does not advertise target-space interval evidence support')
    expect(writes).toEqual([])
  })

  test('refuses a server without interval record id support before any write', async () => {
    insertInterval(interval('1', 'one'))
    const writes: Array<{
      method: string
      recordSpace: string | null
      body: Record<string, unknown>
    }> = []
    await expect(
      syncEvidence({
        baseUrl: 'https://hub.example.test',
        token: 'session',
        fetch: syncFetch(writes, { intervalRecordId: false }),
        registeredProjects: registered,
      }),
    ).rejects.toThrow('does not advertise interval record id support')
    expect(writes).toEqual([])
  })

  test('an HTML success response does not advance the evidence ledger', async () => {
    writeTransaction((conn) => {
      conn
        .query(`INSERT INTO day(record_id,day,collected_at) VALUES (?,?,?)`)
        .run('33333333-3333-4333-8333-333333333333', '2026-09-24', '2026-09-24T12:00:00.000Z')
    })

    await expect(
      syncEvidence({
        baseUrl: 'https://user:password@hub.example.test?token=query-secret',
        token: 'session',
        fetch: async () =>
          new Response('<html>app</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      }),
    ).rejects.toThrow('hosted hub refused the response from https://hub.example.test/')
    expect(db().query('SELECT * FROM record_ledger').all()).toEqual([])
  })
})

describe('evidence API', () => {
  test('DELETE by id calls the id remover and DELETE by tuple calls the key remover', async () => {
    const ids: string[] = []
    const keys: unknown[] = []
    const idResponse = await evidenceApi(
      new Request('https://hub.example.test/v1/evidence/intervals', {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer fixture',
          'content-type': 'application/json',
          'x-record-space': 'space-active',
        },
        body: JSON.stringify({ ids: ['interval-id'] }),
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://record' },
      {
        fetch: async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-active',
            memberships: [{ space_id: 'space-active', slug: 'active' }],
          }),
        removeIntervals: async (_url, _tenant, values) => {
          ids.push(...values)
          return { deleted: values.length }
        },
      },
    )
    expect(idResponse?.status).toBe(200)
    expect(ids).toEqual(['interval-id'])

    const keyResponse = await evidenceApi(
      new Request('https://hub.example.test/v1/evidence/intervals', {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer fixture',
          'content-type': 'application/json',
          'x-record-space': 'space-active',
        },
        body: JSON.stringify({
          keys: [{ source: 'orch', ref: 'orch:1', start_at: '2026-10-08T00:00:00.000Z' }],
        }),
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://record' },
      {
        fetch: async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-active',
            memberships: [{ space_id: 'space-active', slug: 'active' }],
          }),
        removeIntervalKeys: async (_url, _tenant, values) => {
          keys.push(...values)
          return { deleted: values.length }
        },
      },
    )
    expect(keyResponse?.status).toBe(200)
    expect(keys).toEqual([{ source: 'orch', ref: 'orch:1', start_at: '2026-10-08T00:00:00.000Z' }])
  })

  test('a non-member interval target returns 403 before the write service', async () => {
    let wrote = false
    const response = await evidenceApi(
      new Request('https://hub.example.test/v1/evidence/intervals', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer fixture',
          'content-type': 'application/json',
          'x-record-space': 'space-other',
        },
        body: JSON.stringify({ targetSpaceId: 'space-active', rows: [] }),
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://record' },
      {
        fetch: async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-active',
            memberships: [{ space_id: 'space-active', slug: 'active' }],
          }),
        putIntervals: async () => {
          wrote = true
          return { upserted: 0, rekeyed: 0 }
        },
      },
    )
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({
      error: "record space 'space-other' is not among the caller's memberships",
      remedy: 'Run `orch record space list` and choose a space where the caller is a member.',
    })
    expect(wrote).toBe(false)
  })

  test('the days route ignores a requested record space and stays in the active space', async () => {
    let boundSpace = ''
    const response = await evidenceApi(
      new Request('https://hub.example.test/v1/evidence/days', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer fixture',
          'content-type': 'application/json',
          'x-record-space': 'not-a-member',
        },
        body: JSON.stringify({ rows: [] }),
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://record' },
      {
        fetch: async () =>
          Response.json({
            user: { id: 'user-1' },
            activeSpaceId: 'space-active',
            memberships: [{ space_id: 'space-active', slug: 'active' }],
          }),
        putDays: async (_url, tenant) => {
          boundSpace = tenant.spaceId
          return { upserted: 0, rekeyed: 0 }
        },
      },
    )

    expect(response?.status).toBe(200)
    expect(boundSpace).toBe('space-active')
  })

  test('refuses a route without authorization before touching identity or storage', async () => {
    let fetched = false
    const response = await evidenceApi(
      new Request('https://hub.example.test/v1/evidence/intervals', { method: 'PUT' }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://record' },
      {
        fetch: async () => {
          fetched = true
          return Response.json({})
        },
      },
    )
    expect(response?.status).toBe(401)
    expect(fetched).toBe(false)
  })

  test('refuses real hosted clients under the test preload', async () => {
    await expect(
      evidenceApi(
        new Request('https://hub.example.test/v1/evidence/intervals', {
          method: 'PUT',
          headers: { authorization: 'Bearer fixture' },
        }),
        { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://record' },
      ),
    ).rejects.toThrow('refuses real identity and database clients')
    await expect(
      syncEvidence({ baseUrl: 'https://hub.example.test', token: 'fixture' }),
    ).rejects.toThrow('refuses a real hosted URL')

    const hostedUrl = process.env.HUB_HOSTED_URL
    process.env.HUB_HOSTED_URL = 'https://hub-from-environment.example.test'
    try {
      await expect(syncEvidence({ token: 'fixture' })).rejects.toThrow('refuses a real hosted URL')
    } finally {
      if (hostedUrl === undefined) delete process.env.HUB_HOSTED_URL
      else process.env.HUB_HOSTED_URL = hostedUrl
    }
  })
})
