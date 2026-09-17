// concern: evidence-query
/**
 * Knows canonical evidence, change, pair SQL, and read queries. Must not know worktrees, runs, routing, transports, or reviews.
 */
import type { Database } from 'bun:sqlite'
import { db } from '../db.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { nonHookTreeStatsSql } from '../hook-tree.ts'

/**
 * Why a collided output file cannot be routing evidence.
 *
 * Output filenames are keyed by run id. Clock-based names can collide when
 * runs start in the same millisecond with the same agent and job; within an
 * existing colliding group we cannot tell which run's output survived, so
 * every member is excluded rather than guessing a winner.
 */
export const SHARED_OUTPUT_REASON =
  'shared an output file with other runs; a clock-based name collision destroyed all but one, and we cannot tell which survived'

/**
 * Stamp every run whose output_path is shared with at least one other.
 *
 * Idempotent, and never overwrites a reason that is already there: a
 * person who excluded a run for a different reason keeps their words.
 * Returns how many rows this call actually wrote, so a backfill can be
 * counted rather than guessed.
 */
export function excludeSharedOutputRuns(d: Database = db()): number {
  const r = d
    .query(
      `UPDATE run SET evidence_excluded = ?
      WHERE evidence_excluded IS NULL
        AND output_path IN (
          SELECT output_path FROM run
           WHERE output_path IS NOT NULL
           GROUP BY output_path
          HAVING COUNT(*) > 1
        )`,
    )
    .run(SHARED_OUTPUT_REASON)
  return r.changes
}

/**
 * Owed a judgement: never scored, OR scored before the conversation moved on.
 *
 * The second half was missing and it let the earliest turn win by accident. A
 * chain is one unit of work and takes one verdict, so a session that scored a
 * root after its first turn — faithful, it had stopped and asked — kept that
 * verdict when turn two drifted and turn three corrected it. The drift became
 * invisible to the router, not because anyone judged it kindly but because
 * nothing asked again.
 *
 * Scores were already mutable (`ON CONFLICT DO UPDATE`), so the fix is not to
 * allow re-scoring but to ASK for it: a verdict recorded before the chain's
 * latest turn finished is stale, and stale is a kind of unscored.
 *
 * A void closes the ledger whether or not a verdict was stored: excluded
 * evidence is not an owed judgement.
 */
export const UNSCORED_WHERE = `r.status = 'ok' AND r.evidence_excluded IS NULL AND COALESCE(r.probe, 0) = 0 AND r.parent_run_id IS NULL
   AND COALESCE((SELECT c.status FROM run c WHERE c.parent_run_id = r.id
                  ORDER BY c.turn DESC LIMIT 1), r.status) <> 'running'
   AND (s.delivery IS NULL
        OR s.scored_at < (SELECT MAX(COALESCE(c.started_at, ''))
                            FROM run c WHERE c.parent_run_id = r.id))`

/**
 * The evidence boundary: a run leaves the owed-judgement ledger in two ways,
 * a stored verdict or `evidence_excluded` set by a void. Every consumer of
 * that boundary reads these fragments. Do not restate them in SQL.
 *
 * Void stamps the conversation root. A child turn must see that stamp the
 * same way chainScoreJoin makes it see the root's score, or a no-verdict
 * void would still pin a tree held by a later turn.
 */
const EVIDENCE_EXCLUDED_SQL = `(SELECT evidence_root.evidence_excluded FROM run evidence_root
     WHERE evidence_root.id = COALESCE(r.parent_run_id, r.id))`

export const EVIDENCE_CLOSED_SQL = `(s.delivery IS NOT NULL OR ${EVIDENCE_EXCLUDED_SQL} IS NOT NULL)`

/**
 * Voided is the exclusion stamp, not a routing-evidence count, so it does
 * not apply the NOT_EVIDENCE filter the scored count uses. A voided
 * interrupted run is still voided. Filtering it here would drop a no-verdict
 * void of a NOT_EVIDENCE run from every bucket, which is the class this
 * helper exists to close.
 *
 * Empty string is voided: the predicate is IS NOT NULL, not JS truthiness.
 * Inbox filtering and rendering consume these flags; do not restate them.
 */
export function voidedSql(alias = 'r'): string {
  return `${alias}.evidence_excluded IS NOT NULL`
}

export const VOIDED_SQL = voidedSql()

/** A live chain: running or asking, and not voided. */
export function activeSql(alias = 'r'): string {
  return `${alias}.status IN ('running','asking') AND NOT (${voidedSql(alias)})`
}

const NOT_EVIDENCE_SQL = NOT_EVIDENCE.map((kind) => `'${kind}'`).join(', ')

const SCORED_EVIDENCE_SQL = `s.delivery IS NOT NULL
   AND r.evidence_excluded IS NULL
   AND COALESCE(r.failure_kind, '') NOT IN (${NOT_EVIDENCE_SQL})`

/**
 * One evidence identity: caller prompt (`spec_sha`), change (`review.patch_id`
 * and `review.path_set` from changeIdentity()), lens, and effective model.
 * Pair offers, the unevidenced gate, void, reminders and routing keys read
 * this tuple. Do not restate it, and do not key those surfaces on input_tree.
 *
 * Change identity lives on the review row. A run without a review has NULL
 * patch_id and path_set; NULL IS NULL, so two unrecorded changes still pair
 * on spec_sha and lens.
 */
function sqlAlias(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('evidence-tuple aliases must be SQL identifiers')
  }
  return name
}

