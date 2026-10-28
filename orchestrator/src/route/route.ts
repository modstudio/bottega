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
import { JOBS, job, jobContextBudget, OUTPUT_RESERVE } from '../jobs/jobs.ts'
import { decideMcpGrammarRuling, type RequiredMcpServer } from '../mcp/mcp-compatibility.ts'
import { latestMcpListing } from '../mcp/mcp-compatibility-record.ts'
import {
  type McpTransportPinFacts,
  requiredMcpIneligibility,
} from '../mcp/mcp-native-attachment.ts'
import { currentProjectRepository, type Project, projectByName } from '../project/projects.ts'
import type { SubscriptionCostContext } from '../run/run-subscription-cost.ts'
import { calibrationFor } from '../runtime/calibration-port.ts'
import { weigh } from '../score/score.ts'
import { median } from '../state/statistics.ts'
import { transportPinIneligibility } from '../transport/transport.ts'
import {
  type BillingKeyHold,
  billingKeyHoldRefusal,
  decideBillingKeyHolds,
} from './billing-key-hold.ts'
import { assertExternalDelegation, harnessSelection } from './harness-delegation.ts'
import {
  PROMPT_SIZE_BOUNDARY,
  type PromptSizeBucket,
  promptBucketSql,
  samePromptSizeBucket,
} from './prompt-size-bucket.ts'
import type { Candidate } from './route-candidate.ts'
import {
  attachRouteCosts,
  type CostPerAcceptedResult,
  routeCostFacts,
  routeCostPerAccepted,
} from './route-cost.ts'
import {
  appendCostPolicyReason,
  belowCostFloor,
  costPolicyExplanation,
  findingsPolicyLens,
  resolveRouteCostPolicy,
} from './route-cost-policy.ts'
import {
  enabledCostRule,
  prepareCostPolicy,
  readRouteCostPolicy,
} from './route-cost-policy-adapter.ts'
import { agentMeteredRouteEligibility } from './route-metered-policy-adapter.ts'
import {
  type CurrentPolicySelection,
  currentPolicySelection,
  MIN_SAMPLE,
  NOISE_BAND,
  weightCase,
} from './route-selection.ts'
import { aggregateEvidence, routingEvidenceWindow, runUsageMedians } from './route-statistics.ts'

export type { Candidate } from './route-candidate.ts'

import {
  type CoolingFailure,
  coolingPhrase,
  coolingRefusal,
  decideCoolingFailures,
  recentTerminalRuns,
} from './routing-cooldown.ts'
import { AgentCapacityError, RoutingRefusalError } from './routing-refusal.ts'
import { runningRunsByAgent } from './running-runs.ts'
import { trainingDataEligibility } from './training-data-eligibility.ts'

type RouteConstraints = {
  agents?: string[]
  models?: string[]
  model?: string
  noWaitCapacity?: boolean
  requiredMcp?: RequiredMcpServer
  pinnedTransport?: 'cli' | 'acp'
  transportPinSource?: McpTransportPinFacts['transportPinSource']
  project?: string | null
  routed?: RoutedSelection
}

type CandidateOptions = {
  stack?: string | null
  modelOverride?: string
  coolingProbeAgent?: string
  lens?: string | null
  requiredMcp?: RequiredMcpServer
  pinnedTransport?: 'cli' | 'acp'
  transportPinSource?: McpTransportPinFacts['transportPinSource']
  explicitlyNamedAgent?: string
  priceCost?: boolean
  projectName?: string | null
  repositoryReader?: (project: Pick<Project, 'path'>) => string | null
}

/**
 * How long to leave an agent alone after it runs out of quota or loses its
 * login. Nothing here can fix either, so continuing to route at it just
 * converts every job into a failed one. A success clears the state only when it
 * finished after the most recent cooling failure.
 */
export const COOLDOWN_MIN = 60

/** Below this many JUDGMENTS — verdicts plus unjudged failures — a score is noise. */
/** Only this many of an agent's most recent judgments describe its current ability. */
export const EVIDENCE_WINDOW = 40

function operationalRoutingRefusal(
  name: string,
  billingHold: BillingKeyHold | undefined,
  cooling: string | null,
  failure: CoolingFailure | undefined,
  probeAgent: string | undefined,
): string | null {
  if (probeAgent === name) return null
  if (billingHold) return billingKeyHoldRefusal(billingHold)
  return cooling && failure ? coolingRefusal(name, failure, COOLDOWN_MIN) : null
}

export function promptBucketsForJob(jobName: string): PromptSizeBucket[] {
  const rows = db()
    .query(
      `SELECT DISTINCT CASE WHEN prompt_bytes < ? THEN 'small' ELSE 'large' END AS bucket
         FROM run
        WHERE job = ? AND status IN ('ok','failed','stale') AND probe = 0
          AND evidence_excluded IS NULL AND executor <> 'harness'
          AND parent_run_record_id IS NULL AND agent != '(pending)'`,
    )
    .all(PROMPT_SIZE_BOUNDARY, jobName) as { bucket: PromptSizeBucket }[]
  const have = new Set(rows.map((row) => row.bucket))
  return (['small', 'large'] as const).filter((bucket) => have.has(bucket))
}

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

