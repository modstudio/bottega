import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import type { Agent } from '../agent/agents.ts'
import {
  fileContractProbeReason,
  predatesFileContract,
  unavailableReason,
} from '../agent/model-host.ts'
import { failingDefaultCanonEvals } from '../canon/canon-eval-status.ts'
import { db } from '../database/db.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { noEligibleAgentRefusal } from '../jobs/delegation.ts'
import { JOBS, job } from '../jobs/jobs.ts'
import { decideMcpGrammarRuling, type RequiredMcpServer } from '../mcp/mcp-compatibility.ts'
import { latestMcpListing } from '../mcp/mcp-compatibility-record.ts'
import {
  type McpTransportPinFacts,
  requiredMcpIneligibility,
} from '../mcp/mcp-native-attachment.ts'
import { currentProjectRepository, type Project, projectByName } from '../project/projects.ts'
import { calibrationFor } from '../runtime/calibration-port.ts'
import { FIDELITY_PENALTY, WEIGHT, weigh } from '../score/score.ts'
import { median } from '../state/statistics.ts'
import { transportPinIneligibility } from '../transport/transport.ts'
import { assertExternalDelegation, harnessSelection } from './harness-delegation.ts'
import {
  type PolicyCandidate,
  type PolicySelection,
  rankThompson,
  selectCurrentPolicy,
} from './route-policy.ts'
import { coolingFailures, coolingPhrase, coolingRefusal } from './routing-cooldown.ts'
import { AgentCapacityError, RoutingRefusalError } from './routing-refusal.ts'
import { runningRunsByAgent } from './running-runs.ts'
import { trainingDataEligibility } from './training-data-eligibility.ts'

export type Candidate = {
  agent: string
  runs: number
  /** Verdicts recorded against runs that produced an answer. */
  scored: number
  /**
   * Failed or abandoned runs that nobody judged explicitly.
   *
   * Excludes a failure someone scored, because that already counts under
   * `scored` — a run is one judgment, not two.
   */
  failures: number
  /** Explicit judgments whose delivery was none, used by the exploration filter. */
  none: number
  /**
   * Everything the router is entitled to count as a judgment about this agent:
   * explicit verdicts plus unjudged failures. This, not `scored`, is what
   * MIN_SAMPLE measures, and it never exceeds the number of runs behind it.
   */
  evidence: number
  /** Configured model whose evidence is used. Never another model's posterior. */
  evidenceModel: string | null
  /** Mean verdict weight, or null until anything has been judged. */
  score: number | null
  /** Score pulled toward the job-wide proven-agent mean by MIN_SAMPLE judgments. */
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
  declared: string[] | null
  preferred: boolean
  maxConcurrent: number | null
  runningRunIds: string[]
  routedReason?: string
}

type RouteConstraints = {
  agents?: string[]
  models?: string[]
  model?: string
  noWaitCapacity?: boolean
  requiredMcp?: RequiredMcpServer
  pinnedTransport?: 'cli' | 'acp'
  transportPinSource?: McpTransportPinFacts['transportPinSource']
  project?: string | null
  routed?: { agent: string; reason: string }
}

/**
 * How long to leave an agent alone after it runs out of quota or loses its
 * login. Nothing here can fix either, so continuing to route at it just
 * converts every job into a failed one. A success clears the state only when it
 * finished after the most recent cooling failure.
 */
export const COOLDOWN_MIN = 60

/** Below this many JUDGMENTS — verdicts plus unjudged failures — a score is noise. */
export const MIN_SAMPLE = 5

/** Only this many of an agent's most recent judgments describe its current ability. */
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

function memoizedRepositoryReader(
  reader: (project: Pick<Project, 'path'>) => string | null,
): (project: Pick<Project, 'path'>) => string | null {
  let currentRepository: string | null | undefined
  return (project) => {
    if (currentRepository === undefined) currentRepository = reader(project)
    return currentRepository
  }
}

function mcpCandidateIneligibility(
  agent: Pick<Agent, 'name' | 'harness' | 'defaultTransport' | 'mcpToolNamePattern'>,
  requiredMcp: RequiredMcpServer | undefined,
  listedTools: string[] | undefined,
  pinnedTransport?: 'cli' | 'acp',
  transportPinSource?: McpTransportPinFacts['transportPinSource'],
): string | null {
  const requiredWhy = requiredMcpIneligibility(agent, requiredMcp, {
    pinnedTransport,
    transportPinSource,
  })
  if (requiredWhy || !requiredMcp || !agent.mcpToolNamePattern) return requiredWhy
  return decideMcpGrammarRuling({
    mode: requiredMcp.mode,
    server: requiredMcp.server,
    listedTools,
    pattern: agent.mcpToolNamePattern,
  }).routingIneligibility
}

