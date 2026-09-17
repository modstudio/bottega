import type { Database } from 'bun:sqlite'
import { db, writeTransaction } from './db.ts'
import type { HostedReportSetting, HostedSend } from './hosted-reports.ts'
import {
  hostedGetReportSetting,
  hostedSendChanges,
  type ReportClientOptions,
} from './report-client.ts'

const SETTING_VERSION_KEY = 'collect.hosted-report.version'
const SEND_CURSOR_KEY = 'collect.hosted-sends.cursor'

export function cacheHostedReportSetting(conn: Database, setting: HostedReportSetting) {
  conn
    .query(`INSERT INTO setting(key,value) VALUES ('report',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(JSON.stringify(setting.value))
  conn
    .query(`INSERT INTO setting(key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(SETTING_VERSION_KEY, String(setting.version))
}

export function cachedReportVersion() {
  const value = db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
    .get(SETTING_VERSION_KEY)?.value
  return value && Number.isInteger(Number(value)) ? Number(value) : 0
}

export function cacheHostedSend(conn: Database, row: HostedSend) {
  const existing = conn
    .query<{ id: number }, [string]>('SELECT id FROM send WHERE record_id=?')
    .get(row.id)
  if (existing) {
    conn
      .query(`UPDATE send SET at=?,window=?,recipients=?,projects=?,items=?,status=?,error=?,test=?
      WHERE id=?`)
      .run(
        row.at,
        row.window,
        row.recipients,
        row.projects,
        row.items,
        row.status,
        row.error,
        row.test,
        existing.id,
      )
    return
  }
  if (row.legacy_local_id) {
    const legacy = conn
      .query<{ id: number }, [number]>('SELECT id FROM send WHERE id=?')
      .get(row.legacy_local_id)
    if (legacy) {
      conn.query('UPDATE send SET record_id=? WHERE id=?').run(row.id, legacy.id)
      return
    }
  }
  conn
    .query(`INSERT INTO send(record_id,at,window,recipients,projects,items,status,error,test)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      row.id,
      row.at,
      row.window,
      row.recipients,
      row.projects,
      row.items,
      row.status,
      row.error,
      row.test,
    )
}

export async function refreshHostedReportSetting(options: ReportClientOptions = {}) {
  const setting = await hostedGetReportSetting(options)
  writeTransaction((conn) => cacheHostedReportSetting(conn, setting))
  return setting.value
}

export async function pullHostedReports(options: ReportClientOptions = {}) {
  const cursor =
    db()
      .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
      .get(SEND_CURSOR_KEY)?.value ?? null
  const [setting, changes] = await Promise.all([
    hostedGetReportSetting(options),
    hostedSendChanges(cursor, options),
  ])
  writeTransaction((conn) => {
    cacheHostedReportSetting(conn, setting)
    changes.sends.forEach((row) => {
      cacheHostedSend(conn, row)
    })
    conn
      .query(`INSERT INTO setting(key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(SEND_CURSOR_KEY, changes.cursor)
  })
  return { setting: 1, sends: changes.sends.length, cursor: changes.cursor }
}
