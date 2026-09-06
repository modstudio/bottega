import { AGENTS } from './agents.ts'
import { chainTerminationAt, db, weigh } from './db.ts'
import { COOLS_DOWN } from './failure.ts'
import { JOBS } from './jobs.ts'
import {
  COOLDOWN_MIN, MIN_SAMPLE, OUTPUT_RESERVE, PROMPT_SIZE_BOUNDARY,
  currentPolicySelection, isRoutingEvidence, median, routingEvidenceWindow, thompsonRank,
} from './route.ts'

export const ROUTING_BACKTEST_SEED = 287
export const ROUTING_BACKTEST_SEEDS = Object.freeze(Array.from({ length: 20 }, (_, i) => i + 1))

type Event = {
  id: number; agent: string; job: string; stack: string | null; model: string | null
  promptBytes: number; startedAt: string; latencyMs: number | null
  status: string; failureKind: string | null; weight: number; none: boolean; scored: boolean
  /** When this result first existed for a live routing decision to observe. */
  evidenceAt: string | null
}

type OperationalEvent = {
  id: number
  agent: string
  status: string
  failureKind: string | null
  finishedAt: string
}

type ReplayOptions = { includeVoided?: boolean; cooldowns?: boolean }

type History = Event[]
type PolicyChoice = { agent: string; expected: string }

export type BacktestJob = {
  job: string
  runs: number
  agreements: number
  differences: number
  agreementShare: number
  thompsonExplorationShare: number
  currentSelections: Record<string, number>
  thompsonSelections: Record<string, number>
}

export type RoutingBacktest = {
  seed: number
  /** Earlier judgement/dispatch pairs excluded because the judgement did not exist yet. */
  causalExcludedJudgements: number
  unscoredDecisions: number
  jobs: BacktestJob[]
}

export type RoutingBacktestEnsemble = {
  seeds: readonly number[]
  jobs: BacktestJob[]
  trajectories: RoutingBacktest[]
}

