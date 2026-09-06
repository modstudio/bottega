/**
 * What a dashboard needs, as functions.
 *
 * This concern no longer SERVES one - hub does, and it reads these through
 * `orch state` and `orch run`. Two pages both claiming to show agent scores
 * would drift, and this codebase has already paid for that once: its stats
 * command and its dashboard read 96% on review-lens while the router, counting
 * failures, was using 69%. One page, one scoreboard.
 */
import { db, reapStale, unscoredCount } from './db.ts'
import { AGENTS } from './agents.ts'
import { JOBS } from './jobs.ts'
import { scoreboard } from './route.ts'
import { summary as metricSummary } from './metric.ts'
import { guide } from './guide.ts'
import { candidates } from './route.ts'
import { readFileSync, existsSync } from 'node:fs'
import { NOT_EVIDENCE } from './failure.ts'
import { projectAt } from './projects.ts'
import { readMessagesForArchitect } from './mailbox.ts'
import { reviewCalibration } from './review.ts'

/** Full detail for one run: the whole prompt and the whole reply, read from disk. */
export function runDetail(id: number) {
  const row = db().query(
    `SELECT r.id, r.agent, r.job, r.cwd, r.latency_ms, r.vendor_tokens, r.status,
            r.failure_kind, r.probe, r.evidence_excluded, r.error, r.input_tree, r.doc_revisions, r.canon_sha,
            r.prompt_path, r.output_path, r.mcp, r.mcp_server, r.mcp_connected, r.mcp_error,
            s.delivery, s.quality, s.fidelity, s.note, s.scored_at
       FROM run r
       LEFT JOIN score s ON s.run_id = r.id WHERE r.id = ?`,
  ).get(id) as Record<string, unknown> | null
  if (!row) return null
  const read = (p: unknown) =>
    typeof p === 'string' && existsSync(p) ? readFileSync(p, 'utf8') : null
  return {
    ...row,
    project: typeof row.cwd === 'string' ? projectAt(row.cwd)?.name ?? null : null,
    scoreAxes: JOBS[String(row.job)]?.needs.writesRepo
      ? ['delivery', 'quality', 'fidelity']
      : ['delivery', 'quality'],
    prompt: read(row.prompt_path),
    output: read(row.output_path),
    messages: readMessagesForArchitect(id),
    // Runs recorded before prompts were kept on disk have only the head.
    promptTruncated: !row.prompt_path,
  }
}

/**
 * How far back the activity counters look. Null means all of it.
 *
 * Only the COUNTERS and agent health take a window. The routing matrix, the
 * guide and the per-repo tallies deliberately do not: they are the evidence
 * base, MIN_SAMPLE counts the whole corpus, and a matrix narrowed to "today"
 * would report that an agent has no runs while the router is confidently using
 * twenty-six of them. They also live on a different tab, so the control cannot
 * imply otherwise.
 */
