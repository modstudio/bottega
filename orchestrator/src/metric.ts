import { readdirSync, statSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { clock } from './clock.ts'
import { db, nowIso, writableDb } from './db.ts'
import { projects, projectAt } from './projects.ts'

const targetGitEnvironment = (repo: string) =>
  (require('./git-environment.ts') as typeof import('./git-environment.ts')).targetGitEnvironment(repo)

const PROJECTS = `${process.env.HOME}/.claude/projects`
/**
 * Where numbered clones live, for the ONE thing the register cannot answer.
 *
 * The other machine checks out numbered clones such as `application-0`, and those
 * are the same repos — missing that counted 26B tokens of canon work as
 * untracked, 65% of the window. A numbered clone is not a registered project
 * and never will be, so its name still has to be recovered from the path.
 *
 * Everything else about a project now comes from the register. This is a
 * fallback for paths that resolve to no project, not a source of truth.
 */
const CLONE_ROOT = process.env.ORCH_CLONE_ROOT ?? `${process.env.HOME}/Projects`
/**
 * Which repos count toward the canon denominator — ASKED, not listed.
 *
 * This was an array literal naming four repositories, which is a fact about one
 * person's work written into the tool. It is read from the register now, so
 * somebody else's projects are theirs to declare rather than something to fork
 * this file over.
 *
 * Read per call rather than cached at module load: `orch project add` can
 * change the answer inside a long-lived process, and a cached list would keep
 * reporting a newly-registered project's spend as untracked.
 */
const canonRepos = (): string[] => projects().filter((p) => p.canon).map((p) => p.name)

function keyPattern(prefixes: string[] | undefined): RegExp | null {
  if (!prefixes?.length) return null
  const alternatives = prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\b(?:${alternatives.join('|')})-\\d+`, 'g')
}

/** The metric's calendar day in this machine's local timezone. */
export function metricCalendarDay(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const localDay = metricCalendarDay

function metricDayStart(days: number, now: number): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - days)
  return d
}

const metricDaysAgo = (days: number, now: number): string =>
  metricCalendarDay(metricDayStart(days, now))

/** Every .jsonl transcript under ~/.claude/projects. */
function transcripts(dir: string, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) transcripts(p, out)
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

/**
 * Claude token spend per day, read from the transcripts themselves rather than
 * stats-cache.json — the transcripts carry a timestamp per message, so a day can
 * be recomputed without trusting a rollup.
 */
/**
 * Which canon repo a message was working in, or null for anything else.
 *
 * Read from the entry's own `cwd` rather than the transcript's directory name:
 * a session started from ~/Projects carries a folder name that says nothing
 * about what it touched, and one session moved between two projects inside a
 * single file.
 */
export function repoOfCwd(cwd: string | undefined): string | null {
  if (!cwd) return null
  // The register first: it knows where each project actually is, including
  // ones that live nowhere near a common root.
  const p = projectAt(cwd)
  if (p) return p.canon ? p.name : null

  // Then the numbered-clone fallback, which is the case the register cannot
  // cover: `application-0` is a real directory that is not a registered project
  // and is the same repository. Missing this counted 26B tokens of canon work
  // as untracked — 65% of the window — because most of the estate's
  // transcripts come from numbered checkouts.
  if (!cwd.startsWith(CLONE_ROOT + '/')) return null
  const seg = cwd.slice(CLONE_ROOT.length + 1).split('/')[0]!.replace(/-\d+$/, '')
  return canonRepos().includes(seg) ? seg : null
}

async function claudeTokensByDay(since: string) {
  const days = new Map<string, {
    tokens: number; cacheRead: number; messages: number
    canon: number; other: number
  }>()
  for (const file of transcripts(PROJECTS)) {
    // Skip files untouched since the window opened — the cheap 90% of the work.
    try { if (metricCalendarDay(statSync(file).mtime) < since) continue } catch { continue }
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.includes('"cache_read_input_tokens"')) continue
      let d: any
      try { d = JSON.parse(line) } catch { continue }
      const day = d.timestamp ? metricCalendarDay(d.timestamp) : ''
      if (!day || day < since) continue
      const u = d.message?.usage
      if (!u) continue
      const row = days.get(day) ?? { tokens: 0, cacheRead: 0, messages: 0, canon: 0, other: 0 }
      const cr = u.cache_read_input_tokens ?? 0
      row.cacheRead += cr
      const spend = cr + (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
      row.tokens += spend
      // Work outside the canon repos ships no task key, so counting it in the
      // numerator inflates the ratio against a denominator it never touched.
      // This project is the case in point: a day building the orchestrator
      // spends heavily and commits nothing the denominator can see.
      if (repoOfCwd(d.cwd)) row.canon += spend
      else row.other += spend
      row.messages += 1
      days.set(day, row)
    }
  }
  return days
}

/** Distinct task keys committed per day, as the denominator for shipped work. */
/**
 * Generated files, which are not work.
 *
 * Measured over fourteen days across the four repos, **81.5% of all line churn
 * was generated** - drizzle rewrites a 25-50k line schema snapshot on every
 * migration, so adding one column reads as a 23,000-line day. Left in, the
 * lines lens measures the ORM's verbosity rather than anything anyone did.
 */
export type FileKind = 'generated' | 'test' | 'docs' | 'config' | 'product'

/**
 * What kind of file a change touched.
 *
 * Categorised rather than filtered, because the mix is itself information: a
 * day of docs and config is not a day of product code, and knowing that is
 * worth more than a single number pretending they are the same.
 *
 * Generated output has to be separated whatever else happens. Measured over
 * fourteen days across the four repos it was **81.5% of all line churn** -
 * drizzle rewrites a 25-50k line schema snapshot on every migration, so adding
 * one column reads as a 23,000-line day. Counted, the lens measures the ORM's
 * verbosity rather than anything anyone did.
 *
 * Tests are their own category rather than dropped. They distort a line count
 * badly - one 16,884-line integration test was the largest single file in
 * one project's window - but they are real work, and scoring them at zero would make
 * writing them look free.
 */
const RULES: [FileKind, RegExp][] = [
  ['generated', /drizzle\/(.*snapshot\.json$|meta\/)/],
  ['generated', /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|composer\.lock|pnpm-lock\.yaml)$/],
  ['generated', /\.min\.(js|css)$/],
  ['generated', /(^|\/)(dist|build|vendor|node_modules)\//],
  ['generated', /\.(map|snap|svg|png|jpe?g|gif|ico|woff2?|ttf|pdf|lock)$/],
  ['generated', /(^|\/)__snapshots__\//],
  ['test', /\.(test|spec)\.[jt]sx?$/],
  ['test', /\.integration\.test\./],
  ['test', /(^|\/)__tests__\//],
  ['test', /(^|\/)tests?\//i],
  ['test', /Test\.php$/],
  ['test', /_test\.(go|py|rb)$/],
  ['test', /(^|\/)(cypress|e2e|playwright)\//],
  ['docs', /\.mdx?$/],
  ['docs', /(^|\/)docs?\//i],
  ['config', /\.(ya?ml|toml|ini|conf)$/],
  ['config', /(^|\/)\.[\w.-]+$/],
  ['config', /\.config\.[jt]s$/],
  ['config', /(^|\/)(tsconfig|package)\.json$/],
]

export function categorize(file: string): FileKind {
  for (const [kind, re] of RULES) if (re.test(file)) return kind
  return 'product'
}

export type DayActivity = {
  tasks: Set<string>; commits: number; files: Set<string>
  /** Lines changed per file kind; `product` is the headline denominator. */
  lines: Record<FileKind, number>
}

/**
 * What the canon repos produced each day, by four different measures.
 *
 * No single denominator is trustworthy, so the ratio is reported under several
 * and the interesting signal is whether they agree. Each is wrong in its own
 * direction: tasks miss work carrying no ticket, lines reward verbosity,
 * commits follow habit rather than effort, and files touched says nothing about
 * depth. Generated output is excluded outright and tests are counted apart,
 * because both swamp a line count without reflecting effort in proportion.
 */
function activityByDay(since: string) {
  const days = new Map<string, DayActivity>()
  const get = (d: string) => {
    if (!days.has(d)) days.set(d, {
      tasks: new Set(), commits: 0, files: new Set(),
      lines: { generated: 0, test: 0, docs: 0, config: 0, product: 0 },
    })
    return days.get(d)!
  }
  for (const { name: repo, path, settings } of projects().filter((p) => p.canon)) {
    const key = keyPattern(settings.keyPrefixes)
    const proc = Bun.spawnSync(
      ['git', '-C', path, 'log', '--all', `--since=${since}`,
       '--numstat', '--pretty=format:%x00%cI%x09%H%x09%s'],
      { env: targetGitEnvironment(path), stdout: 'pipe', stderr: 'ignore' },
    )
    let day: string | null = null
    for (const line of new TextDecoder().decode(proc.stdout).split('\n')) {
      if (line.startsWith('\u0000')) {
        const [d, , subject] = line.slice(1).split('\t')
        if (!d) { day = null; continue }
        day = metricCalendarDay(d)
        const row = get(day)
        row.commits++
        for (const k of key ? (subject ?? '').match(key) ?? [] : []) row.tasks.add(`${repo}:${k}`)
        continue
      }
      if (!day) continue
      const [add, del, file] = line.split('\t')
      // "-" is git's marker for a binary file: no line count exists.
      if (add === undefined || add === '-' || !file) continue
      const row = get(day)
      const kind = categorize(file)
      row.lines[kind] += Number(add) + Number(del ?? 0)
      if (kind === 'product') row.files.add(`${repo}:${file}`)
    }
  }
  return days
}


export async function collect(windowDays = 30) {
  writableDb()
  const start = metricDayStart(windowDays, clock().now())
  const since = metricCalendarDay(start)
  const [tok, act] = [await claudeTokensByDay(since), activityByDay(start.toISOString())]
  const d = db()
  const stmt = d.query(
    `INSERT INTO metric (day, claude_tokens, cache_read, messages, tasks,
                         canon_tokens, other_tokens, commits, files,
                         lines_product, lines_test, lines_docs, lines_config, lines_generated,
                         collected_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(day) DO UPDATE SET
       -- Token columns are only overwritten by a collection that FOUND tokens.
       --
       -- Transcripts do not live for ever: Claude Code prunes them, and work
       -- done on the other machine never had any here to begin with. Recollecting
       -- an old day therefore reads fewer transcripts than the first pass did,
       -- and an unconditional overwrite replaced a good measurement with zero.
       -- That is what emptied 2026-08-15, -16, -22, -26 and -29, days carrying
       -- 20 to 113 commits each. Those readings are gone and cannot be rebuilt.
       --
       -- The git-derived columns below have no such problem: history is still
       -- there, so a later pass measures them at least as well as the first.
       claude_tokens=CASE WHEN excluded.claude_tokens > 0
                          THEN excluded.claude_tokens ELSE metric.claude_tokens END,
       cache_read=CASE WHEN excluded.claude_tokens > 0
                       THEN excluded.cache_read ELSE metric.cache_read END,
       messages=CASE WHEN excluded.claude_tokens > 0
                     THEN excluded.messages ELSE metric.messages END,
       canon_tokens=CASE WHEN excluded.claude_tokens > 0
                         THEN excluded.canon_tokens ELSE metric.canon_tokens END,
       other_tokens=CASE WHEN excluded.claude_tokens > 0
                         THEN excluded.other_tokens ELSE metric.other_tokens END,
       tasks=excluded.tasks,
       commits=excluded.commits, files=excluded.files,
       lines_product=excluded.lines_product, lines_test=excluded.lines_test,
       lines_docs=excluded.lines_docs, lines_config=excluded.lines_config,
       lines_generated=excluded.lines_generated, collected_at=excluded.collected_at`,
  )
  const allDays = new Set([...tok.keys(), ...act.keys()])
  for (const day of allDays) {
    const t = tok.get(day) ?? { tokens: 0, cacheRead: 0, messages: 0, canon: 0, other: 0 }
    const a = act.get(day)
    stmt.run(
      day, t.tokens, t.cacheRead, t.messages, a?.tasks.size ?? 0,
      t.canon, t.other, a?.commits ?? 0, a?.files.size ?? 0,
      a?.lines.product ?? 0, a?.lines.test ?? 0, a?.lines.docs ?? 0,
      a?.lines.config ?? 0, a?.lines.generated ?? 0, nowIso(),
    )
  }
  return allDays.size
}

type Row = {
  day: string; claude_tokens: number; cache_read: number; messages: number; tasks: number
  canon_tokens: number; other_tokens: number; commits: number; files: number
  lines_product: number; lines_test: number; lines_docs: number
  lines_config: number; lines_generated: number
}

/**
 * The denominators the ratio is reported against, and what each is blind to.
 *
 * They are listed so the dashboard and the CLI cannot describe them
 * differently, and so a lens can never appear without its caveat attached.
 */
export const LENSES = [
  { key: 'tasks', label: 'per task',
    caveat: 'misses any work that carries no ticket - this project is the example' },
  { key: 'lines_product', label: 'per product line',
    caveat: 'rewards volume; generated files excluded, tests counted separately' },
  { key: 'commits', label: 'per commit',
    caveat: 'follows commit habit rather than effort' },
  { key: 'files', label: 'per file touched',
    caveat: 'says nothing about depth of change' },
] as const

/** Rolling ratio: a single day is too noisy — tasks land in bursts. */
export function summary(windowDays = 14) {
  const now = clock().now()
  const since = metricDaysAgo(windowDays, now)
  const rows = db().query(
    `SELECT day, claude_tokens, cache_read, messages, tasks, canon_tokens, other_tokens,
            commits, files, lines_product, lines_test, lines_docs, lines_config, lines_generated
       FROM metric WHERE day >= ? ORDER BY day`,
  ).all(since) as Row[]

  // Two kinds of day cannot be read as a ratio and are excluded from the trend.
  //
  // TODAY is incomplete. Spend accrues in real time while commits land later,
  // so the current day is always inflated - measured at 13:46 it showed 166M
  // per task against a 64M average, purely because the tasks had not been
  // committed yet. It is still drawn, marked as partial, because hiding today
  // is its own kind of lie.
  //
  // A DAY WITH TASKS BUT ALMOST NO TOKENS is a data gap, not efficiency - work
  // done on the other machine, whose transcripts are not on this one. The test
  // is proportional rather than a literal zero: a day carrying 31k tokens
  // against a 3.2B median is missing its transcripts just as surely as one
  // carrying none, and reading it as 3,939 tokens per task flatters the ratio
  // by three orders of magnitude. Scaled to the window's own median so it
  // needs no tuning as volume changes.
  const GAP_SHARE = 0.05
  const nonZero = rows.map((r) => r.canon_tokens).filter((t) => t > 0).sort((a, b) => a - b)
  const medianDay = nonZero.length ? nonZero[nonZero.length >> 1]! : 0
  const isGap = (r: { tasks: number; canon_tokens: number }) =>
    r.tasks > 0 && medianDay > 0 && r.canon_tokens < medianDay * GAP_SHARE

  const today = metricCalendarDay(now)
  const usable = rows.filter((r) => r.day !== today && !isGap(r))
  const excluded = rows.length - usable.length

  // The headline totals are taken over the SAME days as the four lenses.
  //
  // Summing over every row would count an excluded day's tasks against its
  // missing tokens, recreating the exact deflation isGap() prevents in the one
  // number most people read.
  const tokens = usable.reduce((a, r) => a + r.claude_tokens, 0)
  const canonTokens = usable.reduce((a, r) => a + r.canon_tokens, 0)
  const otherTokens = usable.reduce((a, r) => a + r.other_tokens, 0)
  const tasks = usable.reduce((a, r) => a + r.tasks, 0)
  const messages = usable.reduce((a, r) => a + r.messages, 0)

  // Direction, by halves rather than by the last two days.
  //
  // Tasks land in bursts - a day with four commits and near-zero spend sits
  // next to one with the reverse - so consecutive days say nothing. Each half
  // is totalled and divided once, not averaged over daily ratios, because a
  // quiet day with one task would otherwise weigh as much as a busy one with
  // thirty.
  //
  // Lower is better, so a fall is `improving`. Below MIN_TASKS in either half
  // the answer is `unknown` and says so: with few tasks the denominator moves
  // more than the thing being measured.
  const MIN_TASKS = 5
  const midpoint = metricDaysAgo(Math.floor(windowDays / 2), now)
  const half = (rs: typeof rows) => {
    const t = rs.reduce((a, r) => a + r.canon_tokens, 0)
    const k = rs.reduce((a, r) => a + r.tasks, 0)
    return { tokens: t, tasks: k, perTask: k > 0 ? Math.round(t / k) : null }
  }
  const earlier = half(usable.filter((r) => r.day < midpoint))
  const recent = half(usable.filter((r) => r.day >= midpoint))

  let direction: 'improving' | 'worsening' | 'flat' | 'unknown' = 'unknown'
  let changePct: number | null = null
  if (earlier.perTask && recent.perTask &&
      earlier.tasks >= MIN_TASKS && recent.tasks >= MIN_TASKS) {
    changePct = ((recent.perTask - earlier.perTask) / earlier.perTask) * 100
    // Under 10% is inside the noise these bursts generate; calling it a trend
    // would be reading a direction into scheduling.
    direction = Math.abs(changePct) < 10 ? 'flat' : changePct < 0 ? 'improving' : 'worsening'
  }

  // Every lens uses canon spend as its numerator, because every denominator
  // counts only canon work. Spend elsewhere is reported on its own rather than
  // divided by a denominator it never contributed to.
  const lenses = LENSES.map((l) => {
    const denom = usable.reduce((a, r) => a + (r[l.key] as number), 0)
    return { ...l, denom, perUnit: denom > 0 ? Math.round(canonTokens / denom) : null }
  })
  const mix = (['product', 'test', 'docs', 'config', 'generated'] as const).map((k) => ({
    kind: k, lines: rows.reduce((a, r) => a + (r['lines_' + k as keyof Row] as number), 0),
  }))

  return {
    days: rows.length, tokens, tasks, messages,
    canonTokens, otherTokens,
    untrackedShare: tokens > 0 ? otherTokens / (canonTokens + otherTokens) : 0,
    lenses, mix,
    perTask: tasks > 0 ? Math.round(canonTokens / tasks) : null,
    perMessage: messages > 0 ? Math.round(tokens / messages) : null,
    earlier, recent, direction, changePct, excluded,
    // Flagged rather than dropped: the chart shows every day, and says which
    // ones the trend could not use.
    series: rows.map((r) => ({
      ...r,
      partial: r.day === today,
      gap: isGap(r),
    })),
  }
}
