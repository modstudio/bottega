import { db, type Project } from './db.ts'
import { projectNames } from './projects.ts'

/**
 * What the settings view writes, and `hub send` reads.
 *
 * **No secret is ever stored here.** The SMTP password lives in the login
 * keychain and the MCP tokens in `~/.claude/.env`; this holds a REFERENCE and
 * the UI reports only whether it resolves. A settings table that can be read by
 * anything holding the database is not a place for a credential — and hub.db is
 * read by the dashboard, which serves whatever it is given.
 */
export type Report = {
  enabled: boolean
  to: string[]
  fromName: string
  fromAddress: string
  subjectPrefix: string
  smtpHost: string
  smtpPort: number
  smtpUser: string
  /** `keychain:<service>` or `env:<NAME>`. Never the secret itself. */
  smtpPasswordRef: string
  /** Hours the report covers. */
  windowHours: number
  /**
   * Below this much engaged time, the report is not sent.
   *
   * Measured on engaged time rather than conversation time: work-report's guard
   * counted only Claude's own message gaps, so a day of heavy delegation or of
   * tracker and commit work could fall under the bar and silently skip.
   */
  minMinutes: number
  /**
   * Which projects the EMAIL covers. The dashboard is always all five; the
   * report is a subset, and that difference is the reason this is a setting
   * rather than a constant.
   */
  projects: Project[]
  /**
   * Per-initiative context for the summariser, and work to leave out.
   *
   * `match` is case-insensitive substrings tested against a task's key and
   * title. `brief` is stakes the summariser cannot infer from a title - that a
   * migration exists because the framework is end-of-life, say. `exclude` drops
   * matched work from the report entirely, which is how internal review work
   * stays out of a stakeholder's inbox without stopping being measured.
   */
  briefs: Brief[]
  /**
   * Where a TEST send goes.
   *
   * Its own field so the real recipient list can stay set to whoever should get
   * the daily report while it is being changed. Editing `to` down to one address
   * to try something, and remembering to put it back, is how a colleague stops
   * receiving a report nobody notices has stopped.
   */
  testTo: string
}

export type Brief = {
  name: string
  match: string[]
  brief?: string
  exclude?: boolean
}

const DEFAULTS: Report = {
  enabled: false,
  to: [],
  fromName: 'Daily Work Report',
  fromAddress: '',
  subjectPrefix: 'Daily Work Report',
  smtpHost: 'smtp.gmail.com',
  smtpPort: 587,
  smtpUser: '',
  smtpPasswordRef: 'keychain:work-report-smtp',
  windowHours: 24,
  minMinutes: 15,
  projects: projectNames(),
  briefs: [],
  testTo: '',
}

export function getReport(): Report {
  const row = db().query<{ value: string }, []>(
    `SELECT value FROM setting WHERE key = 'report'`,
  ).get()
  if (!row) return { ...DEFAULTS }
  try { return { ...DEFAULTS, ...(JSON.parse(row.value) as Partial<Report>) } }
  catch { return { ...DEFAULTS } }
}

export function setReport(patch: Partial<Report>): Report {
  const next = { ...getReport(), ...patch }
  // Never let a secret in, whatever the caller sends. The field holds a
  // reference by design, and accepting one that is not one would put a
  // credential in a table the dashboard serves from.
  if (next.smtpPasswordRef && !/^(keychain|env):/.test(next.smtpPasswordRef)) {
    throw new Error('smtpPasswordRef must be "keychain:<service>" or "env:<NAME>", never a password')
  }
  const registered = new Set(projectNames())
  next.projects = next.projects.filter((project) => registered.has(project))
  next.to = next.to.map((s) => s.trim()).filter(Boolean)
  next.briefs = (next.briefs ?? []).filter((b) => b && b.name && b.match?.length)
  db().query(`INSERT INTO setting (key, value) VALUES ('report', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next))
  return next
}

/** Resolve the SMTP password at USE time, never at import and never into a log. */
export function smtpPassword(ref: string): string | null {
  const [kind, ...rest] = ref.split(':')
  const name = rest.join(':')
  if (kind === 'env') return process.env[name] || null
  if (kind === 'keychain') {
    const p = Bun.spawnSync(['security', 'find-generic-password', '-s', name, '-w'],
      { stdout: 'pipe', stderr: 'ignore' })
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