/** Mulberry32: compact, stable across runtimes, and sufficient for replay draws. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function staticEligible(agent: string, jobName: string, promptBytes: number): boolean {
  const a = AGENTS[agent]
  const j = JOBS[jobName]
  if (!a || !j || a.billing === 'metered' || promptBytes > a.maxPromptBytes) return false
  if (a.contextTokens < j.contextTokens + OUTPUT_RESERVE) return false
  return !Object.entries(j.needs).some(([cap, need]) => need && !a.caps[cap as keyof typeof a.caps])
}

function cooling(agent: string, at: Event, operations: OperationalEvent[], enabled: boolean): boolean {
  if (!enabled) return false
  const terminal = operations.filter((event) => event.agent === agent && event.finishedAt <= at.startedAt)
  const latest = terminal
    .filter((event) => event.status === 'failed' && COOLS_DOWN.includes(event.failureKind as typeof COOLS_DOWN[number]))
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || b.id - a.id)[0]
  if (!latest) return false
  if (terminal.some((event) => event.status === 'ok' && event.finishedAt > latest.finishedAt)) return false
  return Date.parse(at.startedAt) - Date.parse(latest.finishedAt) < COOLDOWN_MIN * 60_000
}

function priorLatency(agent: string, event: Event, history: History, stack?: string | null): number | null {
  const small = event.promptBytes < PROMPT_SIZE_BOUNDARY
  return median(history.filter((row) =>
    row.agent === agent && row.job === event.job && row.status === 'ok' && row.latencyMs !== null &&
    (row.promptBytes < PROMPT_SIZE_BOUNDARY) === small && (!stack || row.stack === stack),
  ).map((row) => row.latencyMs!))
}

type Cell = {
  agent: string; events: Event[]; scored: number; failures: number; none: number
  evidence: number; score: number | null; shrunk: number | null
  free: boolean; latencyMs: number | null
}

function cellsFor(event: Event, history: History, operations: OperationalEvent[], cooldowns: boolean): Cell[] {
  const bucket = (e: Event) => e.promptBytes < PROMPT_SIZE_BOUNDARY
  const sameBucket = history.filter((e) => e.job === event.job && bucket(e) === bucket(event))
  const build = (stack?: string | null) => Object.keys(AGENTS)
    .filter((agent) => staticEligible(agent, event.job, event.promptBytes) && !cooling(agent, event, operations, cooldowns))
    .map((agent) => {
      const currentModel = AGENTS[agent]!.model
      const window = routingEvidenceWindow(
        sameBucket.filter((e) => !stack || e.stack === stack), agent, currentModel,
      )
      const evidence = window.rows
      const scored = evidence.filter((event) => event.scored).length
      return {
        agent, events: evidence, scored,
        failures: evidence.length - scored,
        none: evidence.filter((event) => event.scored && event.none).length,
        evidence: evidence.length,
        score: evidence.length ? evidence.reduce((sum, e) => sum + e.weight, 0) / evidence.length : null,
        shrunk: null as number | null,
        free: ['free', 'local'].includes(AGENTS[agent]!.billing),
        latencyMs: priorLatency(agent, event, history, stack),
      } satisfies Cell
    })
  let cells = build(event.stack)
  const proven = cells.filter((c) => c.evidence >= MIN_SAMPLE)
  if (!event.stack || (proven.length < 2 && !(cells.length === 1 && proven.length === 1))) cells = build()
  const scores = cells.filter((c) => c.evidence >= MIN_SAMPLE && c.score !== null).map((c) => c.score!)
  const prior = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.5
  for (const c of cells) if (c.score !== null) {
    c.shrunk = (c.score * c.evidence + MIN_SAMPLE * prior) / (c.evidence + MIN_SAMPLE)
  }
  return cells
}

function currentChoice(
  event: Event, history: History, operations: OperationalEvent[], rng: () => number, draw: boolean,
  cooldowns: boolean,
): { agent: string } {
  const cells = cellsFor(event, history, operations, cooldowns)
  return { agent: currentPolicySelection(cells, JOBS[event.job]!.prefer, draw, rng).chosen.agent }
}

function thompsonChoice(
  event: Event, history: History, operations: OperationalEvent[], rng: () => number, draw: boolean,
  cooldowns: boolean,
): PolicyChoice {
  const cells = cellsFor(event, history, operations, cooldowns)
  const ranked = thompsonRank(cells.map((cell) => ({
    agent: cell.agent,
    evidence: cell.evidence,
    score: cell.score,
    free: cell.free,
    latencyMs: cell.latencyMs,
  })), draw, rng)
  return { agent: ranked.chosen.agent, expected: ranked.expected.agent }
}

function events(includeVoided = false): Event[] {
  type Row = Omit<Event, 'weight' | 'none' | 'scored' | 'evidenceAt'> & {
    delivery: Parameters<typeof weigh>[0] | null
    quality: Parameters<typeof weigh>[1]
    fidelity: Parameters<typeof weigh>[2]
    scoredAt: string | null
  }
  const database = db()
  const rows = database.query(
    `SELECT r.id, r.agent, r.job, r.stack, r.model, r.prompt_bytes AS promptBytes,
            r.started_at AS startedAt, r.latency_ms AS latencyMs, r.status,
            r.failure_kind AS failureKind,
            s.delivery, s.quality, s.fidelity, s.scored_at AS scoredAt
       FROM run r LEFT JOIN score s ON s.run_id=r.id
      WHERE r.parent_run_id IS NULL AND r.probe=0
        AND r.agent <> '(pending)'
        ${includeVoided
    ? "AND (r.evidence_excluded IS NULL OR r.evidence_excluded='voided with orch score --void')"
    : 'AND r.evidence_excluded IS NULL'}
      ORDER BY r.job, r.started_at, r.id`,
  ).all() as Row[]
  return rows.map((row) => {
    // Scored evidence did not exist until the person recorded the judgement.
    // An eligible unjudged failure existed when its chain terminated. Every
    // dispatch remains a decision even when it never becomes evidence.
    const evidenceAt = isRoutingEvidence({
      status: row.status, delivery: row.delivery, failureKind: row.failureKind,
    }) ? row.scoredAt ?? chainTerminationAt(database, row.id) : null
    return {
      id: row.id, agent: row.agent, job: row.job, stack: row.stack, model: row.model,
      promptBytes: row.promptBytes, startedAt: row.startedAt, latencyMs: row.latencyMs,
      status: row.status, failureKind: row.failureKind,
      weight: row.delivery === null ? weigh('none', null) : weigh(row.delivery, row.quality, row.fidelity),
      none: row.delivery === 'none', scored: row.delivery !== null, evidenceAt,
    }
  })
}

function operationalEvents(): OperationalEvent[] {
  const database = db()
  const rows = database.query(
    `SELECT id, agent, status, failure_kind AS failureKind, parent_run_id AS parentRunId,
            started_at AS startedAt, latency_ms AS latencyMs
       FROM run
      WHERE status IN ('ok','failed')
      ORDER BY started_at, id`,
  ).all() as Array<Omit<OperationalEvent, 'finishedAt'> & {
    parentRunId: number | null; startedAt: string; latencyMs: number | null
  }>
  return rows.flatMap((row) => {
    const finishedAt = row.parentRunId === null
      ? chainTerminationAt(database, row.id)
      : row.latencyMs === null ? null : new Date(Date.parse(row.startedAt) + row.latencyMs).toISOString()
    return finishedAt ? [{
      id: row.id, agent: row.agent, status: row.status, failureKind: row.failureKind, finishedAt,
    }] : []
  })
}

function replay(
  all: Event[], operations: OperationalEvent[], jobName: string | undefined, seed: number, cooldowns: boolean,
): RoutingBacktest {
  const jobs: BacktestJob[] = []
  let causalExcludedJudgements = 0
  const unscoredDecisions = all.filter(
    (event) => !event.scored && (!jobName || event.job === jobName),
  ).length
  const names = [...new Set(all.map((e) => e.job))].filter((name) => !jobName || name === jobName)
  for (const name of names) {
    const currentRng = seeded(seed ^ 0x43555252)
    const thompsonRng = seeded(seed ^ 0x54484f4d)
    let agreements = 0, thompsonExplores = 0
    const currentSelections: Record<string, number> = {}
    const thompsonSelections: Record<string, number> = {}
    const currentObserved: History = []
    const thompsonObserved: History = []
    // Detached workers reserve ids before they reset started_at at dispatch,
    // so only started_at is chronology; id breaks simultaneous-start ties.
    const rows = all.filter((e) => e.job === name)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id - b.id)
    for (const [index, event] of rows.entries()) {
      const earlier = rows.slice(0, index)
      causalExcludedJudgements += earlier.filter(
        (candidate) => candidate.evidenceAt !== null && candidate.evidenceAt >= event.startedAt,
      ).length
      const byAvailability = (a: Event, b: Event) => a.evidenceAt!.localeCompare(b.evidenceAt!) || a.id - b.id
      const currentHistory = currentObserved
        .filter((candidate) => candidate.evidenceAt !== null && candidate.evidenceAt < event.startedAt)
        .sort(byAvailability)
      const thompsonHistory = thompsonObserved
        .filter((candidate) => candidate.evidenceAt !== null && candidate.evidenceAt < event.startedAt)
        .sort(byAvailability)
      const current = currentChoice(event, currentHistory, operations, currentRng, true, cooldowns)
      const thompson = thompsonChoice(event, thompsonHistory, operations, thompsonRng, true, cooldowns)
      if (current.agent === thompson.agent) agreements++
      if (thompson.agent !== thompson.expected) thompsonExplores++
      currentSelections[current.agent] = (currentSelections[current.agent] ?? 0) + 1
      thompsonSelections[thompson.agent] = (thompsonSelections[thompson.agent] ?? 0) + 1
      // Logged outcomes are observable to a simulated policy only when that
      // policy chose the agent the historical dispatcher actually ran. A
      // disagreement has no counterfactual result for the road not taken.
      if (event.evidenceAt !== null && current.agent === event.agent) currentObserved.push(event)
      if (event.evidenceAt !== null && thompson.agent === event.agent) thompsonObserved.push(event)
    }
    jobs.push({
      job: name, runs: rows.length, agreements, differences: rows.length - agreements,
      agreementShare: rows.length ? agreements / rows.length : 0,
      thompsonExplorationShare: rows.length ? thompsonExplores / rows.length : 0,
      currentSelections, thompsonSelections,
    })
  }
  return { seed, causalExcludedJudgements, unscoredDecisions, jobs }
}

export function routingBacktest(
  jobName?: string, seed = ROUTING_BACKTEST_SEED, options: ReplayOptions = {},
): RoutingBacktest {
  return replay(events(options.includeVoided), operationalEvents(), jobName, seed, options.cooldowns !== false)
}

export function routingBacktestEnsemble(
  jobName?: string, options: ReplayOptions = {},
): RoutingBacktestEnsemble {
  const all = events(options.includeVoided)
  const operations = operationalEvents()
  const trajectories = ROUTING_BACKTEST_SEEDS.map((seed) =>
    replay(all, operations, jobName, seed, options.cooldowns !== false),
  )
  const names = [...new Set(trajectories.flatMap((trajectory) => trajectory.jobs.map((job) => job.job)))]
  const jobs = names.map((job) => {
    const rows = trajectories.map((trajectory) => trajectory.jobs.find((row) => row.job === job)!)
    const sumSelections = (key: 'currentSelections' | 'thompsonSelections') => rows.reduce<Record<string, number>>(
      (totals, row) => {
        for (const [agent, count] of Object.entries(row[key])) totals[agent] = (totals[agent] ?? 0) + count
        return totals
      },
      {},
    )
    const runs = rows.reduce((sum, row) => sum + row.runs, 0)
    const agreements = rows.reduce((sum, row) => sum + row.agreements, 0)
    return {
      job, runs, agreements, differences: runs - agreements,
      agreementShare: runs ? agreements / runs : 0,
      thompsonExplorationShare: runs
        ? rows.reduce((sum, row) => sum + row.thompsonExplorationShare * row.runs, 0) / runs
        : 0,
      currentSelections: sumSelections('currentSelections'),
      thompsonSelections: sumSelections('thompsonSelections'),
    }
  })
  return { seeds: ROUTING_BACKTEST_SEEDS, jobs, trajectories }
}