export function changeIdentityJoin(
  runAlias: string,
  lensAlias: string,
  reviewAlias: string,
): string {
  const run = sqlAlias(runAlias)
  const lens = sqlAlias(lensAlias)
  const review = sqlAlias(reviewAlias)
  return `LEFT JOIN review_lens ${lens} ON ${lens}.run_id = ${run}.id
          LEFT JOIN review ${review} ON ${review}.id = ${lens}.review_id`
}

export function sameTaskSql(leftRun: string, rightRun: string): string {
  const left = sqlAlias(leftRun)
  const right = sqlAlias(rightRun)
  return `${left}.spec_sha IS NOT NULL AND ${right}.spec_sha = ${left}.spec_sha
        AND (${left}.lens IS ${right}.lens)`
}

export function sameChangeSql(leftReview: string, rightReview: string): string {
  const left = sqlAlias(leftReview)
  const right = sqlAlias(rightReview)
  return `${left}.patch_id IS ${right}.patch_id AND ${left}.path_set IS ${right}.path_set`
}

export function pairReasonSql(
  leftRun: string,
  rightRun: string,
  leftReview: string,
  rightReview: string,
): string {
  const left = sqlAlias(leftRun)
  sqlAlias(rightRun)
  const leftChange = sqlAlias(leftReview)
  const rightChange = sqlAlias(rightReview)
  return `CASE
  WHEN ${left}.lens IS NOT NULL AND ${leftChange}.patch_id IS NOT NULL
       AND ${rightChange}.patch_id IS NOT NULL
    THEN 'same task prompt and lens; same change'
  WHEN ${left}.lens IS NOT NULL
    THEN 'same task prompt and lens; at least one change unrecorded'
  WHEN ${leftChange}.patch_id IS NOT NULL AND ${rightChange}.patch_id IS NOT NULL
    THEN 'same task prompt; same change'
  ELSE 'same task prompt; at least one change unrecorded'
END`
}

export type RunTotals = {
  runs: number
  scored: number
  voided: number
  failed: number
  stale_n: number
  toks: number
  unscored: number
}

/**
 * Doctor and `state().totals` both read this. Window with `sinceIso` the
 * same way `unscoredCount` does; omit it for the lifetime counts doctor
 * prints.
 */
export function runTotals(sinceIso?: string): RunTotals {
  const row = db()
    .query(
      // COALESCE on every SUM: over an empty window SUM returns NULL, not zero,
      // while COUNT returns zero — so a quiet day answered `failed: null` beside
      // `runs: 0`. The page coerces it, but an API that reports "no failures" as
      // null is one bad `??` away from reporting it as "unknown".
      `SELECT COUNT(*) runs,
            COALESCE(SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END), 0) failed,
            COALESCE(SUM(CASE WHEN r.status='stale' THEN 1 ELSE 0 END), 0) stale_n,
            COALESCE(SUM(COALESCE(r.vendor_tokens,0)), 0) toks,
            COALESCE(SUM(CASE WHEN ${SCORED_EVIDENCE_SQL} THEN 1 ELSE 0 END), 0) scored,
            COALESCE(SUM(CASE WHEN ${VOIDED_SQL} THEN 1 ELSE 0 END), 0) voided
       FROM run r LEFT JOIN score s ON s.run_id = r.id
      WHERE ${nonHookTreeStatsSql('r')}${sinceIso ? ' AND r.started_at >= ?' : ''}`,
    )
    .get(...(sinceIso ? [sinceIso] : [])) as Omit<RunTotals, 'unscored'>
  return { ...row, unscored: unscoredCount(sinceIso) }
}

/** Join the one score owned by a conversation root to any of its turns. */
export function chainScoreJoin(runAlias: string, scoreAlias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(runAlias) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(scoreAlias)) {
    throw new Error('chain score aliases must be SQL identifiers')
  }
  return (
    `LEFT JOIN score ${scoreAlias} ON ${scoreAlias}.run_id = ` +
    `COALESCE(${runAlias}.parent_run_id, ${runAlias}.id)`
  )
}

export function pendingForSession(sid: string | null) {
  if (!sid) return []
  return db()
    .query(
      `SELECT r.id, r.agent, r.job, r.repo, COALESCE(r.label, r.prompt_head) AS prompt_head,
            CASE WHEN s.delivery IS NOT NULL THEN 1 ELSE 0 END AS rescore
       FROM run r LEFT JOIN score s ON s.run_id = r.id
      WHERE r.session_id = ? AND ${UNSCORED_WHERE}
      ORDER BY r.id`,
    )
    .all(sid) as {
    id: number
    agent: string
    job: string
    repo: string | null
    prompt_head: string
    rescore: number
  }[]
}

/** How many runs are owed a judgement, by the same rule, across every session. */
export function unscoredCount(sinceIso?: string): number {
  return (
    db()
      .query(
        `SELECT COUNT(*) n FROM run r LEFT JOIN score s ON s.run_id = r.id
      WHERE ${UNSCORED_WHERE}${sinceIso ? ' AND r.started_at >= ?' : ''}`,
      )
      .get(...(sinceIso ? [sinceIso] : [])) as { n: number }
  ).n
}

/**
 * Raised from 30 minutes when jobs gained their own bounds.
 *
 * Every bound must sit below this, or a run still working is swept out from
 * under a live process — which is why the suite asserts it. `implement` runs to
 * 45 minutes because building and then verifying a real change takes longer
 * than any review does.
 *
 * The cost of raising it is small: `reapStale` reaps a dead pid immediately
 * whatever the age, so this cutoff only governs rows whose pid is unknown or
 * recycled, and those are the cases where waiting longer is the safer error.
 */
