import type { Database } from 'bun:sqlite'
import { engagedMs } from '../../shared/interval.ts'
import { db, STALE_AFTER_MS } from './db.ts'
import { targetGitEnvironment } from './git-environment.ts'

const HUB = new URL('../../bin/hub', import.meta.url).pathname

export type EpicChild = { key: string; title?: string; status?: string | null }
export type NotRecorded = { metric: string; needed: string }
export type EpicTaskScore = {
  key: string
  title: string
  status: string | null
  runs: { total: number; byJob: Record<string, number> }
  agentTimeMs: number
  occupancyMs: number
  elapsedSpanMs: number
  runDurationMeanMs: number | null
  runDurationP95Ms: number | null
  ghostRuns: number
  vendorTokens: number | null
  vendorCostUsd: number | null
  unreportedUsageRuns: { tokens: number; cost: number }
  lensRounds: number
  fixRounds: number
  landings: { attempted: number; landed: number; refused: number; refusedByCause: Record<string, number> }
  reviews: { recorded: number; completed: number; outdated: number }
  strandings: { count: number; reasons: { landingId: number; kind: 'strand-live' | 'unreviewed'; reason: string }[] }
  idleMinutes: number
  continuations: { count: number; branchDrift: number }
  architectCommits: number | null
}
export type EpicScoreboard = {
  epicKey: string
  membership: {
    source: string
    runEvidence: string
    landingEvidence: string
    reviewEvidence: string
    unmatchedEvidence: string
  }
  children: EpicTaskScore[]
  total: EpicTaskScore
  notRecorded: NotRecorded[]
}

type RunRow = {
  id: number; started_at: string; job: string; status: string; failure_kind: string | null
  latency_ms: number | null
  vendor_tokens: number | null; vendor_cost_usd: number | null
  launch_key: string | null; branch: string | null; parent_run_id: number | null
  turn: number; last_event_at: string | null
  project_id: number | null; head_commit: string | null
}
type LandingRow = {
  id: number; branch: string; status: string; error: string | null; steps: string | null
  project_id: number | null; tip: string | null
}
type LandingStep = {
  name: string
  unreviewed?: string
  strandLive?: string
  message?: string
  keepCheckpoints?: boolean
}

function flagsOf(row: Pick<LandingRow, 'steps'>): {
  unreviewed?: string; strandLive?: string; message?: string; keepCheckpoints?: boolean
} {
  let steps: LandingStep[] = []
  if (row.steps) {
    try {
      const parsed = JSON.parse(row.steps) as unknown
      steps = Array.isArray(parsed) ? parsed as LandingStep[] : []
    } catch { /* malformed historical steps carry no flags */ }
  }
  const flags = steps.find((step) => step.name === '_flags')
  if (!flags) return {}
  return {
    ...(flags.unreviewed ? { unreviewed: flags.unreviewed } : {}),
    ...(flags.strandLive ? { strandLive: flags.strandLive } : {}),
    ...(flags.message ? { message: flags.message } : {}),
    ...(flags.keepCheckpoints ? { keepCheckpoints: true } : {}),
  }
}
type ReviewRow = {
  id: number; completed_at: string | null; outdated_at: string | null; patch_id: string | null
  launch_key: string | null; branch: string | null; head_commit: string | null; project_id: number | null
}

export const keyInBranch = (branch: string | null, keys: readonly string[]): string | null => {
  if (!branch) return null
  return keys.find((key) => new RegExp(`(^|[^A-Z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9]|$)`, 'i').test(branch)) ?? null
}

/** The task named by run attribution: an explicit launch key, then a key in its branch. */
export function attributedTaskKey(launchKey: string | null, branch: string | null): string | null {
  const launch = launchKey?.trim()
  if (launch) return launch.toUpperCase()
  const candidates = [...(branch?.matchAll(/(?:^|[^A-Z0-9])([A-Z][A-Z0-9]*-\d+)(?=[^0-9]|$)/gi) ?? [])]
    .map((match) => match[1]!.toUpperCase())
  return keyInBranch(branch, candidates)
}

