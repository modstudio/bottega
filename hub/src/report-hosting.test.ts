import { beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import {
  assertReportPasswordReference,
  assertReportVersion,
  type HostedReportSetting,
  type HostedSend,
} from './hosted-reports.ts'
import { type Item, lastSends, recordOutcomeAfterEmail, recordSend } from './report.ts'
import { pullHostedReports, refreshHostedReportSetting } from './report-cache.ts'
import type { Report } from './settings.ts'

beforeAll(resetFixtureStore)

const report: Report = {
  enabled: true,
  to: ['person@example.test'],
  fromName: 'Report',
  fromAddress: 'sender@example.test',
  subjectPrefix: 'Daily',
  smtpHost: 'smtp.example.test',
  smtpPort: 587,
  smtpUser: 'sender',
  smtpPasswordRef: 'env:SMTP_PASSWORD',
  windowHours: 24,
  minMinutes: 0,
  projects: ['workshop'],
  briefs: [],
  testTo: 'test@example.test',
}

describe('hosted report setting and send safety', () => {
  test('a stale setting version is refused', () => {
    expect(() => assertReportVersion(4, 3)).toThrow('stale report setting version')
    expect(assertReportVersion(4, 4)).toBe(5)
  })

  test('a literal SMTP password is refused by the hosted service', () => {
    expect(() => assertReportPasswordReference({ smtpPasswordRef: 'literal-secret' })).toThrow(
      'never a password',
    )
  })

  test('the cache pull updates the report setting', async () => {
    const setting: HostedReportSetting = {
      value: { ...report, subjectPrefix: 'Hosted value' },
      version: 7,
      updated_at: '2026-09-17T15:00:00.000Z',
    }
    await pullHostedReports({
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (input) => {
        const path = new URL(input).pathname
        if (path === '/v1/report-setting') return Response.json(setting)
        return Response.json({ sends: [], cursor: '1970-01-01T00:00:00.000Z' })
      },
    })
    const cached = db()
      .query<{ value: string }, []>("SELECT value FROM setting WHERE key='report'")
      .get()
    expect((JSON.parse(cached!.value) as Report).subjectPrefix).toBe('Hosted value')
  })

  test('a missing setting clears the cache and the pull still applies sends', async () => {
    writeTransaction((conn) => {
      conn
        .query("INSERT OR REPLACE INTO setting(key,value) VALUES ('report', ?)")
        .run(JSON.stringify(report))
      conn
        .query(
          "INSERT OR REPLACE INTO setting(key,value) VALUES ('collect.hosted-report.version','7')",
        )
        .run()
    })
    const send: HostedSend = {
      id: '01994d99-7c00-7000-8000-000000000001',
      legacy_local_id: null,
      at: '2026-09-17T16:00:00.000Z',
      window: '24h',
      recipients: '',
      projects: 'workshop',
      items: 0,
      status: 'skipped',
      error: 'disabled',
      test: 0,
      created_at: '2026-09-17T16:00:00.000Z',
      machine: 'test-host',
    }

    const result = await pullHostedReports({
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (input) => {
        if (new URL(input).pathname === '/v1/report-setting')
          return Response.json({ error: 'report setting not found' }, { status: 404 })
        return Response.json({ sends: [send], cursor: send.created_at })
      },
    })

    expect(result).toEqual({ setting: 0, sends: 1, cursor: send.created_at })
    expect(
      db()
        .query("SELECT value FROM setting WHERE key IN ('report','collect.hosted-report.version')")
        .all(),
    ).toHaveLength(0)
    expect(db().query('SELECT id FROM send WHERE record_id=?').get(send.id)).not.toBeNull()
  })

  test('a missing setting makes send use disabled defaults and record the skip', async () => {
    const appended: HostedSend = {
      id: '01994d99-7c00-7000-8000-000000000002',
      legacy_local_id: null,
      at: '2026-09-17T17:00:00.000Z',
      window: '24h',
      recipients: '',
      projects: 'alpha, beta, gamma, delta, workshop, nested',
      items: 0,
      status: 'skipped',
      error: 'disabled',
      test: 0,
      created_at: '2026-09-17T17:00:00.000Z',
      machine: 'test-host',
    }
    const client = {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (input: string, init?: RequestInit) => {
        const path = new URL(input).pathname
        if (path === '/v1/report-setting')
          return Response.json({ error: 'report setting not found' }, { status: 404 })
        if (path === '/v1/sends' && init?.method === 'POST') return Response.json(appended)
        return Response.json({ error: 'unexpected request' }, { status: 500 })
      },
    }
    const defaults = await refreshHostedReportSetting(client)
    expect(defaults.enabled).toBeFalse()
    expect(defaults.projects).toEqual(['alpha', 'beta', 'gamma', 'delta', 'workshop', 'nested'])
    const gathered = {
      hours: defaults.windowHours,
      from: '2026-09-16T17:00:00.000Z',
      to: '2026-09-17T17:00:00.000Z',
      items: [],
      projects: [],
      taskMs: 0,
      engagedMs: 0,
    }
    await recordSend(gathered, defaults, 'skipped', 'disabled', { client })
    expect(lastSends(1)[0]).toMatchObject({ status: 'skipped', error: 'disabled' })
  })

  test('a non-404 setting failure is refused before the mail transport', async () => {
    let mailTransportCalls = 0
    await expect(
      refreshHostedReportSetting({
        baseUrl: 'https://hub.example.test',
        token: 'test',
        fetch: async () => Response.json({ error: 'unavailable' }, { status: 503 }),
      }).then(() => {
        mailTransportCalls++
      }),
    ).rejects.toThrow('503')
    expect(mailTransportCalls).toBe(0)
  })

  test('a record failure after delivery reports the unrecorded outcome', async () => {
    const gathered = {
      hours: 24,
      from: '2026-09-16T15:00:00.000Z',
      to: '2026-09-17T15:00:00.000Z',
      items: [{ key: 'DEV-678' } as Item],
      projects: [],
      taskMs: 0,
      engagedMs: 0,
    }
    const errors: string[] = []
    const old = console.error
    console.error = (...values) => errors.push(values.join(' '))
    try {
      await expect(
        recordOutcomeAfterEmail(gathered, report, { ok: true }, report.to, {
          client: {
            baseUrl: 'https://hub.example.test',
            token: 'test',
            fetch: async () => new Response('no', { status: 503 }),
          },
        }),
      ).rejects.toThrow('503')
    } finally {
      console.error = old
    }
    expect(errors.join('\n')).toContain('email outcome was not recorded')
    expect(errors.join('\n')).toContain('"status":"sent"')
    expect(errors.join('\n')).toContain('"recipients":1')
    expect(errors.join('\n')).toContain('"items":1')
  })
})