function applyMcpEligibility(
  eligible: boolean,
  why: string,
  mcpWhy: string | null,
): { eligible: boolean; why: string } {
  if (!eligible || !mcpWhy) return { eligible, why }
  return { eligible: false, why: mcpWhy }
}

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
  const rows = db()
    .query(
      `SELECT DISTINCT CASE WHEN prompt_bytes < ? THEN 'small' ELSE 'large' END AS bucket
       FROM run
      WHERE job = ? AND status IN ('ok','failed','stale') AND probe = 0
        AND evidence_excluded IS NULL AND executor <> 'harness' AND parent_run_record_id IS NULL
        AND agent != '(pending)'`,
    )
    .all(PROMPT_SIZE_BOUNDARY, jobName) as { bucket: PromptSizeBucket }[]
  const have = new Set(rows.map((row) => row.bucket))
  return (['small', 'large'] as const).filter((bucket) => have.has(bucket))
}

function routingPassFacts(
  requiredMcp: RequiredMcpServer | undefined,
  projectName: string | null | undefined,
): {
  mcpListing: ReturnType<typeof latestMcpListing>
  routeProject: Project | null
} {
  return {
    mcpListing: requiredMcp ? latestMcpListing(requiredMcp.projectId, requiredMcp.server) : null,
    routeProject: projectName ? projectByName(projectName) : null,
  }
}

/**
 * Room a job needs ON TOP OF its working set, for the model to answer in.
 *
 * Eligibility requires room beyond the working set: vLLM allows
 * `max_model_len − prompt_tokens` for the reply, so an agent that can just
 * barely hold the job has nothing left to say anything with.
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
  executor?: 'external' | 'harness'
}

/** The production quality-evidence predicate, shared with causal replay. */
export function isRoutingEvidence(row: RoutingEvidenceInput): boolean {
  if (row.executor === 'harness') return false
  if (!['ok', 'failed', 'stale'].includes(row.status)) return false
  if (NOT_EVIDENCE.includes(row.failureKind as (typeof NOT_EVIDENCE)[number])) return false
  return row.delivery !== null || ['failed', 'stale'].includes(row.status)
}

type RoutingWindowRow = {
  record_id: string
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
  rows: T[],
  agent: string,
  currentModel: string,
): { rows: T[]; evidenceModel: string | null } {
  const modelRows = rows
    .filter((row) => row.agent === agent && (row.model === currentModel || row.model === null))
    .sort(
      (a, b) => b.startedAt.localeCompare(a.startedAt) || b.record_id.localeCompare(a.record_id),
    )
    .slice(0, EVIDENCE_WINDOW)
  return { rows: modelRows, evidenceModel: currentModel }
}

/** How often to spend a run on an agent that has not earned a score yet. */
const EXPLORE_RATE = 0.25

/** Keep testing proven challengers so a leader cannot hold the route forever. */
export const STANDING_EXPLORE_RATE = 0.1
const STANDING_EXPLORE_FLOOR = 0.03

/** The leader's cell evidence decays the standing draw, without retiring it. */
export function standingExploreRate(leaderEvidence: number): number {
  return Math.max(
    STANDING_EXPLORE_FLOOR,
    STANDING_EXPLORE_RATE / Math.sqrt(leaderEvidence / MIN_SAMPLE),
  )
}

/** One adjacent quality step in the current judgment matrix. */
export const QUALITY_STEP = weigh('full', 'right') - weigh('full', 'mixed')
export const NOISE_BAND = QUALITY_STEP / MIN_SAMPLE
/** Linear width of the judgment-weight range mapped onto a Beta probability. */
export const BETA_SCALE = 1.5
export const POSTERIOR_NOISE_BAND = NOISE_BAND / BETA_SCALE

export function betaContribution(weight: number): { successes: number; failures: number } {
  const successes = (weight + 0.5) / BETA_SCALE
  return { successes, failures: 1 - successes }
}

type ThompsonCandidate = Pick<Candidate, 'agent' | 'evidence' | 'score' | 'free' | 'latencyMs'> & {
  precision?: number | null
}

