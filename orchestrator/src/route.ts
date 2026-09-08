import { db, WEIGHT, FIDELITY_PENALTY, weigh } from './db.ts'
import { AGENTS, fileContractProbeReason, predatesFileContract, unavailableReason } from './agents.ts'
import { job, JOBS } from './jobs.ts'
import { COOLS_DOWN, NOT_EVIDENCE } from './failure.ts'
import { reviewCalibration } from './review.ts'
import { failingDefaultCanonEvals } from './canon-eval-status.ts'

export type Candidate = {
  agent: string
  runs: number
  /** Verdicts recorded against runs that produced an answer. */
  scored: number
  /**
   * Failed or abandoned runs that nobody judged explicitly.
   *
   * Excludes a failure someone scored, because that already counts under
   * `scored` — a run is one judgement, not two.
   */
  failures: number
  /** Explicit judgements whose delivery was none, used by the exploration filter. */
  none: number
  /**
   * Everything the router is entitled to count as a judgement about this agent:
   * explicit verdicts plus unjudged failures. This, not `scored`, is what
   * MIN_SAMPLE measures, and it never exceeds the number of runs behind it.
   */
  evidence: number
  /** Configured model whose evidence is used. Never another model's posterior. */
  evidenceModel: string | null
  /** Mean verdict weight, or null until anything has been judged. */
  score: number | null
  /** Score pulled toward the job-wide proven-agent mean by MIN_SAMPLE judgements. */
  shrunk: number | null
  /** Median run time for this job, robust to the one call that hung. */
  latencyMs: number | null
  tokens: number
  costUsd: number
  free: boolean
  eligible: boolean
  why: string
  /**
   * Set when the agent's most recent uncleared failure was something only a run
   * can detect — quota or stale auth — with how long ago it finished. Never set
   * for `unreachable`, which is measured directly on every routing decision and
   * needs no waiting out.
   */
  cooling: string | null
}

/**
 * How long to leave an agent alone after it runs out of quota or loses its
 * login. Nothing here can fix either, so continuing to route at it just
 * converts every job into a failed one. A success clears the state only when it
 * finished after the most recent cooling failure.
 */
export const COOLDOWN_MIN = 60

/** Below this many JUDGEMENTS — verdicts plus unjudged failures — a score is noise. */
export const MIN_SAMPLE = 5

/** Only this many of an agent's most recent judgements describe its current ability. */
export const EVIDENCE_WINDOW = 40

/**
 * The provisional boundary between small and large prompt evidence.
 *
 * Chosen from the observed file-question populations: small prompts topped out
 * at about 2.3 KiB and the problematic large inputs began around 25 KiB, with
 * no runs in between. 16 KiB sits in that wide empty gap, so the partition does
 * not depend on a finely tuned number. Revisit it when a run lands in the gap.
 */
export const PROMPT_SIZE_BOUNDARY = 16 * 1024

export type PromptSizeBucket = 'small' | 'large'

export function promptSizeBucket(promptBytes: number): PromptSizeBucket {
  return promptBytes < PROMPT_SIZE_BOUNDARY ? 'small' : 'large'
}

export function promptSizeBucketLabel(bucket: PromptSizeBucket): string {
  return bucket === 'small' ? '<16 KiB' : '>=16 KiB'
}

function promptBucketSql(alias: string, promptBytes: number): string {
  return promptSizeBucket(promptBytes) === 'small'
    ? `${alias}.prompt_bytes < ${PROMPT_SIZE_BOUNDARY}`
    : `${alias}.prompt_bytes >= ${PROMPT_SIZE_BOUNDARY}`
}

/** Populated buckets in stable size order; an untried job has none. */
export function promptBucketsForJob(jobName: string): PromptSizeBucket[] {
  const rows = db().query(
    `SELECT DISTINCT CASE WHEN prompt_bytes < ? THEN 'small' ELSE 'large' END AS bucket
       FROM run
      WHERE job = ? AND status IN ('ok','failed','stale') AND probe = 0
        AND evidence_excluded IS NULL AND parent_run_id IS NULL
        AND agent != '(pending)'`,
  ).all(PROMPT_SIZE_BOUNDARY, jobName) as { bucket: PromptSizeBucket }[]
  const have = new Set(rows.map((row) => row.bucket))
  return (['small', 'large'] as const).filter((bucket) => have.has(bucket))
}

/**
 * Room a job needs ON TOP OF its working set, for the model to answer in.
 *
 * The comparison used to be `job.contextTokens > agent.contextTokens`, which
 * admits an agent whose window is EXACTLY the size of the working set. That
 * reads as sufficient and is not: vLLM allows `max_model_len − prompt_tokens`
 * for the reply, so an agent that can just barely hold the job has nothing left
 * to say anything with. Run 279 is what that looks like — `finish_reason:
 * length`, `content: None`, 409s and 325k tokens spent thinking with no room
 * left to write the answer down.
 *
 * It went unnoticed because for most of this system's life the two numbers were
 * far apart (64K agent, 128K job). Serving the local model at 131,072 made them
 * equal, and equality silently re-admitted it to every deep job — the exact
 * outcome the ceiling had been introduced to prevent.
 *
 * 16K is a FLOOR read off that failure, not a measurement: a reasoning model's
 * think-then-answer for a review lens is comfortably five figures of tokens, and
 * nothing here has ever produced a useful reply in less. The honest way to
 * refine it is to record `finish_reason` per run and read the real distribution;
 * until then it is deliberately generous, because being wrong in this direction
 * costs an eligible agent and being wrong in the other costs a whole run.
 */