export function state(sinceDays: number | null = null) {
  const d = db()
  const notEvidence = NOT_EVIDENCE.map((kind) => `'${kind}'`).join(', ')
  const since = sinceDays
    ? new Date(Date.now() - sinceDays * 86_400_000).toISOString()
    : '0000'
  // Age is a reaping criterion, not a display one. Filtering the panel by the
  // same cutoff as well made a genuinely live long run disappear from "in
  // flight" without ever becoming stale: reapStale had left it alone because
  // its pid was alive, and then the view hid it. Sweep first, then show
  // whatever is still marked running.
  reapStale(d)

  /**
   * ASKING RUNS ARE LIVE, and are the ones most worth seeing.
   *
   * This listed only `status='running'`, which hid the single thing on the page
   * that needs a person: a worker that stopped to get a decision is waiting on
   * the reader, indefinitely, and was invisible while every run that needed
   * nothing from anyone was shown. It is also the state that costs most to
   * leave alone — the worker is holding a whole session, with everything it has
   * read, until somebody rules.
   *
   * `waiting` MEANS AN UNANSWERED QUESTION, not merely the status word.
   *
   * A turn that asked keeps `asking` as its own outcome for ever — that is what
   * it did — so a chain answered an hour ago still has rows saying `asking`
   * whose questions are long since ruled on. Reading the status alone put three
   * such rows at the top of the page demanding attention nobody owed, which is
   * how a panel that is supposed to surface the one urgent thing teaches people
   * to ignore it.
   *
   * So a row waits only while something is genuinely unanswered, and the count
   * is carried beside it so the page can say how many.
   */
  const live = d.query(
    `SELECT id, agent, job, repo, cwd, started_at, COALESCE(label, prompt_head) AS prompt_head, status,
            (SELECT COUNT(*) FROM question q
              WHERE q.run_id = run.id AND q.answered_at IS NULL) AS open_questions,
            (status = 'asking' AND (SELECT COUNT(*) FROM question q
              WHERE q.run_id = run.id AND q.answered_at IS NULL) > 0) AS waiting
       FROM run WHERE status IN ('running','asking') ORDER BY waiting DESC, id DESC`,
  ).all()

  const stale = (d.query(
    `SELECT COUNT(*) n FROM run WHERE status='stale'`,
  ).get() as { n: number }).n

  // One cell per agent × job, from the router's own scoreboard rather than a
  // second query. This used to filter status='ok' and reported grok on
  // review-lens at 96% while the router, counting six failures, was using 69%.
  const matrix = scoreboard().map((c) => ({
    job: c.job, promptBucket: c.promptBucket, agent: c.agent,
    // `judged`, not `scored`: it counts failures too, and a key that keeps the
    // old name while changing meaning is how the page came to render
    // "36/32 scored" — more judgements than runs, which is nonsense on sight.
    runs: c.runs, judged: c.evidence, failures: c.failures,
    pts: c.score === null ? 0 : c.score * c.evidence,
    lat: c.latencyMs, toks: c.tokens,
  }))

  const byRepo = d.query(
    `SELECT COALESCE(r.repo,'—') repo, r.agent, COUNT(*) runs,
            SUM(COALESCE(r.vendor_tokens,0)) toks
       FROM run r WHERE r.status='ok' AND r.probe=0
      GROUP BY r.repo, r.agent ORDER BY runs DESC`,
  ).all()


  // Windowed. A lifetime `failed` and `stale` can only ever go up, so the
  // counters that would show a fix working stay frozen at the pre-fix number:
  // the nine stale runs all predate the try/finally, and would have sat on this
  // band for ever announcing a bug that no longer exists.
  const totals = d.query(
    // COALESCE on every SUM: over an empty window SUM returns NULL, not zero,
    // while COUNT returns zero — so a quiet day answered `failed: null` beside
    // `runs: 0`. The page coerces it, but an API that reports "no failures" as
    // null is one bad `??` away from reporting it as "unknown".
    `SELECT COUNT(*) runs,
            COALESCE(SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END), 0) failed,
            COALESCE(SUM(CASE WHEN r.status='stale' THEN 1 ELSE 0 END), 0) stale_n,
            COALESCE(SUM(COALESCE(r.vendor_tokens,0)), 0) toks,
            COALESCE(SUM(CASE WHEN s.delivery IS NOT NULL
                               AND COALESCE(r.failure_kind, '') NOT IN (${notEvidence})
                              THEN 1 ELSE 0 END), 0) scored
       FROM run r LEFT JOIN score s ON s.run_id = r.id
      WHERE r.started_at >= ?`,
  ).get(since)

  // The runs tab counts everything ever, whatever the band is showing, so the
  // badge on it does not change meaning when the window does.
  const allTimeRuns = (d.query(`SELECT COUNT(*) n FROM run`).get() as { n: number }).n

  // Computed, not derived by subtraction on the client. `runs - scored` counted
  // probes, in-flight runs and failures as debt; this is the same rule
  // `orch pending` uses, over the same window as the rest of the band.
  const unscored = unscoredCount(sinceDays ? since : undefined)

  // A first run has no metric table, which is not a fault. Anything else is,
  // and the dashboard has been through this once already: a swallowed render
  // error is a panel that is silently always empty. Report it in the payload so
  // the page can say so instead of showing nothing.
  let metric = null
  let metricError: string | null = null
  try { metric = metricSummary(14) }
  catch (e) {
    const m = (e as Error).message
    if (!/no such table/i.test(m)) metricError = m
  }

  // Agent health: what the gate and the vendors are doing to availability.
  // A quota or auth failure needs a person, so it is surfaced rather than
  // left to be inferred from a run that merely says "failed".
  const health = Object.keys(AGENTS).map((name) => {
    const c = candidates('summarize').find((x) => x.agent === name)
    const l = d.query(
      `SELECT status, failure_kind, started_at,
              (julianday('now') - julianday(started_at)) * 1440 AS mins_ago
         FROM run WHERE agent = ? AND status IN ('ok','failed') AND started_at >= ?
        ORDER BY id DESC LIMIT 1`,
    ).get(name, since) as { status: string; failure_kind: string | null; mins_ago: number } | null
    return {
      agent: name,
      billing: AGENTS[name]!.billing,
      cooling: c?.cooling ?? null,
      lastStatus: l?.status ?? null,
      lastKind: l?.failure_kind ?? null,
      minsAgo: l?.mins_ago ?? null,
    }
  })

  const spawns = d.query(
    `SELECT decision, why, COUNT(*) n FROM spawn GROUP BY decision, why ORDER BY n DESC`,
  ).all()

  const reviewCells = (d.query(
    `SELECT DISTINCT lens, agent, model FROM review_lens
      WHERE model IS NOT NULL ORDER BY lens, agent, model`,
  ).all() as { lens: string; agent: string; model: string }[])
    .map(({ lens, agent, model }) => reviewCalibration(lens, agent, model, d))

  return {
    live, stale, matrix, byRepo, totals, allTimeRuns, unscored, sinceDays,
    metric, metricError, guide: guide(), health, spawns, reviewCalibration: reviewCells,
    agents: Object.values(AGENTS).map((a) => ({ name: a.name, billing: a.billing, caps: a.caps })),
    jobs: Object.keys(JOBS),
    now: Date.now(),
  }
}


