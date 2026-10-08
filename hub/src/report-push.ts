import { hostname } from 'node:os'
import { db } from './db.ts'
import {
  hostedMirrorReports,
  hostedReportCounts,
  type ReportClientOptions,
} from './report-client.ts'

export async function pushReports(options: ReportClientOptions & { dryRun?: boolean } = {}) {
  const sends = db()
    .query<Record<string, unknown>, []>('SELECT * FROM send ORDER BY id')
    .all()
    .map((row) => ({
      id: requiredSendRecordId(row),
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
  const local = { sends: sends.length }
  if (options.dryRun) return { local, hosted: null, match: null }
  const requestOptions = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  for (let index = 0; index < sends.length; index += 500)
    await hostedMirrorReports({ sends: sends.slice(index, index + 500) }, requestOptions)
  const hosted = await hostedReportCounts(requestOptions)
  return { local, hosted, match: JSON.stringify(local) === JSON.stringify(hosted) }
}

function requiredSendRecordId(row: Record<string, unknown>) {
  if (typeof row.record_id === 'string' && row.record_id) return row.record_id
  throw new Error(
    `send local row ${String(row.id)} has no record id; migrate the Hub store before pushing`,
  )
}