export const OUTPUT_RESERVE = 16_384

/** NOT_EVIDENCE as a SQL list, so the two definitions cannot drift apart. */
function notEvidenceSql(): string {
  return NOT_EVIDENCE.map((k) => `'${k}'`).join(', ')
}

export type RoutingEvidenceInput = {
  status: string
  delivery: string | null
  failureKind: string | null
}

/** The production quality-evidence predicate, shared with causal replay. */
export function isRoutingEvidence(row: RoutingEvidenceInput): boolean {
  if (!['ok', 'failed', 'stale'].includes(row.status)) return false
  if (NOT_EVIDENCE.includes(row.failureKind as typeof NOT_EVIDENCE[number])) return false
  return row.delivery !== null || ['failed', 'stale'].includes(row.status)
}

type RoutingWindowRow = {
  id: number
  agent: string
  model: string | null
  startedAt: string
}

/**
 * Production's evidence window: current model only, then dispatch chronology.
 * A swapped model starts a fresh posterior. Older-model rows never fill the
 * cell; the decaying exploration floor is what keeps a thin new model from
 * routing on noise.
 */
export function routingEvidenceWindow<T extends RoutingWindowRow>(
  rows: T[], agent: string, currentModel: string,
): { rows: T[]; evidenceModel: string | null } {
  const modelRows = rows.filter((row) =>
    row.agent === agent && (row.model === currentModel || row.model === null),
  )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id)
    .slice(0, EVIDENCE_WINDOW)
  return { rows: modelRows, evidenceModel: currentModel }
}

/** COOLS_DOWN as a SQL list, so the query uses the canonical vocabulary. */
function coolsDownSql(): string {
  return COOLS_DOWN.map((k) => `'${k}'`).join(', ')
}

/**
 * How often to spend a run on an agent that has not earned a score yet.
 *
 * Without this the first agent to reach MIN_SAMPLE is the only one that ever
 * scores again, so it owns the job for ever — no rival can be discovered and its
 * own decline cannot be noticed. Scoring exists to compare agents; a policy that
 * stops gathering comparisons defeats it.
 */
export const EXPLORE_RATE = 0.25

/** Keep testing proven challengers so a leader cannot hold the route forever. */
export const STANDING_EXPLORE_RATE = 0.10
export const STANDING_EXPLORE_FLOOR = 0.03

/** The leader's cell evidence decays the standing draw, without retiring it. */
export function standingExploreRate(leaderEvidence: number): number {
  return Math.max(
    STANDING_EXPLORE_FLOOR,
    STANDING_EXPLORE_RATE / Math.sqrt(leaderEvidence / MIN_SAMPLE),
  )
}

/**
 * The gap between two adjacent quality levels: right to mixed, mixed to wrong.
 *
 * Read off the matrix rather than written down, so it is still true if the
 * weights move.
 */
export const QUALITY_STEP = weigh('full', 'right') - weigh('full', 'mixed')

/**
 * Score difference below which two agents are treated as equally good.
 *
 * One quality step over MIN_SAMPLE runs moves the mean by 0.5/5 = 0.1, so a gap
 * smaller than that is not even one judgement's worth of evidence. Ranking on it
 * would be ranking on noise, which is what lets the cheaper or faster agent win
 * a tie honestly.
 *
 * This was `WEIGHT_MAX / MIN_SAMPLE / 2`, which gives the same 0.1 — by
 * coincidence. WEIGHT_MAX/2 is 0.5 and one quality step is also 0.5, so the two
 * agreed on today's numbers and would have parted company the moment anyone
 * touched the matrix, with the comment above still confidently describing the
 * old behaviour. A local review lens caught the smell and proposed scaling by
 * the full spread instead (−0.5 to 1, so 0.15); that is a different intent
 * again, and not the one written down. The band is one JUDGEMENT'S worth, so it
 * is derived from a judgement step.
 */
export const NOISE_BAND = QUALITY_STEP / MIN_SAMPLE

/** Linear width of the judgement-weight range mapped onto a Beta probability. */
export const BETA_SCALE = 1.5

/**
 * The shrunk-score noise band expressed on the [0, 1] posterior scale.
 * betaContribution maps one score unit across BETA_SCALE probability units.
 */
export const POSTERIOR_NOISE_BAND = NOISE_BAND / BETA_SCALE

export function betaContribution(weight: number): { successes: number; failures: number } {
  // Map the judgement range [-0.5, 1] linearly onto [0, 1]: `none` is one
  // whole failure and full/right is one whole success. Thus successes +=
  // (w + 0.5) / 1.5 and failures += 1 - that for every judgement.
  const successes = (weight + 0.5) / BETA_SCALE
  return { successes, failures: 1 - successes }
}