/**
 * A surface-routed pick's handoff value: which agent the pre-pick chose, why,
 * and the prompt size it ranked on.
 */
export type RoutedSelection = {
  agent: string
  reason: string
  /**
   * The prompt size this pick ranked on: the raw caller text for a detached
   * pre-pick, the composed pack for a run. The run honors the pick only when
   * this lands in the same prompt-size bucket as its own measurement.
   */
  promptBytes: number
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: one pass keeps candidate evidence and eligibility coherent
function candidatePass(jobName: string, promptBytes = 0, options: CandidateOptions = {}) {
  const {
    stack,
    modelOverride,
    coolingProbeAgent,
    lens,
    requiredMcp,
    pinnedTransport,
    transportPinSource,
    explicitlyNamedAgent,
    priceCost = false,
    projectName,
    repositoryReader = currentProjectRepository,
  } = options
  const j = job(jobName)
  const readCurrentRepository = memoizedRepositoryReader(repositoryReader)
  const { mcpListing, routeProject } = routingPassFacts(requiredMcp, projectName)
  // Probes and evidence-excluded runs do not establish agent quality.
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
              r.failure_kind AS failureKind, r.vendor_tokens AS vendorTokens,
              r.model_calls AS modelCalls, r.peak_call_tokens AS peakCallTokens,
              s.delivery, s.quality, s.fidelity, ${weightCase()} AS pts
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
      quality: string | null
      fidelity: string | null
      pts: number | null
      vendorTokens: number | null
      modelCalls: number | null
      peakCallTokens: number | null
    }[]
  ).filter(isRoutingEvidence)
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
  const agentList = Object.values(AGENTS)
  const terminalRuns = recentTerminalRuns(
    db(),
    agentList.map((agent) => agent.name),
  )
  const coolingByAgent = decideCoolingFailures(terminalRuns, COOLDOWN_MIN)
  const billingHoldByAgent = new Map(
    decideBillingKeyHolds(agentList, terminalRuns).flatMap((hold) =>
      hold.agents.map((agent) => [agent, hold] as const),
    ),
  )
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
    const billingHold = billingHoldByAgent.get(name)
    const operationalRefusal = operationalRoutingRefusal(
      name,
      billingHold,
      cooling,
      failure,
      coolingProbeAgent,
    )
    const h = hist.get(name)
    const window = routingEvidenceWindow(evidenceRows, name, currentModel, EVIDENCE_WINDOW)
    const recent = aggregateEvidence(window.rows)
    const { scored, failures } = recent
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
    } else if (operationalRefusal) {
      eligible = false
      why = operationalRefusal
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
    else if (a.contextTokens < jobContextBudget(j.contextTokens)) {
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
      usage: runUsageMedians(window.rows),
      costUsd: h?.cost ?? 0,
      // A free or no-cost agent spends no metered quota, so on a genuine tie it
      // keeps the paid subscriptions in reserve for work that needs them.
      free: a.billing === 'none' || a.billing === 'free',
      eligible,
      why,
      cooling,
      billingHold: billingHold ?? null,
      billingHoldRefusal: billingHold ? billingKeyHoldRefusal(billingHold) : null,
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
  attachRouteCosts(
    result,
    evidenceRows,
    { jobName, promptBytes, stack, lens },
    EVIDENCE_WINDOW,
    priceCost,
  )
  return { result, evidenceRows }
}

export function candidates(
  jobName: string,
  promptBytes = 0,
  options: CandidateOptions = {},
): Candidate[] {
  return candidatePass(jobName, promptBytes, options).result
}

/** One row per job × agent that has any history, on the router's own maths. */
export type Scored = Candidate & {
  job: string
  promptBucket: PromptSizeBucket
  costPerAccepted: CostPerAcceptedResult
  costPolicy: ReturnType<typeof resolveRouteCostPolicy>
  belowCostFloor: boolean
}

/** Every job × agent cell, scored exactly the way routing scores it. */
export function scoreboard(
  onlyJob?: string,
  subscriptionCost?: SubscriptionCostContext,
  lens?: string,
): Scored[] {
  const policy = readRouteCostPolicy()
  return Object.keys(JOBS)
    .filter((j) => !onlyJob || j === onlyJob)
    .flatMap((j) =>
      promptBucketsForJob(j).flatMap((bucket) =>
        (() => {
          const promptBytes = bucket === 'small' ? 0 : PROMPT_SIZE_BOUNDARY
          const cellLens = findingsPolicyLens(Boolean(job(j).findings), lens)
          const pass = candidatePass(j, promptBytes, { lens: cellLens })
          const costFacts = routeCostFacts({
            jobName: j,
            promptBytes,
            lens: cellLens,
            context: subscriptionCost,
          })
          const costPolicy = resolveRouteCostPolicy(
            policy,
            j,
            cellLens,
            Boolean(job(j).needs.writesRepo),
          )
          return pass.result
            .filter((c) => c.runs > 0 || c.failures > 0)
            .map((c) => ({
              ...c,
              job: j,
              promptBucket: bucket,
              costPolicy,
              belowCostFloor: belowCostFloor(c.shrunk, costPolicy.floor, NOISE_BAND),
              costPerAccepted: routeCostPerAccepted(
                j,
                routingEvidenceWindow(pass.evidenceRows, c.agent, c.evidenceModel!, EVIDENCE_WINDOW)
                  .rows,
                costFacts,
              ),
            }))
        })(),
      ),
    )
}

/**
 * Evidence for this job in one optional dimension, if there is enough of it,
 * else for the job anywhere.
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
  const jobWide = candidates(jobName, promptBytes, {
    modelOverride,
    requiredMcp,
    pinnedTransport,
    transportPinSource,
    projectName,
  })
  if (requested) {
    const scoped =
      requested.level === 'lens'
        ? candidates(jobName, promptBytes, {
            modelOverride,
            lens: requested.value,
            requiredMcp,
            pinnedTransport,
            transportPinSource,
            projectName,
          })
        : candidates(jobName, promptBytes, {
            stack: requested.value,
            modelOverride,
            requiredMcp,
            pinnedTransport,
            transportPinSource,
            projectName,
          })
    // A cooling candidate cannot establish that a scoped comparison is available.
    const eligible = scoped.filter((c) => c.eligible && !c.cooling)
    const proven = eligible.filter((c) => c.evidence >= MIN_SAMPLE && c.score !== null)
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
  routed: RoutedSelection | undefined,
  promptBytes: number,
): Candidate[] {
  if (!routed || !samePromptSizeBucket(routed.promptBytes, promptBytes)) return [...candidates]
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
  const rows = candidates(jobName, promptBytes, {
    stack: ev.level === 'stack' ? ev.stack : undefined,
    modelOverride: constraints.model,
    coolingProbeAgent: probe ? name : undefined,
    lens: ev.level === 'lens' ? ev.lens : undefined,
    requiredMcp: constraints.requiredMcp,
    pinnedTransport: constraints.pinnedTransport,
    transportPinSource: constraints.transportPinSource,
    explicitlyNamedAgent: name,
    projectName: constraints.project,
  })
  const candidate = rows.find((row) => row.agent === name)
  if (!candidate) throw new RoutingRefusalError(`unknown agent "${name}"`)
  return candidate
}

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
  promptBytes: number,
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
    return routeSurfaceSelection(constrained, constraints.routed, promptBytes)
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
  let eligible = admittedCandidates(jobName, ev.cands, avoid, promptBytes)
  if (j.findings && lens?.trim()) {
    eligible = eligible.map((candidate) => ({
      ...candidate,
      precision: calibrationFor(lens.trim(), candidate.agent, effectiveModel(candidate, avoid))
        .precision,
    }))
  }
  const preparedCostPolicy = prepareCostPolicy({
    job: jobName,
    lens: findingsPolicyLens(Boolean(j.findings), lens),
    writesRepo: Boolean(j.needs.writesRepo),
    explain: !explore,
    admitted: eligible,
    pricedRows: () =>
      candidates(jobName, promptBytes, {
        stack: ev.level === 'stack' ? ev.stack : undefined,
        lens: ev.level === 'lens' ? ev.lens : undefined,
        modelOverride: avoid.model,
        requiredMcp: avoid.requiredMcp,
        pinnedTransport: avoid.pinnedTransport,
        transportPinSource: avoid.transportPinSource,
        projectName: avoid.project,
        priceCost: true,
      }),
  })
  eligible = preparedCostPolicy.candidates
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
    enabledCostRule(preparedCostPolicy),
  )
  const chosen = selected.chosen
  const costReason = costPolicyExplanation({
    priced: preparedCostPolicy.priced,
    enabled: preparedCostPolicy.resolved.enabled,
    selected: selected as CurrentPolicySelection<
      Candidate & { costPerAccepted: CostPerAcceptedResult }
    >,
    hypothetical: () =>
      currentPolicySelection(
        preparedCostPolicy.candidates as Array<
          Candidate & { costPerAccepted: CostPerAcceptedResult }
        >,
        [...declaredPreferences, ...j.prefer],
        false,
        rng,
        explorationExcluded,
        new Set(declaredPreferences),
        {
          enabled: true,
          rate: preparedCostPolicy.resolved.rate,
          floor: preparedCostPolicy.resolved.floor,
        },
      ),
    resolved: preparedCostPolicy.resolved,
    lens: findingsPolicyLens(Boolean(j.findings), lens),
  })
  const policy = explore ? 'thompson' : 'mean'
  const carriedReason = (computed: string) => {
    const base = chosen.routedReason ?? withConstraint(computed)
    return appendCostPolicyReason(base, costReason, Boolean(chosen.routedReason))
  }
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
