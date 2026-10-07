/**
 * What a dashboard needs, as functions.
 *
 * This concern no longer SERVES one - hub does, and it reads these through
 * `orch state` and `orch run`. Two pages both claiming to show agent scores
 * would drift, and this codebase has already paid for that once: its stats
 * command and its dashboard read 96% on review-lens while the router, counting
 * failures, was using 69%. One page, one scoreboard.
 */

import { existsSync, readFileSync } from 'node:fs'
import { AGENTS, refreshAgents } from '../agent/agent-registry.ts'
import { readAskServerFailure } from '../ask/ask-failure.ts'
import { summarizeAskServer } from '../ask/ask-lifecycle.ts'
import { db } from '../database/db.ts'
import { readEventLog, runEventsPath } from '../events.ts'
import { runTotals } from '../evidence/evidence-query.ts'
import { JOBS } from '../jobs/jobs.ts'
import { messagesForRun, receiptMessagesForArchitect } from '../mailbox/mailbox.ts'
import { summary as metricSummary } from '../metric/metric.ts'
import { projectAt } from '../project/projects.ts'
import { reviewCalibration } from '../review/review-calibration.ts'
import { candidates, scoreboard } from '../route/route.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { rulingStatus } from '../run/question-vocabulary.ts'
import { runArtifactsDir, runScratchDir } from '../run/run-artifacts.ts'
import { reapStale } from '../run/run-liveness.ts'
import { agentExecutionStatsSql } from '../run/synthetic-lifecycle-job.ts'
import { registerStandardRuntime } from '../runtime/runtime-registration.ts'
import { guide } from './guide.ts'

registerStandardRuntime()

const jsonArray = (value: unknown) =>
  typeof value === 'string' ? (JSON.parse(value) as unknown[]) : []

function reviewsForRun(runId: number) {
  const lenses = db()
    .query(
      `SELECT l.*, r.project_id AS review_project_id, r.recorded_at, r.completed_at,
              r.tier, r.patch_id, r.commit_message
         FROM review_lens l JOIN review r ON r.id=l.review_id
        WHERE l.run_id=? ORDER BY r.recorded_at DESC, l.id DESC`,
    )
    .all(runId) as Record<string, unknown>[]
  return lenses.map((lens) => ({
    id: lens.id,
    reviewId: lens.review_id,
    runId: lens.run_id,
    lens: lens.lens,
    agent: lens.agent,
    model: lens.model,
    treeInspected: lens.tree_inspected,
    reviewedTree: lens.reviewed_tree,
    standardsRead: jsonArray(lens.standards_read),
    filesCovered: jsonArray(lens.files_covered),
    commandsRun: jsonArray(lens.commands_run),
    couldNotVerify: jsonArray(lens.could_not_verify),
    mcpTools: jsonArray(lens.mcp_tools),
    docsRead: jsonArray(lens.docs_read),
    substitutes: jsonArray(lens.substitutes),
    reproduced: lens.reproduced,
    coverage: lens.coverage,
    limits: lens.limits,
    overlap: lens.overlap,
    reviewProjectId: lens.review_project_id,
    recordedAt: lens.recorded_at,
    completedAt: lens.completed_at,
    tier: lens.tier,
    patchId: lens.patch_id,
    commitMessage: lens.commit_message,
    findings: db()
      .query(
        `SELECT id, review_id AS reviewId, review_lens_id AS reviewLensId, ordinal,
                severity, location, evidence, proposed_correction AS proposedCorrection,
                disposition, rejection_category AS rejectionCategory,
                triaged_severity AS triagedSeverity, triaged_at AS triagedAt
           FROM review_finding WHERE review_lens_id=? ORDER BY ordinal`,
      )
      .all(Number(lens.id)),
  }))
}

