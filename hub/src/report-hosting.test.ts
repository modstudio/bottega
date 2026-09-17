import { beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db } from './db.ts'
import {
  assertReportPasswordReference,
  assertReportVersion,
  type HostedReportSetting,
} from './hosted-reports.ts'
import { type Item, recordOutcomeAfterEmail } from './report.ts'
import { pullHostedReports } from './report-cache.ts'
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

  test('an unreachable hosted hub makes hub send exit before the mail transport', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'hub-report-offline-'))
    const marker = join(scratch, 'curl-called')
    const fakeCurl = join(scratch, 'curl')
    writeFileSync(fakeCurl, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`)
    chmodSync(fakeCurl, 0o755)
    try {
      const run = Bun.spawnSync([process.execPath, 'src/cli.ts', 'send', '--test'], {
        cwd: join(import.meta.dir, '..'),
        env: {
          ...process.env,
          HUB_DB: process.env.HUB_DB!,
          HUB_HOSTED_URL: 'https://unreachable.example.test',
          NODE_ENV: 'test',
          PATH: `${scratch}:${process.env.PATH}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(run.exitCode).not.toBe(0)
      expect(existsSync(marker)).toBeFalse()
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