function normal(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

/** Marsaglia-Tsang gamma draw, including the standard alpha < 1 transform. */
function gamma(alpha: number, rng: () => number): number {
  if (alpha < 1) return gamma(alpha + 1, rng) * Math.pow(Math.max(rng(), Number.EPSILON), 1 / alpha)
  const d = alpha - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  while (true) {
    const x = normal(rng)
    const v0 = 1 + c * x
    if (v0 <= 0) continue
    const v = v0 ** 3
    const u = rng()
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

function beta(alpha: number, betaValue: number, rng: () => number): number {
  const x = gamma(Math.max(alpha, Number.EPSILON), rng)
  const y = gamma(Math.max(betaValue, Number.EPSILON), rng)
  return x / (x + y)
}

type ThompsonCandidate = Pick<Candidate, 'agent' | 'evidence' | 'score' | 'free' | 'latencyMs'> & {
  precision?: number | null
}

/** The one Thompson ranking used by every historical replay trajectory. */
export function thompsonRank<T extends ThompsonCandidate>(
  candidates: readonly T[], draw = true, rng: () => number = Math.random,
): { chosen: T; expected: T; posteriorMean: number; tied: number } {
  const field = candidates
    .filter((candidate) => candidate.evidence >= MIN_SAMPLE && candidate.score !== null)
    .map((candidate) => candidate.score!)
  const priorWeight = field.length ? field.reduce((a, b) => a + b, 0) / field.length : 0.5
  const priorSuccess = betaContribution(priorWeight).successes
  const posterior = candidates.map((candidate) => {
    const observed = betaContribution(candidate.score ?? 0)
    const successes = priorSuccess * MIN_SAMPLE + observed.successes * candidate.evidence
    const failures = (1 - priorSuccess) * MIN_SAMPLE + observed.failures * candidate.evidence
    const mean = successes / (successes + failures)
    return { candidate, mean, sample: draw ? beta(successes, failures, rng) : mean }
  })
  const tie = (a: typeof posterior[number], b: typeof posterior[number]) =>
    (a.candidate.precision === null || a.candidate.precision === undefined
      ? (b.candidate.precision === null || b.candidate.precision === undefined ? 0 : 1)
      : b.candidate.precision === null || b.candidate.precision === undefined
        ? -1
        : b.candidate.precision - a.candidate.precision) ||
    Number(b.candidate.free) - Number(a.candidate.free) ||
    (a.candidate.latencyMs ?? Infinity) - (b.candidate.latencyMs ?? Infinity) ||
    b.candidate.evidence - a.candidate.evidence ||
    a.candidate.agent.localeCompare(b.candidate.agent)
  const rank = (metric: 'mean' | 'sample') => {
    const leader = [...posterior].sort((a, b) => b[metric] - a[metric])[0]!
    const tied = posterior.filter((row) =>
      leader[metric] - row[metric] <= POSTERIOR_NOISE_BAND)
    return { row: tied.sort(tie)[0]!, tied: tied.length }
  }
  const expected = rank('mean')
  const chosen = rank('sample')
  return {
    chosen: chosen.row.candidate,
    expected: expected.row.candidate,
    posteriorMean: chosen.row.mean,
    tied: chosen.tied,
  }
}

/**
 * Build the SQL scoring expression from WEIGHT, so editing the matrix actually
 * moves routing rather than only changing what the CLI prints.
 *
 * A searched CASE rather than a simple one, because the weight now depends on
 * two columns. Unscored rows fall to the ELSE and contribute nothing, which is
 * what the separate scored/evidence counts are for.
 */
export function weightCase(): string {
  const arms: string[] = []
  for (const [delivery, row] of Object.entries(WEIGHT)) {
    if (typeof row === 'number') {
      arms.push(`WHEN s.delivery = '${delivery}' THEN ${row}`)
    } else {
      for (const [quality, w] of Object.entries(row)) {
        arms.push(`WHEN s.delivery = '${delivery}' AND s.quality = '${quality}' THEN ${w}`)
      }
    }
  }
  /**
   * The fidelity penalty is added HERE, in SQL, and not only in `weigh()`.
   *
   * Otherwise the axis would exist everywhere a person looks and nowhere the
   * router looks — which is the exact failure this file already carries a
   * section about: `orch stats`, the dashboard and the router each held their
   * own copy of the aggregate, and when one learned to count failures the
   * others did not follow. Built from FIDELITY_PENALTY for the same reason the
   * matrix above is built from WEIGHT: editing the constant has to move
   * routing, not just the printout.
   *
   * COALESCE to zero, so every score recorded before the axis existed — and
   * every read-only job, which is never judged on it — weighs exactly what it
   * always did.
   */
  const pen = Object.entries(FIDELITY_PENALTY)
    .map(([f, w]) => `WHEN s.fidelity = '${f}' THEN ${w}`)
    .join(' ')
  // CLAMPED TO THE SAME FLOOR as weigh(). Unclamped, partial/wrong/drifted
  // weighs less than "nothing arrived", so an agent that delivered something
  // unusable ranks below one that delivered nothing — and routing prefers the
  // agent that cannot do the job. `MAX` here must mirror the Math.max there;
  // two clamps that disagree is the drift this file already has a section about.
  const floor = WEIGHT.none as number
  return `MAX((CASE ${arms.join(' ')} ELSE 0 END) + (CASE ${pen} ELSE 0 END), ${floor})`
}

/**
 * Median, exported because the guide needs the same one.
 *
 * Median rather than mean throughout: one call that hung should not decide
 * anything. There were two identical copies of this; identical today is how a
 * pair of copies always starts.
 */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const v = [...xs].sort((a, b) => a - b)
  const mid = v.length >> 1
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2
}

/**
 * A run that produced nothing counts as `unusable`, because that is what it is.
 *
 * Filtering to `status='ok'` made failure invisible to routing: an agent that
 * fails most of the time but scores well on the few that land looked perfect.
 * `agy` on review-lens was one good verdict and two headless permission denials,
 * and the router saw a flawless record — while `unusable`, the verdict this
 * system already defines as "nothing came back to judge — a denied permission,
 * an empty reply, the wrong shape entirely", sat right there describing it.
 *
 * So a failed or abandoned run is folded into the mean at the `unusable` weight
 * rather than dropped. It costs the agent exactly what a human scoring the same
 * outcome would have cost it, and no separate reliability term has to be
 * invented or tuned.
 */
export function candidates(
  jobName: string, promptBytes = 0, stack?: string | null, modelOverride?: string,
  coolingProbeAgent?: string, lens?: string | null,
): Candidate[] {
  const j = job(jobName)
  // probe = 0: calibration traffic is deliberately trivial, so counting it would
  // let "reply with ok" vouch for an agent on real work.
  //
  // evidence_excluded IS NULL: a run whose output was destroyed by a bug of
  // ours is not evidence about the agent. Clock-named files collided; several
  // runs shared one output; the last to finish overwrote the rest; people then
  // scored the survivor as if it were each of them. NULL counts; any text is
  // the reason it does not. This is not `probe` — those were not calibration
  // runs, and overloading that flag would make the register lie about what
  // happened. The predicate lives HERE, next to the other evidence filters,
  // because this is the one query the router, the stats command and the
  // dashboard all share. A second copy is how they drifted last time.
  const rows = db()
    .query(
      `SELECT r.agent AS agent,
              SUM(CASE WHEN r.status = 'ok' THEN 1 ELSE 0 END) AS runs,
              SUM(CASE WHEN s.delivery IS NOT NULL
                        AND COALESCE(r.failure_kind, '') NOT IN (${notEvidenceSql()})
                       THEN 1 ELSE 0 END) AS scored,
              -- Only failures NOBODY JUDGED. A run contributes exactly one
              -- judgement: an explicit score if it has one, otherwise the
              -- implicit delivery=none that failing amounts to. Counting both
              -- made a single failed-and-scored run worth two — the weight came
              -- out the same, but the evidence count doubled, so an agent could
              -- cross MIN_SAMPLE on half the runs it should have needed.
              --
              -- An UNREACHABLE endpoint is excluded outright: a box that is
              -- switched off never ran at all, and charging it to the model
              -- makes an outage indistinguishable from incompetence. A
              -- CONTENT_REFUSAL is excluded for the parallel reason that it
              -- records vendor policy for a prompt class, not competence.
              -- Eleven hours of a powered-down local host put two failures
              -- against qwen-local on file-question, the one job it is
              -- measurably best at.
              --
              -- The same list gates EXPLICIT scores. Seven codex harness
              -- failures had been scored 'none' by hand and each counted as a
              -- -0.5 judgement against codex on review-lens - the outage rule,
              -- undone by whoever was tidying their pending list. A run that
              -- is not evidence is not evidence whoever looks at it.
              SUM(CASE WHEN r.status IN ('failed','stale') AND s.delivery IS NULL
                        AND COALESCE(r.failure_kind, '') NOT IN (${notEvidenceSql()})
                       THEN 1 ELSE 0 END) AS failures,
              SUM(CASE WHEN COALESCE(r.failure_kind, '') NOT IN (${notEvidenceSql()})
                       THEN ${weightCase()} ELSE 0 END) AS pts,
              SUM(CASE WHEN r.status = 'ok' THEN COALESCE(r.vendor_tokens, 0) ELSE 0 END) AS tokens,
              SUM(CASE WHEN r.status = 'ok' THEN COALESCE(r.vendor_cost_usd, 0) ELSE 0 END) AS cost
         FROM run r LEFT JOIN score s ON s.run_id = r.id
        -- Child turns are excluded: a conversation is ONE piece of evidence
        -- about an agent, and its root row carries the outcome. Counting each
        -- turn would let an agent cross MIN_SAMPLE by asking questions.
        WHERE r.job = ? AND r.status IN ('ok','failed','stale') AND r.probe = 0
          AND r.evidence_excluded IS NULL
          AND r.parent_run_id IS NULL
          AND ${promptBucketSql('r', promptBytes)}
          ${stack ? 'AND r.stack = ?' : ''}
          ${lens ? 'AND EXISTS (SELECT 1 FROM review_lens rl WHERE rl.run_id = r.id AND rl.lens = ?)' : ''}
        GROUP BY r.agent`,
    )
    .all(jobName, ...(stack ? [stack] : []), ...(lens ? [lens] : [])) as {
      agent: string; runs: number; scored: number; failures: number
      pts: number | null; tokens: number; cost: number
    }[]
  const hist = new Map(rows.map((r) => [r.agent, r]))

  const evidenceRows = (db()
    .query(
      `SELECT r.id, r.agent, r.model, r.started_at AS startedAt, r.status,
              r.failure_kind AS failureKind, s.delivery, ${weightCase()} AS pts
         FROM run r LEFT JOIN score s ON s.run_id = r.id
        WHERE r.job = ? AND r.status IN ('ok','failed','stale') AND r.probe = 0
          AND r.evidence_excluded IS NULL
          AND r.parent_run_id IS NULL
          AND ${promptBucketSql('r', promptBytes)}
          ${stack ? 'AND r.stack = ?' : ''}
          ${lens ? 'AND EXISTS (SELECT 1 FROM review_lens rl WHERE rl.run_id = r.id AND rl.lens = ?)' : ''}`,
    )
    .all(jobName, ...(stack ? [stack] : []), ...(lens ? [lens] : [])) as {
      id: number; agent: string; model: string | null; startedAt: string; status: string
      failureKind: string | null; delivery: string | null; pts: number | null
    }[]).filter(isRoutingEvidence)

  type Evidence = { scored: number; failures: number; none: number; pts: number }
  const aggregate = (rs: typeof evidenceRows): Evidence => ({
    scored: rs.filter((r) => r.delivery !== null).length,
    failures: rs.filter((r) => r.delivery === null).length,
    none: rs.filter((r) => r.delivery === 'none').length,
    pts: rs.reduce((sum, r) => sum + (r.pts ?? 0), 0),
  })

  const lat = db()
    .query(
      `SELECT agent, latency_ms FROM run
        -- Latency is per TURN here, deliberately: "how long does this agent
        -- take to answer" is a question about a turn, and a chain's total is a
        -- question about how much the architect had to be asked.
        WHERE job = ? AND status = 'ok' AND probe = 0 AND latency_ms IS NOT NULL
          AND ${promptBucketSql('run', promptBytes)}
          ${stack ? 'AND stack = ?' : ''}
          ${lens ? 'AND EXISTS (SELECT 1 FROM review_lens rl WHERE rl.run_id = run.id AND rl.lens = ?)' : ''}`,
    )
    .all(jobName, ...(stack ? [stack] : []), ...(lens ? [lens] : [])) as { agent: string; latency_ms: number }[]
  const latByAgent = new Map<string, number[]>()
  for (const r of lat) latByAgent.set(r.agent, [...(latByAgent.get(r.agent) ?? []), r.latency_ms])

  // Completion order matters here, not id order. Ids are assigned at launch,
  // so a later-id success can finish while an earlier-id fan-out sibling is
  // still running and then dying on quota. That success cannot clear a failure
  // which had not happened yet.
  //
  // PROBES ARE DELIBERATELY NOT EXCLUDED HERE, alone among the queries. A probe
  // is excluded everywhere that measures QUALITY, because "reply with ok" says
  // nothing about how good an agent is. Availability is a different question,
  // and a probe answers it exactly: it is the one thing that can tell this tool
  // a human has fixed the quota or the login, without waiting out the hour or
  // pretending a trivial reply was real work. Adding `AND probe = 0` here for
  // consistency would remove the only way to clear a cooldown.
  const coolingByAgent = new Map(
    (db().query(
      `WITH terminal AS (
         SELECT id, agent, status, failure_kind,
                julianday(started_at) + latency_ms / 86400000.0 AS finished_at
           FROM run
          WHERE status IN ('ok','failed') AND latency_ms IS NOT NULL
       ), cooling_failures AS (
         SELECT id, agent, failure_kind, finished_at,
                ROW_NUMBER() OVER (
                  PARTITION BY agent ORDER BY finished_at DESC, id DESC
                ) AS recency
           FROM terminal
          WHERE status = 'failed' AND failure_kind IN (${coolsDownSql()})
       )
       SELECT f.agent, f.failure_kind,
              (julianday('now') - f.finished_at) * 1440 AS mins_ago
         FROM cooling_failures f
        WHERE f.recency = 1
          AND (julianday('now') - f.finished_at) * 1440 < ?
          AND NOT EXISTS (
                SELECT 1 FROM terminal s
                 WHERE s.agent = f.agent AND s.status = 'ok'
                   AND s.finished_at > f.finished_at
              )`,
    ).all(COOLDOWN_MIN) as { agent: string; failure_kind: string; mins_ago: number }[])
      .map((r) => [r.agent, r]),
  )

  const result: Candidate[] = Object.keys(AGENTS).map((name) => {
    const a = AGENTS[name]!
    const currentModel = modelOverride ?? a.model
    const failure = coolingByAgent.get(name)
    const cooling = failure
      ? `${failure.failure_kind} ${Math.round(failure.mins_ago)}m ago`
      : null
    const h = hist.get(name)
    const window = routingEvidenceWindow(evidenceRows, name, currentModel)
    const recent = aggregate(window.rows)
    const scored = recent.scored
    const failures = recent.failures
    const evidence = scored + failures
    const score = evidence > 0
      ? (recent.pts + weigh('none', null) * failures) / evidence
      : null
    let eligible = true
    let why = ''
    const unavailable = unavailableReason(name)
    if (cooling && coolingProbeAgent !== name) {
      eligible = false
      why = `vendor ${cooling}; retry after ${COOLDOWN_MIN}m or run a successful probe to clear it`
    }
    else if (unavailable) { eligible = false; why = unavailable }
    else if (a.billing === 'metered') { eligible = false; why = 'metered billing' }
    else if (j.needs.readsRepo && !a.probedAt) {
      eligible = false
      why = 'unprobed agent is ineligible for repository jobs; run orch agent probe ' + name
    }
    else if (j.needs.readsRepo && predatesFileContract(a)) {
      eligible = false
      why = fileContractProbeReason(name)
    }
    else if (promptBytes > a.maxPromptBytes) {
      eligible = false
      why = `prompt ${Math.round(promptBytes / 1024)}KB exceeds its ${Math.round(a.maxPromptBytes / 1024)}KB argv limit`
    }
    // A window too small for the job is a capability the agent lacks, not a
    // quality it is weak at, so it is excluded here rather than ranked and
    // slowly discovered. Waiting for the score to notice costs a real run every
    // time: the local model was sent four review-lenses and an `understand`, and
    // between them they spent forty minutes and 1.8M vendor tokens to produce
    // three partial answers and two non-answers. The ceiling was knowable before
    // any of them started.
    else if (a.contextTokens < j.contextTokens + OUTPUT_RESERVE) {
      eligible = false
      why = `${Math.round(a.contextTokens / 1024)}K context is short of the ` +
            `~${Math.round(j.contextTokens / 1024)}K this job's working set needs ` +
            `plus ${Math.round(OUTPUT_RESERVE / 1024)}K to answer in`
    }
    else {
      for (const [cap, need] of Object.entries(j.needs)) {
        if (need && !a.caps[cap as keyof typeof a.caps]) { eligible = false; why = `lacks ${cap}`; break }
      }
    }
    return {
      agent: name,
      runs: h?.runs ?? 0,
      scored,
      failures,
      none: recent.none,
      evidence,
      evidenceModel: window.evidenceModel,
      score,
      shrunk: null,
      latencyMs: median(latByAgent.get(name) ?? []),
      tokens: h?.tokens ?? 0,
      costUsd: h?.cost ?? 0,
      // A local or free agent spends no metered quota, so on a genuine tie it
      // keeps the paid subscriptions in reserve for work that needs them.
      free: a.billing === 'local' || a.billing === 'free',
      eligible,
      why,
      cooling,
    }
  })

  const provenScores = result
    .filter((c) => c.evidence >= MIN_SAMPLE && c.score !== null)
    .map((c) => c.score!)
  const prior = provenScores.length
    ? provenScores.reduce((sum, score) => sum + score, 0) / provenScores.length
    : 0.5
  for (const c of result) {
    if (c.score !== null) {
      c.shrunk = (c.score * c.evidence + MIN_SAMPLE * prior) / (c.evidence + MIN_SAMPLE)
    }
  }
  return result
}

/** One row per job × agent that has any history, on the router's own maths. */
export type Scored = Candidate & { job: string; promptBucket: PromptSizeBucket }

/**
 * Every job × agent cell, scored exactly the way routing scores it.
 *
 * `orch stats` and the dashboard matrix each had their own copy of this query,
 * and both still filtered `status='ok'` after the router stopped: grok on
 * review-lens read 96% in both views and 69% to the thing actually choosing,
 * because 6 failures were invisible to the report and not to the decision. The
 * stats command even carried a comment saying it deliberately shared the
 * router's maths, which had stopped being true.
 *
 * So there is one implementation and the views call it. Ten small queries
 * rather than one grouped one, which is the price of not having a second
 * definition of the word "score".
 */
export function scoreboard(onlyJob?: string): Scored[] {
  return Object.keys(JOBS)
    .filter((j) => !onlyJob || j === onlyJob)
    .flatMap((j) => promptBucketsForJob(j).flatMap((bucket) =>
      candidates(j, bucket === 'small' ? 0 : PROMPT_SIZE_BOUNDARY)
        .filter((c) => c.runs > 0 || c.failures > 0)
        .map((c) => ({ ...c, job: j, promptBucket: bucket })),
    ))
}

/**
 * Pick by measured quality once there is enough signal, otherwise by the job's
 * declared preference. A score from two runs is noise, and routing on it would
 * lock in whichever agent happened to go first.
 *
 * Quality decides alone whenever the gap is real. Inside NOISE_BAND the
 * evidence does not separate the agents, so the tie goes to the one that costs
 * no quota, and then to the faster one — the two things measured on every run
 * that are facts rather than judgements.
 */
/**
 * Evidence for this job in one optional dimension, if there is enough of it,
 * else for the job anywhere.
 *
 * Agents are not uniformly good: one may be strong on PHP and weak on a Vue
 * component, and a router keyed only on job type averages those together into a
 * number that is true of neither. Keying on stack lets the difference show.
 *
 * THE BACKOFF IS THE WHOLE DESIGN, and without it this would be a mistake.
 * Routing already needs MIN_SAMPLE judgements before a score means anything,
 * and splitting the key multiplies the cells: a corpus that supports a handful
 * of job-level verdicts supports almost no stack-level ones, so every cell
 * would starve permanently and routing would fall back to declared preference
 * for ever — strictly worse than what it replaced. So the stack-specific cell
 * is used only once it has earned MIN_SAMPLE on its own, and until then the
 * job-wide evidence answers, exactly as it did before.
 *
 * Which level was used is returned, not inferred, because `orch pick` has to be
 * able to say WHY — a recommendation drawn from four PHP runs and one drawn
 * from thirty mixed ones deserve different amounts of trust, and only the
 * router knows which it gave you.
 */
export function evidenceFor(
  jobName: string, promptBytes: number, stack: string | null | undefined,
  modelOverride?: string, lens?: string | null,
): {
  cands: Candidate[]
  level: 'lens' | 'stack' | 'job'
  stack: string | null
  lens: string | null
  scoped: Candidate[] | null
  job: Candidate[]
} {
  const requested = lens?.trim() && job(jobName).findings
    ? { level: 'lens' as const, value: lens.trim() }
    : stack
      ? { level: 'stack' as const, value: stack }
      : null
  const jobWide = candidates(jobName, promptBytes, undefined, modelOverride)
  if (requested) {
    const scoped = requested.level === 'lens'
      ? candidates(jobName, promptBytes, undefined, modelOverride, undefined, requested.value)
      : candidates(jobName, promptBytes, requested.value, modelOverride)
    // `!c.cooling` too: pick() discards a cooling agent AFTER this decision, so
    // counting one here could narrow the scope on the strength of an agent that
    // is then thrown away — leaving a scoped view with a single usable
    // candidate, which is the very thing the two-agent rule exists to refuse.
    const eligible = scoped.filter((c) => c.eligible && !c.cooling)
    const proven = eligible.filter((c) => c.evidence >= MIN_SAMPLE && c.score !== null)
    /**
     * TWO proven agents, not one, and this is the subtle half of the rule.
     *
     * The point of the stack key is to COMPARE agents on that stack. One agent
     * over the threshold is not a comparison — it is a narrower evidence base
     * for a decision that would have been made anyway, and it is actively
     * worse than the job-wide view: an agent with thirty job-wide judgements
     * and three on this stack is demoted to "unproven" and loses to whichever
     * one happened to accumulate five here first. That is the incumbency
     * problem this file already solves for exploration, arriving by a
     * different door.
     *
     * The exception is a job only one agent can do at all, where there is no
     * comparison to lose and the narrower evidence is simply better evidence.
     */
    if (proven.length >= 2 || (eligible.length === 1 && proven.length === 1)) {
      return {
        cands: scoped, level: requested.level,
        stack: requested.level === 'stack' ? requested.value : null,
        lens: requested.level === 'lens' ? requested.value : null,
        scoped, job: jobWide,
      }
    }
    return {
      cands: jobWide, level: 'job',
      stack: requested.level === 'stack' ? requested.value : null,
      lens: requested.level === 'lens' ? requested.value : null,
      scoped, job: jobWide,
    }
  }
  return {
    cands: jobWide, level: 'job', stack: stack ?? null, lens: null,
    scoped: null, job: jobWide,
  }
}

type CurrentPolicyCandidate = Pick<
  Candidate, 'agent' | 'scored' | 'failures' | 'none' | 'evidence' | 'score' | 'shrunk' | 'free' | 'latencyMs'
> & { precision?: number | null }

/** Failure-only history has already answered whether another run is worthwhile. */
function worthExploring(c: CurrentPolicyCandidate): boolean {
  return !(
    (c.scored === 0 && c.failures > 0) ||
    (c.scored > 0 && c.none === c.scored)
  )
}

export type CurrentPolicySelection<T extends CurrentPolicyCandidate> = {
  chosen: T
  mode: 'challenger' | 'standing-challenger' | 'best' | 'preference' | 'only'
  tied: number
}

/**
 * The incumbent ranking policy, independent of where its evidence came from.
 *
 * Candidate order is meaningful: equally unproven challengers retain it after
 * the stable evidence-only sort. Both live routing and historical replay call
 * this function so the diagnostic cannot grow a second ordering policy.
 */
export function currentPolicySelection<T extends CurrentPolicyCandidate>(
  candidates: readonly T[], prefer: readonly string[], explore = true, rng: () => number = Math.random,
  explorationExcluded: ReadonlySet<string> = new Set(),
): CurrentPolicySelection<T> {
  const proven = candidates.filter((c) => c.evidence >= MIN_SAMPLE && c.score !== null)
  const unproven = candidates.filter((c) => c.evidence < MIN_SAMPLE)

  if (proven.length > 0) {
    const worthTrying = unproven.filter((candidate) =>
      worthExploring(candidate) && !explorationExcluded.has(candidate.agent))
    if (explore && worthTrying.length > 0 && rng() < EXPLORE_RATE) {
      const challenger = [...worthTrying].sort((a, b) => a.evidence - b.evidence)[0]!
      return { chosen: challenger, mode: 'challenger', tied: 0 }
    }
    const ranked = thompsonRank(proven, explore, rng)
    const best = ranked.chosen
    if (explore && unproven.length === 0 && proven.length === candidates.length &&
        rng() < standingExploreRate(best.evidence)) {
      const challenger = [...proven]
        .filter((c) => c.agent !== best.agent && worthExploring(c) && !explorationExcluded.has(c.agent))
        .sort((a, b) => a.evidence - b.evidence)[0]
      if (challenger) return { chosen: challenger, mode: 'standing-challenger', tied: ranked.tied }
    }
    return { chosen: best, mode: 'best', tied: ranked.tied }
  }
  for (const name of prefer) {
    const preferred = candidates.find((candidate) => candidate.agent === name)
    if (preferred) return { chosen: preferred, mode: 'preference', tied: 0 }
  }
  return { chosen: candidates[0]!, mode: 'only', tied: 0 }
}

export function pick(
  jobName: string,
  override?: string,
  promptBytes = 0,
  // Reporting views pass false: a guide that consumed the exploration coin
  // would name a different agent each time it was read, which is the opposite
  // of what someone consults it for.
  explore = true,
  stack?: string | null,
  /** Agents and effective models a fan-out has already used. */
  avoid: { agents?: string[]; models?: string[]; model?: string } = {},
  /** An explicit calibration probe may test whether its named agent recovered. */
  probe = false,
  /** Stable findings viewpoint used for reviewer-precision calibration. */
  lens?: string,
  rng: () => number = Math.random,
): { agent: string; reason: string } {
  const j = job(jobName)
  const ev = evidenceFor(jobName, promptBytes, stack, avoid.model, lens)
  const cands = ev.cands
  // Named in every reason below, so a route drawn from four PHP runs is never
  // mistaken for one drawn from thirty mixed ones.
  const evidenceCell = ev.level === 'lens'
    ? `lens ${ev.lens} cell`
    : ev.level === 'stack' ? `stack ${ev.stack} cell` : 'job-wide cell'
  const scope = (c: Candidate) => ` in ${evidenceCell}` +
    (c.evidenceModel ? ` on model ${c.evidenceModel}` : '')
  if (override) {
    if (avoid.agents?.includes(override)) {
      throw new Error(`--agent ${override} contradicts --avoid ${override}`)
    }
    // Keep candidates()' reporting view unchanged: cooling remains an exclusion
    // in guide and hub. Only this explicit probe route gets a candidate whose
    // other exclusions are evaluated without the cooling circuit in front.
    const probeCandidates = probe
      ? candidates(
          jobName, promptBytes, ev.level === 'stack' ? ev.stack : undefined,
          avoid.model, override, ev.level === 'lens' ? ev.lens : undefined,
        )
      : cands
    const c = probeCandidates.find((x) => x.agent === override)
    if (!c) throw new Error(`unknown agent "${override}"`)
    if (!c.eligible) throw new Error(`agent "${override}" not eligible for ${jobName}: ${c.why}`)
    return { agent: override, reason: 'explicit --agent' }
  }
  let eligible = cands.filter((c) => c.eligible)
  const excluded: string[] = []
  excluded.push(...cands.filter((c) => !c.eligible).map((c) => `${c.agent}: ${c.why}`))
  if (eligible.length === 0) {
    throw new Error(
      `no eligible agent for job "${jobName}"` +
      (excluded.length ? `; excluded agents: ${excluded.join('; ')}` : ''),
    )
  }
  /** Exclusions are instructions, not preferences. The caller must widen them. */
  const requested = new Set(avoid.agents ?? [])
  const models = new Set(avoid.models ?? [])
  const constrained = eligible.filter((c) =>
    !requested.has(c.agent) && !models.has(avoid.model ?? AGENTS[c.agent]!.model))
  if (!constrained.length && (requested.size > 0 || models.size > 0)) {
    const avoided = eligible.map((c) => {
      const reasons = []
      if (requested.has(c.agent)) reasons.push(`--avoid named ${c.agent}`)
      if (models.has(avoid.model ?? AGENTS[c.agent]!.model)) {
        reasons.push(`model ${avoid.model ?? AGENTS[c.agent]!.model} was excluded`)
      }
      return `${c.agent}: ${reasons.join(' and ')}`
    })
    throw new Error(
      `routing constraints leave no eligible agent for job "${jobName}"; ` +
      `excluded by constraint: ${avoided.join('; ')}` +
      (excluded.length ? `; already ineligible: ${excluded.join('; ')}` : '') +
      `. Widen --avoid or --distinct-from deliberately.`,
    )
  }
  eligible = constrained
  if (j.findings && lens?.trim()) {
    eligible = eligible.map((candidate) => ({
      ...candidate,
      precision: reviewCalibration(
        lens.trim(), candidate.agent, avoid.model ?? AGENTS[candidate.agent]!.model,
      ).precision,
    }))
  }
  const failingEvals = failingDefaultCanonEvals()
  const explorationExcluded = new Set(failingEvals.length ? [failingEvals[0]!.agent] : [])
  const notExplored = failingEvals.map((row) =>
    `${row.agent} not explored: failing canon eval ${row.slug}`)
  const withConstraint = (reason: string) => [reason, ...notExplored].join('; ')
  const selected = currentPolicySelection(eligible, j.prefer, explore, rng, explorationExcluded)
  const chosen = selected.chosen
  const policy = explore ? 'thompson' : 'mean'
  if (selected.mode === 'challenger') return {
    agent: chosen.agent,
    reason: withConstraint(
      `${policy}; challenger (${chosen.evidence}/${MIN_SAMPLE} judged${scope(chosen)}, exploring)`,
    ),
  }
  if (selected.mode === 'standing-challenger') return {
    agent: chosen.agent,
    reason: withConstraint(
      `${policy}; standing challenger (${chosen.evidence} judged${scope(chosen)}, exploring)`,
    ),
  }
  if (selected.mode === 'preference') return {
    agent: chosen.agent,
    reason: withConstraint(
      `${policy}; preference (only ${chosen.evidence} judged${scope(chosen)}, need ${MIN_SAMPLE})`,
    ),
  }
  if (selected.mode === 'only') {
    return { agent: chosen.agent, reason: withConstraint(`${policy}; only eligible agent in ${evidenceCell}`) }
  }
  const pct = `${(chosen.score! * 100).toFixed(0)}% (shrunk ${(chosen.shrunk! * 100).toFixed(0)}%) ` +
    `over ${chosen.evidence} judged${scope(chosen)}` +
    (chosen.failures ? ` (incl. ${chosen.failures} failed)` : '')
  const chosenPrecision = 'precision' in chosen && typeof chosen.precision === 'number'
    ? chosen.precision
    : null
  const precision = chosenPrecision !== null
    ? `; precision ${(chosenPrecision * 100).toFixed(0)}%`
    : ''
  if (selected.tied === 1) return {
    agent: chosen.agent, reason: withConstraint(`${policy}; best score ${pct}${precision}`),
  }
  const edge = chosenPrecision !== null
    ? `review precision ${(chosenPrecision * 100).toFixed(0)}%`
    : chosen.free ? 'costs no quota' : `fastest at ${Math.round((chosen.latencyMs ?? 0) / 1000)}s`
  return {
    agent: chosen.agent,
    reason: withConstraint(`${policy}; ${pct}, tied with ${selected.tied - 1} other — ${edge}`),
  }
}