/** Filtered, paginated run listing. Filters are whitelisted, never interpolated. */
export function runList(q: URLSearchParams) {
  const where: string[] = []
  // Typed as the bindings SQLite actually accepts: `unknown[]` does not
  // satisfy the query signature, which is why this file never typechecked.
  const args: (string | number)[] = []
  for (const key of ['agent', 'job', 'repo'] as const) {
    const v = q.get(key)
    if (v) { where.push(`r.${key} = ?`); args.push(v) }
  }
  const status = q.get('status')
  if (status) { where.push('r.status = ?'); args.push(status) }
  // One dropdown over two columns: 'none' is a delivery, the rest are qualities.
  const verdict = q.get('verdict')
  if (verdict === 'unscored') where.push('s.delivery IS NULL')
  else if (verdict === 'none') where.push("s.delivery = 'none'")
  else if (verdict) { where.push('s.quality = ?'); args.push(verdict) }
  const search = q.get('q')
  if (search) { where.push('COALESCE(r.label, r.prompt_head) LIKE ?'); args.push(`%${search}%`) }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 25), 1), 200)
  const page = Math.max(Number(q.get('page') ?? 1), 1)

  const total = (db().query(
    `SELECT COUNT(*) n FROM run r LEFT JOIN score s ON s.run_id = r.id ${clause}`,
  ).get(...args) as { n: number }).n

  const rows = db().query(
    `SELECT r.id, r.started_at, r.agent, r.job, r.repo, r.latency_ms, r.vendor_tokens,
            r.prompt_bytes, r.output_bytes, r.status, s.delivery, s.quality, s.note,
            COALESCE(r.label, r.prompt_head) AS prompt_head
       FROM run r LEFT JOIN score s ON s.run_id = r.id
       ${clause} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
  ).all(...args, limit, (page - 1) * limit)

  // Distinct values so the filter dropdowns only offer what exists.
  //
  // The column name is interpolated because SQLite cannot bind an identifier, so
  // the type is narrowed to the three columns this is allowed to read rather
  // than left as `string` for a later caller to widen by accident.
  const distinct = (col: 'agent' | 'job' | 'repo') =>
    (db().query(`SELECT DISTINCT ${col} v FROM run WHERE ${col} IS NOT NULL ORDER BY v`)
      .all() as { v: string }[]).map((r) => r.v)

  return {
    rows, total, page, limit,
    pages: Math.max(Math.ceil(total / limit), 1),
    facets: { agents: distinct('agent'), jobs: distinct('job'), repos: distinct('repo') },
  }
}

/**
 * How often a long-lived process re-probes the local endpoint.
 *
 * The health cache is sized for `orch do`, which lives for one run. This
 * process lives for days, so without a refresh the dashboard would keep showing
 * a verdict taken at start-up — reporting the local model down for a week after
 * it came back, or up for a week after it went away. A minute is far below the
 * time anyone would tolerate a wrong answer and far above the cost of asking:
 * one HTTP call to a socket on this machine.
 */