/** Full detail for one run: the whole prompt and the whole reply, read from disk. */
export function runDetail(id: number, receipt = false) {
  const row = db()
    .query(
      `SELECT r.id, r.agent, r.job, r.cwd, r.latency_ms, r.vendor_tokens, r.status,
            r.failure_kind, r.probe, r.evidence_excluded, r.error, r.input_tree, r.head_commit,
            r.changed_paths, r.review_ref, r.doc_revisions, r.canon_sha,
            r.prompt_path, r.output_path, r.mcp, r.mcp_server, r.mcp_connected, r.mcp_error,
            r.branch_kept, r.branch_kept_tip,
            s.delivery, s.quality, s.fidelity, s.note, s.scored_at
       FROM run r
       LEFT JOIN score s ON s.run_id = r.id WHERE r.id = ?`,
    )
    .get(id) as Record<string, unknown> | null
  if (!row) return null
  const read = (p: unknown) =>
    typeof p === 'string' && existsSync(p) ? readFileSync(p, 'utf8') : null
  const eventsPath = runEventsPath(id)
  const identity = db()
    .query('SELECT parent_run_id, COALESCE(parent_run_id, id) root_id FROM run WHERE id=?')
    .get(id) as { parent_run_id: number | null; root_id: number }
  const rootId = identity.root_id
  const messages = receipt ? receiptMessagesForArchitect(id) : messagesForRun(id)
  const audit = db()
    .query(
      `SELECT run_id, root_id, action,
            COALESCE(actor_session, 'anonymous (no session id)') actor_session,
            at, reason
       FROM run_mutation_audit WHERE root_id=? ORDER BY at, rowid`,
    )
    .all(rootId)
  const questions = db()
    .query(
      `SELECT q.id,q.run_id,q.asked_at,q.question,q.answer,q.answered_at,q.answered_by,
              q.overturned_at,q.overturned_by,q.overturn_reason,q.replacement,
              q.filed_as,q.filed_ref,q.filed_at
         FROM question q JOIN run owner ON owner.id=q.run_id
        WHERE owner.id=? OR owner.parent_run_id=? ORDER BY q.id`,
    )
    .all(rootId, rootId) as Record<string, unknown>[]
  return {
    ...row,
    requested_id: id,
    resolved_from: identity.parent_run_id === null ? 'root' : 'turn',
    root_id: rootId,
    changed_paths: typeof row.changed_paths === 'string' ? JSON.parse(row.changed_paths) : null,
    project: typeof row.cwd === 'string' ? (projectAt(row.cwd)?.name ?? null) : null,
    scoreAxes: JOBS[String(row.job)]?.needs.writesRepo
      ? ['delivery', 'quality', 'fidelity']
      : ['delivery', 'quality'],
    prompt: read(row.prompt_path),
    output: read(row.output_path),
    ask_server: summarizeAskServer(
      existsSync(eventsPath) ? readEventLog(eventsPath) : null,
      readAskServerFailure(runScratchDir(id)) ?? readAskServerFailure(runArtifactsDir(id)),
    ),
    reviews: reviewsForRun(id),
    messages,
    audit,
    questions: questions.map((question) => ({
      ...question,
      ruling_status: rulingStatus(question.overturned_at, question.answered_at),
    })),
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
  // Hub refreshes this snapshot on its minute tick. Make that the explicit
  // boundary at which a long-lived process adopts registry changes.
  refreshAgents()
  const d = db()
  const since = sinceDays ? new Date(Date.now() - sinceDays * 86_400_000).toISOString() : '0000'
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
  const live = d
    .query(
      `SELECT id, COALESCE(parent_run_id,id) root_id, agent, job, repo, cwd, started_at, COALESCE(label, prompt_head) AS prompt_head, status,
            (SELECT COUNT(*) FROM question q
              WHERE q.run_id = run.id AND ${questionOpenSql('q')}) AS open_questions,
            (status = 'asking' AND (SELECT COUNT(*) FROM question q
              WHERE q.run_id = run.id AND ${questionOpenSql('q')}) > 0) AS waiting
       FROM run WHERE status IN ('running','asking') ORDER BY waiting DESC, id DESC`,
    )
    .all()

  const stale = (d.query(`SELECT COUNT(*) n FROM run WHERE status='stale'`).get() as { n: number })
    .n

  // One cell per agent × job, from the router's own scoreboard rather than a
  // second query. This used to filter status='ok' and reported grok on
  // review-lens at 96% while the router, counting six failures, was using 69%.
  const matrix = scoreboard().map((c) => ({
    job: c.job,
    promptBucket: c.promptBucket,
    agent: c.agent,
    // `judged`, not `scored`: it counts failures too, and a key that keeps the
    // old name while changing meaning is how the page came to render
    // "36/32 scored" — more judgments than runs, which is nonsense on sight.
    runs: c.runs,
    judged: c.evidence,
    failures: c.failures,
    pts: c.score === null ? 0 : c.score * c.evidence,
    lat: c.latencyMs,
    toks: c.tokens,
  }))

  const byRepo = d
    .query(
      `SELECT COALESCE(r.repo,'—') repo, r.agent, COUNT(*) runs,
            SUM(COALESCE(r.vendor_tokens,0)) toks
       FROM run r WHERE r.status='ok' AND r.probe=0 AND ${agentExecutionStatsSql('r')}
      GROUP BY r.repo, r.agent ORDER BY runs DESC`,
    )
    .all()

  // Windowed. A lifetime `failed` and `stale` can only ever go up, so the
  // counters that would show a fix working stay frozen at the pre-fix number:
  // the nine stale runs all predate the try/finally, and would have sat on this
  // band for ever announcing a bug that no longer exists.
  //
  // Doctor prints the same scored/voided/unscored buckets from runTotals();
  // a second query here is how a no-verdict void vanished from one surface
  // and not the other.
  const counted = runTotals(sinceDays ? since : undefined)
  const { unscored, ...totals } = counted

  // The runs tab counts everything ever, whatever the band is showing, so the
  // badge on it does not change meaning when the window does.
  const allTimeRuns = (
    d.query(`SELECT COUNT(*) n FROM run r WHERE ${agentExecutionStatsSql('r')}`).get() as {
      n: number
    }
  ).n

  // A first run has no metric table, which is not a fault. Anything else is,
  // and the dashboard has been through this once already: a swallowed render
  // error is a panel that is silently always empty. Report it in the payload so
  // the page can say so instead of showing nothing.
  let metric = null
  let metricError: string | null = null
  try {
    metric = metricSummary(14)
  } catch (e) {
    const m = (e as Error).message
    if (!/no such table/i.test(m)) metricError = m
  }

  // Agent health: what the gate and the vendors are doing to availability.
  // A quota or auth failure needs a person, so it is surfaced rather than
  // left to be inferred from a run that merely says "failed".
  const health = Object.keys(AGENTS).map((name) => {
    const c = candidates('summarize').find((x) => x.agent === name)
    const l = d
      .query(
        `SELECT status, failure_kind, started_at,
              (julianday('now') - julianday(started_at)) * 1440 AS mins_ago
         FROM run WHERE agent = ? AND status IN ('ok','failed') AND started_at >= ?
        ORDER BY id DESC LIMIT 1`,
      )
      .get(name, since) as { status: string; failure_kind: string | null; mins_ago: number } | null
    return {
      agent: name,
      billing: AGENTS[name]!.billing,
      cooling: c?.cooling ?? null,
      lastStatus: l?.status ?? null,
      lastKind: l?.failure_kind ?? null,
      minsAgo: l?.mins_ago ?? null,
    }
  })

  const spawns = d
    .query(`SELECT decision, why, COUNT(*) n FROM spawn GROUP BY decision, why ORDER BY n DESC`)
    .all()

  const reviewCells = (
    d
      .query(
        `SELECT DISTINCT lens, agent, model FROM review_lens
      WHERE model IS NOT NULL ORDER BY lens, agent, model`,
      )
      .all() as { lens: string; agent: string; model: string }[]
  ).map(({ lens, agent, model }) => reviewCalibration(lens, agent, model, d))

  return {
    live,
    stale,
    matrix,
    byRepo,
    totals,
    allTimeRuns,
    unscored,
    sinceDays,
    metric,
    metricError,
    guide: guide(),
    health,
    spawns,
    reviewCalibration: reviewCells,
    agents: Object.values(AGENTS).map((a) => ({ name: a.name, billing: a.billing, caps: a.caps })),
    jobs: Object.keys(JOBS),
    now: Date.now(),
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
