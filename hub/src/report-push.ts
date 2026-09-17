import { hostname } from 'node:os'
import { newRecordId } from '../../shared/record/schema.ts'
import { db, writeTransaction } from './db.ts'
import { cacheHostedReportSetting } from './report-cache.ts'
import {
  hostedGetReportSetting,
  hostedMirrorReports,
  hostedReportCounts,
  type ReportClientOptions,
} from './report-client.ts'
import type { Report } from './settings.ts'

export async function pushReports(options: ReportClientOptions & { dryRun?: boolean } = {}) {
  const settingRow = db()
    .query<{ value: string }, []>("SELECT value FROM setting WHERE key='report'")
    .get()
  const setting = settingRow
    ? { value: JSON.parse(settingRow.value) as Report, version: 1 }
    : undefined
  const sends = db()
    .query<Record<string, unknown>, []>('SELECT * FROM send ORDER BY id')
    .all()
    .map((row) => ({
      id: (row.record_id as string | null) ?? newRecordId(),
      legacy_local_id: row.id as number,
      at: row.at as string,
      window: row.window as string,
      recipients: row.recipients as string,
      projects: row.projects as string,
      items: row.items as number,
      status: row.status as 'sent' | 'skipped' | 'failed',
      error: row.error as string | null,
      test: row.test as number,
      created_at: row.at as string,
      machine: hostname(),
    }))
  const local = { setting: setting ? 1 : 0, sends: sends.length }
  if (options.dryRun) return { local, hosted: null, match: null }
  const requestOptions = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  if (setting) await hostedMirrorReports({ setting, sends: [] }, requestOptions)
  for (let index = 0; index < sends.length; index += 500)
    await hostedMirrorReports({ sends: sends.slice(index, index + 500) }, requestOptions)
  const hosted = await hostedReportCounts(requestOptions)
  if (setting) {
    const current = await hostedGetReportSetting(requestOptions)
    if (!current) throw new Error('hosted report setting is missing after mirror')
    writeTransaction((conn) => cacheHostedReportSetting(conn, current))
  }
  return { local, hosted, match: JSON.stringify(local) === JSON.stringify(hosted) }
}