/** SQLite stores ISO text without timezone semantics; an absent offset means UTC here. */
const utcMillis = (value: string): number => Date.parse(
  /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`,
)

/**
 * Evidence attribution is deliberately ordered. run.launch_key is authoritative
 * when present; otherwise the task key embedded in run.branch and then its head
 * commit subject are used. Landings use landing.branch and then the tip subject.
 * Reviews inherit the same run attribution through review_lens. Evidence naming
 * a non-child launch key, or no child by any route, is outside this epic rather
 * than being silently assigned to its nearest task.
 */
export function epicScoreboard(
  epicKey: string, children: EpicChild[], database: Database = db(), clock = Date.now(),
): EpicScoreboard {
  const keys = children.map((child) => child.key.toUpperCase())
  const childByKey = new Map(children.map((child) => [child.key.toUpperCase(), child]))
  const runs = database.query(
    `SELECT id,started_at,job,status,failure_kind,latency_ms,vendor_tokens,vendor_cost_usd,launch_key,branch,
            parent_run_id,turn,last_event_at,project_id,head_commit FROM run ORDER BY started_at,id`,
  ).all() as RunRow[]
  const landings = database.query(
    `SELECT id,branch,status,error,steps,project_id,tip FROM landing ORDER BY started_at,id`,
  ).all() as LandingRow[]
  const reviews = database.query(
    `SELECT DISTINCT review.id,review.completed_at,review.outdated_at,review.patch_id,run.launch_key,run.branch,
            run.head_commit,run.project_id
       FROM review JOIN review_lens ON review_lens.review_id=review.id
       JOIN run ON run.id=review_lens.run_id ORDER BY review.id`,
  ).all() as ReviewRow[]
  const subjects = commitSubjects(database)

  const subjectKey = (projectId: number | null, commit: string | null) =>
    keyInBranch(projectId && commit ? subjects.get(projectId)?.get(commit) ?? null : null, keys)

  const runKey = (row: Pick<RunRow, 'launch_key' | 'branch' | 'project_id' | 'head_commit'>): string | null => {
    const launch = row.launch_key?.toUpperCase()
    if (launch) return childByKey.has(launch) ? launch : null
    return keyInBranch(row.branch, keys) ?? subjectKey(row.project_id, row.head_commit)
  }
  const landingKey = (row: LandingRow) =>
    keyInBranch(row.branch, keys) ?? subjectKey(row.project_id, row.tip)
  const reviewKey = (row: ReviewRow) => runKey(row)

  const rows = children.map((child): EpicTaskScore => {
    const key = child.key.toUpperCase()
    const taskRuns = runs.filter((row) => runKey(row) === key)
    const taskLandings = landings.filter((row) => landingKey(row) === key)
    const taskReviews = reviews.filter((row) => reviewKey(row) === key)
    const byJob: Record<string, number> = {}
    for (const run of taskRuns) byJob[run.job] = (byJob[run.job] ?? 0) + 1
    const timing = durationMetrics(taskRuns, clock)
    const tokenRows = taskRuns.filter((run) => run.vendor_tokens !== null)
    const costRows = taskRuns.filter((run) => run.vendor_cost_usd !== null)
    const refused = taskLandings.filter((landing) => landing.status === 'refused')
    const refusedByCause: Record<string, number> = {}
    for (const landing of refused) {
      const cause = landing.error?.split(/\r?\n/, 1)[0]?.trim() || 'not recorded'
      refusedByCause[cause] = (refusedByCause[cause] ?? 0) + 1
    }
    const reasons: EpicTaskScore['strandings']['reasons'] = []
    for (const landing of taskLandings.filter((row) => ['landed', 'install_failed'].includes(row.status))) {
      const flags = flagsOf(landing)
      if (flags.strandLive) reasons.push({ landingId: landing.id, kind: 'strand-live', reason: flags.strandLive })
      if (flags.unreviewed) reasons.push({ landingId: landing.id, kind: 'unreviewed', reason: flags.unreviewed })
    }
    const earlierBranches = new Set<string>()
    let branchDrift = 0
    for (const run of taskRuns) {
      if (run.turn > 1 && run.branch && earlierBranches.size && !earlierBranches.has(run.branch)) branchDrift++
      if (run.branch) earlierBranches.add(run.branch)
    }
    const rootFixRuns = taskRuns.filter((run) => run.job === 'fix' && run.parent_run_id === null)
    return {
      key, title: child.title ?? '', status: child.status ?? null,
      runs: { total: taskRuns.length, byJob: Object.fromEntries(Object.entries(byJob).sort()) },
      ...timing,
      vendorTokens: tokenRows.length ? tokenRows.reduce((sum, run) => sum + run.vendor_tokens!, 0) : null,
      vendorCostUsd: costRows.length ? costRows.reduce((sum, run) => sum + run.vendor_cost_usd!, 0) : null,
      unreportedUsageRuns: { tokens: taskRuns.length - tokenRows.length, cost: taskRuns.length - costRows.length },
      lensRounds: new Set(taskReviews.map((review) =>
        review.patch_id ?? review.head_commit ?? `review:${review.id}`)).size,
      fixRounds: rootFixRuns.length,
      landings: {
        attempted: taskLandings.length,
        landed: taskLandings.filter((landing) => landing.status === 'landed' || landing.status === 'install_failed').length,
        refused: refused.length,
        refusedByCause: Object.fromEntries(Object.entries(refusedByCause).sort()),
      },
      reviews: {
        recorded: taskReviews.length,
        completed: taskReviews.filter((review) => review.completed_at !== null).length,
        outdated: taskReviews.filter((review) => review.outdated_at !== null).length,
      },
      strandings: { count: new Set(reasons.map((reason) => reason.landingId)).size, reasons },
      continuations: { count: taskRuns.filter((run) => run.turn > 1).length, branchDrift },
      architectCommits: null,
    }
  })
  const attributedRuns = runs.filter((row) => runKey(row) !== null)
  const total = totalRow(rows, durationMetrics(attributedRuns, clock))
  return {
    epicKey,
    membership: {
      source: `hub task list --parent ${epicKey} --json`,
      runEvidence: 'run.launch_key, falling back to a child key embedded in run.branch, then the head commit subject',
      landingEvidence: 'a child key embedded in landing.branch, falling back to the landed tip commit subject',
      reviewEvidence: 'the attributed run joined through review_lens',
      unmatchedEvidence: 'a key seen only outside those routes, or naming a non-child, is not assigned to this epic',
    },
    children: rows,
    total,
    notRecorded: [{
      metric: 'architect commits on run branches',
      needed: 'record commit author role and task/run attribution when an architect commits on a run branch',
    }],
  }
}

type DurationMetrics = Pick<EpicTaskScore,
  'agentTimeMs' | 'occupancyMs' | 'elapsedSpanMs' | 'runDurationMeanMs' | 'runDurationP95Ms' |
  'ghostRuns' | 'idleMinutes'>

/** All arithmetic is epoch-millisecond UTC. Rendering may choose a timezone; computation never does. */
function durationMetrics(runs: RunRow[], clock: number): DurationMetrics {
  const intervals = runs.flatMap((run): { run: RunRow; start: number; end: number; duration: number }[] => {
    if (run.latency_ms === null) return []
    const start = utcMillis(run.started_at)
    const duration = Math.max(0, run.latency_ms)
    return Number.isFinite(start) ? [{ run, start, end: start + duration, duration }] : []
  }).sort((a, b) => a.start - b.start || a.end - b.end)
  const durations = intervals.map((interval) => interval.duration).sort((a, b) => a - b)
  // Ghost freshness asks when evidence last arrived, not when a timed run ended.
  const anchor = (run: RunRow) => utcMillis(run.last_event_at ?? run.started_at)
  const idleMs = intervals.reduce((sum, interval) => {
    const last = anchor(interval.run)
    return sum + (Number.isFinite(last) ? Math.max(0, interval.end - last) : 0)
  }, 0)
  return {
    agentTimeMs: durations.reduce((sum, duration) => sum + duration, 0),
    occupancyMs: engagedMs(intervals),
    elapsedSpanMs: intervals.length
      ? Math.max(...intervals.map((interval) => interval.end)) - intervals[0]!.start : 0,
    runDurationMeanMs: durations.length
      ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length : null,
    runDurationP95Ms: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1]! : null,
    ghostRuns: runs.filter((run) => run.latency_ms === null && (
      (run.status === 'running' && Number.isFinite(anchor(run)) && clock - anchor(run) >= STALE_AFTER_MS) ||
      (run.status === 'stale' && run.failure_kind === 'interrupted')
    )).length,
    idleMinutes: Math.round(idleMs / 60_000),
  }
}

function commitSubjects(database: Database): Map<number, Map<string, string>> {
  const projects = database.query('SELECT id,path FROM project ORDER BY id').all() as { id: number; path: string }[]
  const result = new Map<number, Map<string, string>>()
  for (const project of projects) {
    const git = Bun.spawnSync(['git', 'log', '--all', '--format=%H%x09%s'], {
      cwd: project.path, stdout: 'pipe', stderr: 'pipe', env: targetGitEnvironment(project.path),
    })
    if (git.exitCode !== 0) continue
    const rows = new Map<string, string>()
    for (const line of git.stdout.toString().split('\n')) {
      const tab = line.indexOf('\t')
      if (tab > 0) rows.set(line.slice(0, tab), line.slice(tab + 1))
    }
    result.set(project.id, rows)
  }
  return result
}

function totalRow(rows: EpicTaskScore[], timing: DurationMetrics): EpicTaskScore {
  const byJob: Record<string, number> = {}
  const causes: Record<string, number> = {}
  for (const row of rows) {
    for (const [job, count] of Object.entries(row.runs.byJob)) byJob[job] = (byJob[job] ?? 0) + count
    for (const [cause, count] of Object.entries(row.landings.refusedByCause)) causes[cause] = (causes[cause] ?? 0) + count
  }
  const nullableSum = (values: (number | null)[]) => values.some((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null
  return {
    key: 'TOTAL', title: '', status: null,
    runs: { total: rows.reduce((sum, row) => sum + row.runs.total, 0), byJob: Object.fromEntries(Object.entries(byJob).sort()) },
    ...timing,
    vendorTokens: nullableSum(rows.map((row) => row.vendorTokens)),
    vendorCostUsd: nullableSum(rows.map((row) => row.vendorCostUsd)),
    unreportedUsageRuns: {
      tokens: rows.reduce((sum, row) => sum + row.unreportedUsageRuns.tokens, 0),
      cost: rows.reduce((sum, row) => sum + row.unreportedUsageRuns.cost, 0),
    },
    lensRounds: rows.reduce((sum, row) => sum + row.lensRounds, 0),
    fixRounds: rows.reduce((sum, row) => sum + row.fixRounds, 0),
    landings: {
      attempted: rows.reduce((sum, row) => sum + row.landings.attempted, 0),
      landed: rows.reduce((sum, row) => sum + row.landings.landed, 0),
      refused: rows.reduce((sum, row) => sum + row.landings.refused, 0),
      refusedByCause: Object.fromEntries(Object.entries(causes).sort()),
    },
    reviews: {
      recorded: rows.reduce((sum, row) => sum + row.reviews.recorded, 0),
      completed: rows.reduce((sum, row) => sum + row.reviews.completed, 0),
      outdated: rows.reduce((sum, row) => sum + row.reviews.outdated, 0),
    },
    strandings: {
      count: rows.reduce((sum, row) => sum + row.strandings.count, 0),
      reasons: rows.flatMap((row) => row.strandings.reasons),
    },
    continuations: {
      count: rows.reduce((sum, row) => sum + row.continuations.count, 0),
      branchDrift: rows.reduce((sum, row) => sum + row.continuations.branchDrift, 0),
    },
    architectCommits: null,
  }
}

export async function epicChildren(epicKey: string): Promise<EpicChild[]> {
  const child = Bun.spawn([HUB, 'task', 'list', '--parent', epicKey, '--json'], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `hub exited ${code}`)
  const parsed = JSON.parse(stdout) as unknown
  if (!Array.isArray(parsed) || parsed.some((row: any) => typeof row?.key !== 'string')) {
    throw new Error('hub task list --parent returned an invalid JSON document')
  }
  return parsed as EpicChild[]
}

const duration = (ms: number | null) => ms === null ? 'NULL' : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s`
  : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 3_600_000).toFixed(1)}h`
const jobs = (row: EpicTaskScore) => Object.entries(row.runs.byJob).map(([job, count]) => `${job}=${count}`).join(',') || '-'
const usage = (value: number | null, missing: number, cost = false) => value === null ? 'NULL'
  : `${cost ? `$${value.toFixed(2)}` : value.toLocaleString()}${missing ? ` (+${missing} NR)` : ''}`

export function renderEpicHuman(report: EpicScoreboard): string {
  const rows = [...report.children, report.total]
  const jobWidth = Math.max(11, ...rows.map((row) => jobs(row).length))
  const lines = [`EPIC ${report.epicKey}`, `TASK         ${'RUNS BY JOB'.padEnd(jobWidth)} AGENT   OCCUP   SPAN    MEAN     P95 GHOST      TOKENS          COST  LENS FIX  LAND A/L/R  REV R/C/O  STR IDLE CONT/DRIFT`]
  for (const row of rows) lines.push(
    `${row.key.padEnd(12)} ${jobs(row).padEnd(jobWidth)} ${duration(row.agentTimeMs).padStart(7)} ${duration(row.occupancyMs).padStart(7)} ` +
    `${duration(row.elapsedSpanMs).padStart(7)} ${duration(row.runDurationMeanMs).padStart(7)} ${duration(row.runDurationP95Ms).padStart(7)} ${String(row.ghostRuns).padStart(5)} ` +
    `${usage(row.vendorTokens, row.unreportedUsageRuns.tokens).padStart(15)} ${usage(row.vendorCostUsd, row.unreportedUsageRuns.cost, true).padStart(8)} ` +
    `${String(row.lensRounds).padStart(5)} ${String(row.fixRounds).padStart(3)}  ` +
    `${`${row.landings.attempted}/${row.landings.landed}/${row.landings.refused}`.padStart(10)}  ` +
    `${`${row.reviews.recorded}/${row.reviews.completed}/${row.reviews.outdated}`.padStart(9)}  ` +
    `${String(row.strandings.count).padStart(3)} ${String(row.idleMinutes).padStart(4)} ${`${row.continuations.count}/${row.continuations.branchDrift}`.padStart(10)}`,
  )
  const refused = Object.entries(report.total.landings.refusedByCause)
  lines.push('\nREFUSED LANDINGS BY CAUSE')
  if (!refused.length) lines.push('  (none)')
  else for (const [cause, count] of refused) lines.push(`  ${count}x ${cause}`)
  lines.push('\nSTRANDINGS')
  if (!report.total.strandings.reasons.length) lines.push('  (none)')
  else for (const reason of report.total.strandings.reasons) lines.push(`  landing ${reason.landingId} ${reason.kind}: ${reason.reason}`)
  lines.push('\nNOT RECORDED')
  for (const missing of report.notRecorded) lines.push(`  ${missing.metric}: ${missing.needed}`)
  return lines.join('\n')
}