/** The one Thompson ranking used by every historical replay trajectory. */
export function thompsonRank<T extends ThompsonCandidate>(
  candidates: readonly T[],
  draw = true,
  rng: () => number = Math.random,
): { chosen: T; expected: T; posteriorMean: number; tied: number } {
  return rankThompson(candidates, draw, rng, MIN_SAMPLE, betaContribution, POSTERIOR_NOISE_BAND)
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
   * section about: `bottega agent stats`, the dashboard and the router each held their
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
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: one pass keeps candidate evidence and eligibility coherent
export function candidates(
  jobName: string,
  promptBytes = 0,
  stack?: string | null,
  modelOverride?: string,
  coolingProbeAgent?: string,
  lens?: string | null,
  requiredMcp?: RequiredMcpServer,
  pinnedTransport?: 'cli' | 'acp',
  transportPinSource?: McpTransportPinFacts['transportPinSource'],
  explicitlyNamedAgent?: string,
  projectName?: string | null,
  repositoryReader: (project: Pick<Project, 'path'>) => string | null = currentProjectRepository,
): Candidate[] {
  const j = job(jobName)
  const readCurrentRepository = memoizedRepositoryReader(repositoryReader)
  const { mcpListing, routeProject } = routingPassFacts(requiredMcp, projectName)
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
              -- judgment: an explicit score if it has one, otherwise the
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
              -- against qwen36-goose on file-question, the one job it is
              -- measurably best at.
              --
              -- The same list gates EXPLICIT scores. Seven codex harness
              -- failures had been scored 'none' by hand and each counted as a
              -- -0.5 judgment against codex on review-lens - the outage rule,
              -- undone by whoever was tidying their pending list. A run that
              -- is not evidence is not evidence whoever looks at it.
              SUM(CASE WHEN r.status IN ('failed','stale') AND s.delivery IS NULL
                        AND COALESCE(r.failure_kind, '') NOT IN (${notEvidenceSql()})
                       THEN 1 ELSE 0 END) AS failures,
              SUM(CASE WHEN COALESCE(r.failure_kind, '') NOT IN (${notEvidenceSql()})
                       THEN ${weightCase()} ELSE 0 END) AS pts,
              SUM(CASE WHEN r.status = 'ok' THEN COALESCE(r.vendor_tokens, 0) ELSE 0 END) AS tokens,
              SUM(CASE WHEN r.status = 'ok' THEN COALESCE(r.vendor_cost_usd, 0) ELSE 0 END) AS cost
         FROM run r LEFT JOIN score s ON s.run_record_id = r.record_id
        -- Child turns are excluded: a conversation is ONE piece of evidence
        -- about an agent, and its root row carries the outcome. Counting each
        -- turn would let an agent cross MIN_SAMPLE by asking questions.
        WHERE r.job = ? AND r.status IN ('ok','failed','stale') AND r.probe = 0
          AND r.evidence_excluded IS NULL
          AND r.executor <> 'harness'
          AND r.parent_run_record_id IS NULL
          AND ${promptBucketSql('r', promptBytes)}
          ${stack ? 'AND r.stack = ?' : ''}
          ${lens ? 'AND EXISTS (SELECT 1 FROM review_lens rl WHERE rl.run_record_id = r.record_id AND rl.lens = ?)' : ''}
        GROUP BY r.agent`,
    )
    .all(jobName, ...(stack ? [stack] : []), ...(lens ? [lens] : [])) as {
    agent: string
    runs: number
    scored: number
    failures: number
    pts: number | null
    tokens: number
    cost: number
  }[]
  const hist = new Map(rows.map((r) => [r.agent, r]))
  const evidenceRows = (
    db()
      .query(
        `SELECT r.record_id, r.agent, r.model, r.started_at AS startedAt, r.status,
              r.executor,
              r.failure_kind AS failureKind, s.delivery, ${weightCase()} AS pts
         FROM run r LEFT JOIN score s ON s.run_record_id = r.record_id
        WHERE r.job = ? AND r.status IN ('ok','failed','stale') AND r.probe = 0
          AND r.evidence_excluded IS NULL
          AND r.executor <> 'harness'
          AND r.parent_run_record_id IS NULL
          AND ${promptBucketSql('r', promptBytes)}
          ${stack ? 'AND r.stack = ?' : ''}
          ${lens ? 'AND EXISTS (SELECT 1 FROM review_lens rl WHERE rl.run_record_id = r.record_id AND rl.lens = ?)' : ''}`,
      )
      .all(jobName, ...(stack ? [stack] : []), ...(lens ? [lens] : [])) as {
      record_id: string
      agent: string
      model: string | null
      startedAt: string
      status: string
      executor: 'external' | 'harness'
      failureKind: string | null
      delivery: string | null
      pts: number | null
    }[]
  ).filter(isRoutingEvidence)
  type Evidence = {
    scored: number
    failures: number
    none: number
    pts: number
  }
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
          ${lens ? 'AND EXISTS (SELECT 1 FROM review_lens rl WHERE rl.run_record_id = run.record_id AND rl.lens = ?)' : ''}`,
    )
    .all(jobName, ...(stack ? [stack] : []), ...(lens ? [lens] : [])) as {
    agent: string
    latency_ms: number
  }[]
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
  const coolingByAgent = coolingFailures(db(), COOLDOWN_MIN)
  const runningByAgent = runningRunsByAgent()
  const mcpIneligibility = (agent: Agent) =>
    mcpCandidateIneligibility(
      agent,
      requiredMcp,
      mcpListing?.listedTools,
      pinnedTransport,
      transportPinSource,
    )
  const policyEligibility = (agent: Agent) =>
    routePolicyEligibility(
      jobName,
      agent,
      explicitlyNamedAgent,
      pinnedTransport,
      projectName,
      routeProject,
      readCurrentRepository,
    )
  const result: Candidate[] = Object.keys(AGENTS).map((name) => {
    const a = AGENTS[name]!
    const currentModel = modelOverride ?? a.model
    const failure = coolingByAgent.get(name)
    const cooling = failure ? coolingPhrase(failure) : null
    const h = hist.get(name)
    const window = routingEvidenceWindow(evidenceRows, name, currentModel)
    const recent = aggregate(window.rows)
    const scored = recent.scored
    const failures = recent.failures
    const evidence = scored + failures
    const score = evidence > 0 ? (recent.pts + weigh('none', null) * failures) / evidence : null
    const mcpWhy = mcpIneligibility(a)
    const policy = policyEligibility(a)
    let eligible = true,
      why = policy.why
    const unavailable = unavailableReason(name)
    const runningRunIds = runningByAgent.get(name) ?? []
    const declared = a.jobs ?? null
    if (declared && !declared.includes(jobName)) {
      eligible = false
      why = `not declared for ${jobName}`
    } else if (cooling && coolingProbeAgent !== name) {
      eligible = false
      why = coolingRefusal(name, failure!, COOLDOWN_MIN)
    } else if (unavailable) {
      eligible = false
      why = unavailable
    } else if (!policy.eligible) {
      eligible = false
      why = policy.why
    } else if (!a.probedAt) {
      eligible = false
      why = `unprobed agent is ineligible for all jobs; run ${PLATFORM_SLUG} agent probe ${name}`
    } else if (predatesFileContract(a)) {
      eligible = false
      why = fileContractProbeReason(name)
    } else if (promptBytes > a.maxPromptBytes) {
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
      why =
        `${Math.round(a.contextTokens / 1024)}K context is short of the ` +
        `~${Math.round(j.contextTokens / 1024)}K this job's working set needs ` +
        `plus ${Math.round(OUTPUT_RESERVE / 1024)}K to answer in`
    } else {
      for (const [cap, need] of Object.entries(j.needs)) {
        if (need && !a.caps[cap as keyof typeof a.caps]) {
          eligible = false
          why = `lacks ${cap}`
          break
        }
      }
    }
    ;({ eligible, why } = applyMcpEligibility(eligible, why, mcpWhy))
    if (eligible && a.maxConcurrent && runningRunIds.length >= a.maxConcurrent) {
      eligible = false
      why = `at capacity (${a.maxConcurrent} running)`
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
      // A free or no-cost agent spends no metered quota, so on a genuine tie it
      // keeps the paid subscriptions in reserve for work that needs them.
      free: a.billing === 'none' || a.billing === 'free',
      eligible,
      why,
      cooling,
      declared,
      preferred: Boolean(a.preferredJobs?.includes(jobName)),
      maxConcurrent: a.maxConcurrent ?? null,
      runningRunIds,
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
export type Scored = Candidate & {
  job: string
  promptBucket: PromptSizeBucket
}

/**
 * Every job × agent cell, scored exactly the way routing scores it.
 *
 * `bottega agent stats` and the dashboard matrix each had their own copy of this query,
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
    .flatMap((j) =>
      promptBucketsForJob(j).flatMap((bucket) =>
        candidates(j, bucket === 'small' ? 0 : PROMPT_SIZE_BOUNDARY)
          .filter((c) => c.runs > 0 || c.failures > 0)
          .map((c) => ({ ...c, job: j, promptBucket: bucket })),
      ),
    )
}

/**
 * Pick by measured quality once there is enough signal, otherwise by the job's
 * declared preference. A score from two runs is noise, and routing on it would
 * lock in whichever agent happened to go first.
 *
 * Quality decides alone whenever the gap is real. Inside NOISE_BAND the
 * evidence does not separate the agents, so the tie goes to the one that costs
 * no quota, and then to the faster one — the two things measured on every run
 * that are facts rather than judgments.
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
 * Routing already needs MIN_SAMPLE judgments before a score means anything,
 * and splitting the key multiplies the cells: a corpus that supports a handful
 * of job-level verdicts supports almost no stack-level ones, so every cell
 * would starve permanently and routing would fall back to declared preference
 * for ever — strictly worse than what it replaced. So the stack-specific cell
 * is used only once it has earned MIN_SAMPLE on its own, and until then the
 * job-wide evidence answers, exactly as it did before.
 *
 * Which level was used is returned, not inferred, because `bottega agent pick` has to be
 * able to say WHY — a recommendation drawn from four PHP runs and one drawn
 * from thirty mixed ones deserve different amounts of trust, and only the
 * router knows which it gave you.
 */
export function evidenceFor(
  jobName: string,
  promptBytes: number,
  stack: string | null | undefined,
  options: {
    modelOverride?: string
    lens?: string | null
    requiredMcp?: RequiredMcpServer
    pinnedTransport?: 'cli' | 'acp'
    transportPinSource?: McpTransportPinFacts['transportPinSource']
    project: string | null | undefined
  },
): {
  cands: Candidate[]
  level: 'lens' | 'stack' | 'job'
  stack: string | null
  lens: string | null
  scoped: Candidate[] | null
  job: Candidate[]
} {
  const {
    lens,
    modelOverride,
    pinnedTransport,
    project: projectName,
    requiredMcp,
    transportPinSource,
  } = options
  const requested =
    lens?.trim() && job(jobName).findings
      ? { level: 'lens' as const, value: lens.trim() }
      : stack
        ? { level: 'stack' as const, value: stack }
        : null
  const jobWide = candidates(
    jobName,
    promptBytes,
    undefined,
    modelOverride,
    undefined,
    undefined,
    requiredMcp,
    pinnedTransport,
    transportPinSource,
    undefined,
    projectName,
  )
  if (requested) {
    const scoped =
      requested.level === 'lens'
        ? candidates(
            jobName,
            promptBytes,
            undefined,
            modelOverride,
            undefined,
            requested.value,
            requiredMcp,
            pinnedTransport,
            transportPinSource,
            undefined,
            projectName,
          )
        : candidates(
            jobName,
            promptBytes,
            requested.value,
            modelOverride,
            undefined,
            undefined,
            requiredMcp,
            pinnedTransport,
            transportPinSource,
            undefined,
            projectName,
          )
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
     * worse than the job-wide view: an agent with thirty job-wide judgments
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
        cands: scoped,
        level: requested.level,
        stack: requested.level === 'stack' ? requested.value : null,
        lens: requested.level === 'lens' ? requested.value : null,
        scoped,
        job: jobWide,
      }
    }
    return {
      cands: jobWide,
      level: 'job',
      stack: requested.level === 'stack' ? requested.value : null,
      lens: requested.level === 'lens' ? requested.value : null,
      scoped,
      job: jobWide,
    }
  }
  return {
    cands: jobWide,
    level: 'job',
    stack: stack ?? null,
    lens: null,
    scoped: null,
    job: jobWide,
  }
}

function evidenceForPick(
  jobName: string,
  promptBytes: number,
  stack: string | null | undefined,
  constraints: RouteConstraints,
  lens?: string,
) {
  return evidenceFor(jobName, promptBytes, stack, {
    modelOverride: constraints.model,
    lens,
    requiredMcp: constraints.requiredMcp,
    pinnedTransport: constraints.pinnedTransport,
    transportPinSource: constraints.transportPinSource,
    project: constraints.project,
  })
}

function evidenceCellName(ev: ReturnType<typeof evidenceFor>): string {
  if (ev.level === 'lens') return `lens ${ev.lens} cell`
  if (ev.level === 'stack') return `stack ${ev.stack} cell`
  return 'job-wide cell'
}

type CurrentPolicyCandidate = PolicyCandidate
export type CurrentPolicySelection<T extends CurrentPolicyCandidate> = PolicySelection<T>

/** The incumbent ranking policy, independent of where its evidence came from. */
export function currentPolicySelection<T extends CurrentPolicyCandidate>(
  candidates: readonly T[],
  prefer: readonly string[],
  explore = true,
  rng: () => number = Math.random,
  explorationExcluded: ReadonlySet<string> = new Set(),
  declaredPreferences: ReadonlySet<string> = new Set(),
): CurrentPolicySelection<T> {
  return selectCurrentPolicy(
    candidates,
    prefer,
    explore,
    rng,
    explorationExcluded,
    declaredPreferences,
    {
      minSample: MIN_SAMPLE,
      exploreRate: EXPLORE_RATE,
      standingExploreRate,
      rank: thompsonRank,
    },
  )
}

function capacityRefusal(
  candidate: Pick<Candidate, 'agent' | 'maxConcurrent' | 'runningRunIds'>,
): string {
  return (
    `agent ${candidate.agent} is at capacity ` +
    `(${candidate.maxConcurrent} running: ${candidate.runningRunIds.join(', ')})`
  )
}

function capacityCounts(
  candidates: readonly Pick<Candidate, 'agent' | 'runningRunIds'>[],
): Record<string, number> {
  return Object.fromEntries(
    candidates.map((candidate) => [candidate.agent, candidate.runningRunIds.length]),
  )
}

function routeSurfaceSelection(
  candidates: readonly Candidate[],
  routed: { agent: string; reason: string } | undefined,
): Candidate[] {
  if (!routed) return [...candidates]
  const candidate = candidates.find((item) => item.agent === routed.agent)
  return candidate ? [{ ...candidate, routedReason: routed.reason }] : [...candidates]
}

function namedCandidate(
  jobName: string,
  name: string,
  promptBytes: number,
  ev: ReturnType<typeof evidenceFor>,
  constraints: RouteConstraints,
  probe: boolean,
): Candidate {
  const rows = candidates(
    jobName,
    promptBytes,
    ev.level === 'stack' ? ev.stack : undefined,
    constraints.model,
    probe ? name : undefined,
    ev.level === 'lens' ? ev.lens : undefined,
    constraints.requiredMcp,
    constraints.pinnedTransport,
    constraints.transportPinSource,
    name,
    constraints.project,
  )
  const candidate = rows.find((row) => row.agent === name)
  if (!candidate) throw new RoutingRefusalError(`unknown agent "${name}"`)
  return candidate
}

/**
 * The model this request would run the candidate on: the caller's `--model` pin
 * wins over the agent's registered default. The capacity and avoidance filters
 * and the reviewer calibration lookup in `pick` ask the same question about the
 * same agent, so they resolve it here once.
 */
function effectiveModel(
  candidate: Pick<Candidate, 'agent'>,
  constraints: RouteConstraints,
): string {
  return constraints.model ?? AGENTS[candidate.agent]!.model
}

function admittedCandidates(
  jobName: string,
  candidates: Candidate[],
  constraints: RouteConstraints,
): Candidate[] {
  const requested = new Set(constraints.agents ?? [])
  const models = new Set(constraints.models ?? [])
  const blockedPreferred = candidates.find(
    (candidate) =>
      candidate.preferred &&
      candidate.why.startsWith('at capacity') &&
      candidate.maxConcurrent !== null &&
      candidate.runningRunIds.length >= candidate.maxConcurrent,
  )
  if (blockedPreferred && !constraints.noWaitCapacity) {
    throw new AgentCapacityError(
      `${capacityRefusal(blockedPreferred)}\n` +
        'invariant: a preferred local lane waits at its declared capacity instead of silently spending another lane\n' +
        'cleared by: wait for the named runs or pass --no-wait-capacity',
      capacityCounts([blockedPreferred]),
    )
  }
  const eligible = candidates.filter((candidate) => candidate.eligible)
  const excluded = candidates
    .filter((candidate) => !candidate.eligible)
    .map((candidate) => `${candidate.agent}: ${candidate.why}`)
  if (!eligible.length) {
    const capacityBlocked = candidates.filter(
      (candidate) =>
        candidate.why.startsWith('at capacity') &&
        !requested.has(candidate.agent) &&
        !models.has(effectiveModel(candidate, constraints)),
    )
    if (capacityBlocked.length)
      throw new AgentCapacityError(
        `waiting for capacity: ${capacityBlocked.map(capacityRefusal).join('; ')}`,
        capacityCounts(capacityBlocked),
      )
    throw new RoutingRefusalError(noEligibleAgentRefusal(jobName, job(jobName).needs, excluded))
  }
  const constrained = eligible.filter(
    (candidate) =>
      !requested.has(candidate.agent) && !models.has(effectiveModel(candidate, constraints)),
  )
  if (constrained.length || (!requested.size && !models.size))
    return routeSurfaceSelection(constrained, constraints.routed)
  const avoided = eligible.map((candidate) => {
    const model = effectiveModel(candidate, constraints)
    const reasons = []
    if (requested.has(candidate.agent)) reasons.push(`--avoid named ${candidate.agent}`)
    if (models.has(model)) reasons.push(`model ${model} was excluded`)
    return `${candidate.agent}: ${reasons.join(' and ')}`
  })
  throw new RoutingRefusalError(
    `routing constraints leave no eligible agent for job "${jobName}"; ` +
      `excluded by constraint: ${avoided.join('; ')}` +
      (excluded.length ? `; already ineligible: ${excluded.join('; ')}` : '') +
      `. Widen --avoid or --distinct-from deliberately.`,
  )
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
  avoid: RouteConstraints = {},
  /** An explicit calibration probe may test whether its named agent recovered. */
  probe = false,
  /** Stable findings viewpoint used for reviewer-precision calibration. */
  lens?: string,
  rng: () => number = Math.random,
  policy: { allowHarness: boolean } = { allowHarness: true },
): { agent: string; reason: string } {
  return (
    harnessSelection(jobName, policy.allowHarness) ??
    pickExternal(jobName, override, promptBytes, explore, stack, avoid, probe, lens, rng)
  )
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: routing presentation follows the pure admission and policy decisions
function pickExternal(
  jobName: string,
  override: string | undefined,
  promptBytes: number,
  explore: boolean,
  stack: string | null | undefined,
  avoid: RouteConstraints,
  probe: boolean,
  lens: string | undefined,
  rng: () => number,
): { agent: string; reason: string } {
  const j = job(jobName)
  assertExternalDelegation(jobName)
  const ev = evidenceForPick(jobName, promptBytes, stack, avoid, lens)
  // Named in every reason below, so a route drawn from four PHP runs is never
  // mistaken for one drawn from thirty mixed ones.
  const evidenceCell = evidenceCellName(ev)
  const scope = (c: Candidate) =>
    ` in ${evidenceCell}${c.evidenceModel ? ` on model ${c.evidenceModel}` : ''}`
  if (override) {
    if (avoid.agents?.includes(override)) {
      throw new Error(`--agent ${override} contradicts --avoid ${override}`)
    }
    // Keep candidates()' view unchanged. Naming bypasses opt-in; only a probe bypasses cooling.
    const c = namedCandidate(jobName, override, promptBytes, ev, avoid, probe)
    if (c.maxConcurrent !== null && c.runningRunIds.length >= c.maxConcurrent) {
      throw new AgentCapacityError(capacityRefusal(c), capacityCounts([c]))
    }
    if (!c.eligible)
      throw new RoutingRefusalError(`agent "${override}" not eligible for ${jobName}: ${c.why}`)
    return { agent: override, reason: 'explicit --agent' }
  }
  let eligible = admittedCandidates(jobName, ev.cands, avoid)
  if (j.findings && lens?.trim()) {
    eligible = eligible.map((candidate) => ({
      ...candidate,
      precision: calibrationFor(lens.trim(), candidate.agent, effectiveModel(candidate, avoid))
        .precision,
    }))
  }
  const failingEvals = failingDefaultCanonEvals()
  const explorationExcluded = new Set(failingEvals.length ? [failingEvals[0]!.agent] : [])
  const notExplored = failingEvals.map(
    (row) => `${row.agent} not explored: failing canon eval ${row.slug}`,
  )
  // A prefer name with no registry row is skipped, not fatal; name it so the skip is visible.
  const unresolvedPrefer = j.prefer
    .filter((name) => !AGENTS[name])
    .map((name) => `prefer ${name}: no registered agent`)
  const withConstraint = (reason: string) =>
    [reason, ...unresolvedPrefer, ...notExplored].join('; ')
  const declaredPreferences = eligible
    .filter((candidate) => candidate.preferred)
    .map((candidate) => candidate.agent)
  const selected = currentPolicySelection(
    eligible,
    [...declaredPreferences, ...j.prefer],
    explore,
    rng,
    explorationExcluded,
    new Set(declaredPreferences),
  )
  const chosen = selected.chosen
  const policy = explore ? 'thompson' : 'mean'
  /**
   * A routed pick already decided this route and stated why, so every mode
   * returns that reason instead of one recomputed for a comparison the routing
   * surface never made. `withConstraint` is the fallback for a pick that
   * computed its own reason.
   */
  const carriedReason = (computed: string) => chosen.routedReason ?? withConstraint(computed)
  if (selected.mode === 'challenger')
    return {
      agent: chosen.agent,
      reason: carriedReason(
        `${policy}; challenger (${chosen.evidence}/${MIN_SAMPLE} judged${scope(chosen)}, exploring)`,
      ),
    }
  if (selected.mode === 'standing-challenger')
    return {
      agent: chosen.agent,
      reason: carriedReason(
        `${policy}; standing challenger (${chosen.evidence} judged${scope(chosen)}, exploring)`,
      ),
    }
  if (selected.mode === 'preference')
    return {
      agent: chosen.agent,
      reason: carriedReason(
        `${policy}; preference (only ${chosen.evidence} judged${scope(chosen)}, need ${MIN_SAMPLE})`,
      ),
    }
  if (selected.mode === 'only') {
    return {
      agent: chosen.agent,
      reason: carriedReason(`${policy}; only eligible agent in ${evidenceCell}`),
    }
  }
  const pct =
    `${(chosen.score! * 100).toFixed(0)}% (shrunk ${(chosen.shrunk! * 100).toFixed(0)}%) ` +
    `over ${chosen.evidence} judged${scope(chosen)}` +
    (chosen.failures ? ` (incl. ${chosen.failures} failed)` : '')
  const chosenPrecision =
    'precision' in chosen && typeof chosen.precision === 'number' ? chosen.precision : null
  const precision =
    chosenPrecision !== null ? `; precision ${(chosenPrecision * 100).toFixed(0)}%` : ''
  if (selected.tied === 1)
    return {
      agent: chosen.agent,
      reason: carriedReason(`${policy}; best score ${pct}${precision}`),
    }
  const edge =
    chosenPrecision !== null
      ? `review precision ${(chosenPrecision * 100).toFixed(0)}%`
      : chosen.free
        ? 'costs no quota'
        : `fastest at ${Math.round((chosen.latencyMs ?? 0) / 1000)}s`
  return {
    agent: chosen.agent,
    reason: carriedReason(`${policy}; ${pct}, tied with ${selected.tied - 1} other — ${edge}`),
  }
}

export function meteredRouteEligibility(input: {
  billing: string
  routeMetered: boolean
  trainsOnInputs?: boolean
  writesRepo: boolean
  name: string
  explicitlyNamedAgent?: string
}): { eligible: boolean; why: string; mayAutoRouteNamedJob: boolean } {
  if (
    (input.billing !== 'metered' && !input.trainsOnInputs) ||
    input.explicitlyNamedAgent === input.name
  )
    return {
      eligible: true,
      why: '',
      mayAutoRouteNamedJob: input.explicitlyNamedAgent === input.name,
    }
  if (!input.routeMetered)
    return {
      eligible: false,
      why: input.trainsOnInputs
        ? 'a provider that may train on inputs is not opted in for automatic routing'
        : 'metered billing is not opted in for automatic routing',
      mayAutoRouteNamedJob: false,
    }
  if (input.writesRepo)
    return {
      eligible: false,
      why: 'metered routing opt-in is limited to jobs that do not write the repository',
      mayAutoRouteNamedJob: false,
    }
  return { eligible: true, why: '', mayAutoRouteNamedJob: true }
}

export function agentMeteredRouteEligibility(
  jobName: string,
  agent: Pick<Agent, 'billing' | 'routeMetered' | 'name' | 'trainsOnInputs'>,
  explicitlyNamedAgent?: string,
): ReturnType<typeof meteredRouteEligibility> {
  return meteredRouteEligibility({
    billing: agent.billing,
    routeMetered: Boolean(agent.routeMetered),
    trainsOnInputs: Boolean(agent.trainsOnInputs),
    writesRepo: Boolean(job(jobName).needs.writesRepo),
    name: agent.name,
    explicitlyNamedAgent,
  })
}

function routePolicyEligibility(
  jobName: string,
  agent: Pick<Agent, 'billing' | 'routeMetered' | 'name' | 'defaultTransport' | 'trainsOnInputs'>,
  explicitlyNamedAgent: string | undefined,
  pinnedTransport?: 'cli' | 'acp',
  projectName?: string | null,
  project: Project | null = projectName ? projectByName(projectName) : null,
  repositoryReader: (project: Pick<Project, 'path'>) => string | null = currentProjectRepository,
) {
  if (agent.trainsOnInputs && projectName === undefined) {
    return {
      eligible: false,
      why: 'eligible only on public projects',
      mayAutoRouteNamedJob: false,
    }
  }
  const training = trainingDataEligibility({
    agent: agent.name,
    trainsOnInputs: Boolean(agent.trainsOnInputs),
    project: project?.name ?? null,
    visibility: project?.settings.visibility ?? null,
    verifiedRepository: project?.settings.visibilityRepository ?? null,
    currentRepository:
      agent.trainsOnInputs && project?.settings.visibility === 'public'
        ? repositoryReader(project)
        : null,
  })
  if (!training.eligible) return { ...training, mayAutoRouteNamedJob: false }
  const metered = agentMeteredRouteEligibility(jobName, agent, explicitlyNamedAgent)
  if (!metered.eligible) return metered
  const transport = pinnedTransport ?? agent.defaultTransport
  const transportWhy =
    transport === 'acp'
      ? transportPinIneligibility(
          jobName,
          agent.name,
          AGENTS[agent.name]!,
          transport,
          explicitlyNamedAgent === agent.name,
          metered.mayAutoRouteNamedJob,
        )
      : pinnedTransport
        ? transportPinIneligibility(
            jobName,
            agent.name,
            AGENTS[agent.name]!,
            transport,
            explicitlyNamedAgent === agent.name,
            metered.mayAutoRouteNamedJob,
          )
        : null
  return transportWhy ? { ...metered, eligible: false, why: transportWhy } : metered
}

export function agentsIneligibleForTransport(jobName: string, transport: 'cli' | 'acp'): string[] {
  return Object.values(AGENTS)
    .filter((agent) => {
      const policy = agentMeteredRouteEligibility(jobName, agent)
      return (
        transportPinIneligibility(
          jobName,
          agent.name,
          agent,
          transport,
          false,
          policy.mayAutoRouteNamedJob,
        ) !== null
      )
    })
    .map((agent) => agent.name)
}
