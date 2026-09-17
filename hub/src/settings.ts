import { db, writeTransaction } from './db.ts'
import { projectNames } from './projects.ts'
import { cachedReportVersion, cacheHostedReportSetting } from './report-cache.ts'
import { hostedPutReportSetting, type ReportClientOptions } from './report-client.ts'
import { type Report, reportDefaults } from './report-types.ts'

export type { Brief, Report } from './report-types.ts'

/**
 * What the settings view writes, and `hub send` reads.
 *
 * **No secret is ever stored here.** The SMTP password lives in the login
 * keychain and the MCP tokens in `~/.claude/.env`; this holds a REFERENCE and
 * the UI reports only whether it resolves. A settings table that can be read by
 * anything holding the database is not a place for a credential — and hub.db is
 * read by the dashboard, which serves whatever it is given.
 */
export function getReport(): Report {
  const defaults = reportDefaults(projectNames())
  const row = db()
    .query<{ value: string }, []>(`SELECT value FROM setting WHERE key = 'report'`)
    .get()
  if (!row) return defaults
  try {
    return { ...defaults, ...(JSON.parse(row.value) as Partial<Report>) }
  } catch {
    return defaults
  }
}

export async function setReport(
  patch: Partial<Report>,
  options: ReportClientOptions = {},
): Promise<Report> {
  const next = { ...getReport(), ...patch }
  // Never let a secret in, whatever the caller sends. The field holds a
  // reference by design, and accepting one that is not one would put a
  // credential in a table the dashboard serves from.
  if (next.smtpPasswordRef && !/^(keychain|env):/.test(next.smtpPasswordRef)) {
    throw new Error(
      'smtpPasswordRef must be "keychain:<service>" or "env:<NAME>", never a password',
    )
  }
  next.to = next.to.map((s) => s.trim()).filter(Boolean)
  next.briefs = (next.briefs ?? []).filter((b) => b?.name && b.match?.length)
  const hosted = await hostedPutReportSetting(
    { value: next, version: cachedReportVersion() },
    options,
  )
  writeTransaction((conn) => cacheHostedReportSetting(conn, hosted))
  return hosted.value
}

/** Resolve the SMTP password at USE time, never at import and never into a log. */
export function smtpPassword(ref: string): string | null {
  const [kind, ...rest] = ref.split(':')
  const name = rest.join(':')
  if (kind === 'env') return process.env[name] || null
  if (kind === 'keychain') {
    const p = Bun.spawnSync(['security', 'find-generic-password', '-s', name, '-w'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = new TextDecoder().decode(p.stdout).trim()
    return out || null
  }
  return null
}

/** Whether each secret resolves — the only thing the UI is ever told about them. */
export function secretStatus(r: Report) {
  return {
    smtpPassword: { ref: r.smtpPasswordRef, resolves: !!smtpPassword(r.smtpPasswordRef) },
  }
}
