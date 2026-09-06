import { AGENTS } from './agents.ts'
import { db, weigh } from './db.ts'
import { COOLS_DOWN, NOT_EVIDENCE } from './failure.ts'
import { JOBS } from './jobs.ts'
import {
  COOLDOWN_MIN, EVIDENCE_WINDOW, EXPLORE_RATE, MIN_SAMPLE, NOISE_BAND,
  OUTPUT_RESERVE, PROMPT_SIZE_BOUNDARY, STANDING_EXPLORE_RATE, median, thompsonRank,
} from './route.ts'

export const ROUTING_BACKTEST_SEED = 287
export const ROUTING_BACKTEST_SEEDS = Object.freeze(Array.from({ length: 20 }, (_, i) => i + 1))
export const ROUTING_BACKTEST_REQUIRED_PASSES = 16

type Event = {
  id: number; agent: string; job: string; stack: string | null; model: string | null
  promptBytes: number; startedAt: string; latencyMs: number | null
  status: string; failureKind: string | null; weight: number; none: boolean
  /** When this result first existed for a live routing decision to observe. */
  evidenceAt: string
}

type History = Event[]
type PolicyChoice = { agent: string; expected: string }

export type BacktestJob = {
  job: string
  runs: number
  agreements: number
  differences: number
  currentMatched: number
  thompsonMatched: number
  commonMatched: number
  currentMean: number | null
  thompsonMean: number | null
  currentExplorationShare: number
  thompsonExplorationShare: number
  measurable: boolean
  verdict: string
}

export type RoutingBacktest = {
  seed: number
  /** Earlier-id judgement/dispatch pairs excluded because the judgement did not exist yet. */
  causalExcludedJudgements: number
  jobs: BacktestJob[]
  trajectoryPass: boolean
}

export type RoutingBacktestEnsemble = {
  seeds: readonly number[]
  requiredPasses: number
  passCount: number
  jobs: { job: string; wins: number; ties: number; losses: number; unmeasurable: number }[]
  trajectories: RoutingBacktest[]
  shouldWire: boolean
}

export function passesRoutingBacktest(jobs: readonly BacktestJob[]): boolean {
  // A Thompson deficit no larger than NOISE_BAND is a tie, not a loss. One
  // trajectory passes only when every measurable job is a tie or win AND at
  // least one job is a win beyond that same band.
  const measurable = jobs.filter((job) => job.measurable)
  return measurable.length > 0 &&
    measurable.every((job) => job.thompsonMean! - job.currentMean! >= -NOISE_BAND) &&
    measurable.some((job) => job.thompsonMean! - job.currentMean! > NOISE_BAND)
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

function cooling(agent: string, at: Event): boolean {
  const kinds = COOLS_DOWN.map((kind) => `'${kind}'`).join(',')
  const row = db().query(
    `WITH terminal AS (
       SELECT id, status, failure_kind,
              julianday(started_at) + latency_ms / 86400000.0 AS finished_at
         FROM run
        WHERE id < ? AND agent=? AND status IN ('ok','failed') AND latency_ms IS NOT NULL
          AND julianday(started_at) + latency_ms / 86400000.0 <= julianday(?)
     ), latest AS (
       SELECT * FROM terminal WHERE status='failed' AND failure_kind IN (${kinds})
        ORDER BY finished_at DESC, id DESC LIMIT 1
     )
     SELECT finished_at,
            EXISTS(SELECT 1 FROM terminal s, latest f
                    WHERE s.status='ok' AND s.finished_at > f.finished_at) AS cleared
       FROM latest`,
  ).get(at.id, agent, at.startedAt) as { finished_at: number; cleared: number } | null
  if (!row || row.cleared) return false
  const atJulian = Date.parse(at.startedAt) / 86400000 + 2440587.5
  return (atJulian - row.finished_at) * 1440 < COOLDOWN_MIN
}

function priorLatency(agent: string, event: Event, stack?: string | null): number | null {
  const comparison = event.promptBytes < PROMPT_SIZE_BOUNDARY ? '<' : '>='
  const rows = db().query(
    `SELECT latency_ms FROM run
      WHERE id < ? AND agent=? AND job=? AND status='ok' AND probe=0
        AND latency_ms IS NOT NULL AND prompt_bytes ${comparison} ?
        ${stack ? 'AND stack=?' : ''}`,
  ).all(...(stack
    ? [event.id, agent, event.job, PROMPT_SIZE_BOUNDARY, stack]
    : [event.id, agent, event.job, PROMPT_SIZE_BOUNDARY])) as { latency_ms: number }[]
  return median(rows.map((row) => row.latency_ms))
}

type Cell = {
  agent: string; evidence: Event[]; score: number | null; shrunk: number | null
  free: boolean; latency: number | null
}

function cellsFor(event: Event, history: History): Cell[] {
  const bucket = (e: Event) => e.promptBytes < PROMPT_SIZE_BOUNDARY
  const sameBucket = history.filter((e) => e.job === event.job && bucket(e) === bucket(event))
  const build = (stack?: string | null) => Object.keys(AGENTS)
    .filter((agent) => staticEligible(agent, event.job, event.promptBytes) && !cooling(agent, event))
    .map((agent) => {
      let evidence = sameBucket.filter((e) => e.agent === agent && (!stack || e.stack === stack))
      const currentModel = AGENTS[agent]!.model
      const modelEvidence = evidence.filter((e) => e.model === currentModel)
      if (modelEvidence.length >= MIN_SAMPLE) evidence = modelEvidence
      evidence = evidence.slice(-EVIDENCE_WINDOW)
      return {
        agent, evidence,
        score: evidence.length ? evidence.reduce((sum, e) => sum + e.weight, 0) / evidence.length : null,
        shrunk: null as number | null,
        free: ['free', 'local'].includes(AGENTS[agent]!.billing),
        latency: priorLatency(agent, event, stack),
      } satisfies Cell
    })
  let cells = build(event.stack)
  const proven = cells.filter((c) => c.evidence.length >= MIN_SAMPLE)
  if (!event.stack || (proven.length < 2 && !(cells.length === 1 && proven.length === 1))) cells = build()
  const scores = cells.filter((c) => c.evidence.length >= MIN_SAMPLE && c.score !== null).map((c) => c.score!)
  const prior = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.5
  for (const c of cells) if (c.score !== null) {
    c.shrunk = (c.score * c.evidence.length + MIN_SAMPLE * prior) / (c.evidence.length + MIN_SAMPLE)
  }
  return cells
}

function factualOrder(a: Cell, b: Cell): number {
  return Number(b.free) - Number(a.free) || (a.latency ?? Infinity) - (b.latency ?? Infinity) ||
    b.evidence.length - a.evidence.length || a.agent.localeCompare(b.agent)
}

function currentChoice(event: Event, history: History, rng: () => number, draw: boolean): PolicyChoice {
  const cells = cellsFor(event, history)
  const proven = cells.filter((c) => c.evidence.length >= MIN_SAMPLE && c.score !== null)
  const unproven = cells.filter((c) => c.evidence.length < MIN_SAMPLE)
  if (proven.length) {
    const ranked = [...proven].sort((a, b) => b.shrunk! - a.shrunk!)
    const top = ranked[0]!.shrunk!
    const expected = ranked.filter((c) => top - c.shrunk! <= NOISE_BAND).sort(factualOrder)[0]!.agent
    if (draw) {
      const worthTrying = unproven.filter((c) => !(c.evidence.length && c.evidence.every((e) => e.none)))
        .sort((a, b) => a.evidence.length - b.evidence.length || factualOrder(a, b))
      if (worthTrying.length && rng() < EXPLORE_RATE) return { agent: worthTrying[0]!.agent, expected }
      if (!unproven.length && proven.length === cells.length && rng() < STANDING_EXPLORE_RATE) {
        const challenger = [...proven].filter((c) => c.agent !== expected).sort((a, b) => a.evidence.length - b.evidence.length || factualOrder(a, b))[0]
        if (challenger) return { agent: challenger.agent, expected }
      }
    }
    return { agent: expected, expected }
  }
  const expected = JOBS[event.job]!.prefer.find((name) => cells.some((c) => c.agent === name)) ?? cells.sort(factualOrder)[0]!.agent
  return { agent: expected, expected }
}

function thompsonChoice(event: Event, history: History, rng: () => number, draw: boolean): PolicyChoice {
  const cells = cellsFor(event, history)
  const ranked = thompsonRank(cells.map((cell) => ({
    agent: cell.agent,
    evidence: cell.evidence.length,
    score: cell.score,
    free: cell.free,
    latencyMs: cell.latency,
  })), draw, rng)
  return { agent: ranked.chosen.agent, expected: ranked.expected.agent }
}

function events(): Event[] {
  type Row = Omit<Event, 'weight' | 'none' | 'evidenceAt'> & {
    delivery: Parameters<typeof weigh>[0] | null
    quality: Parameters<typeof weigh>[1]
    fidelity: Parameters<typeof weigh>[2]
    scoredAt: string | null
  }
  const excluded = NOT_EVIDENCE.map((kind) => `'${kind}'`).join(',')
  const rows = db().query(
    `SELECT r.id, r.agent, r.job, r.stack, r.model, r.prompt_bytes AS promptBytes,
            r.started_at AS startedAt, r.latency_ms AS latencyMs, r.status,
            r.failure_kind AS failureKind,
            s.delivery, s.quality, s.fidelity, s.scored_at AS scoredAt
       FROM run r LEFT JOIN score s ON s.run_id=r.id
      WHERE r.parent_run_id IS NULL AND r.probe=0 AND r.evidence_excluded IS NULL
        AND r.status IN ('ok','failed','stale')
        AND COALESCE(r.failure_kind,'') NOT IN (${excluded})
        AND (s.delivery IS NOT NULL OR r.status IN ('failed','stale'))
      ORDER BY r.job, r.id`,
  ).all() as Row[]
  return rows.map((row) => {
    // Scored evidence did not exist until the person recorded the judgement.
    // An unjudged failure existed when its process terminated. NOT_EVIDENCE
    // rows are excluded by the query, and every remaining failure has latency.
    const evidenceAt = row.scoredAt ?? new Date(
      Date.parse(row.startedAt) + row.latencyMs!,
    ).toISOString()
    return {
      id: row.id, agent: row.agent, job: row.job, stack: row.stack, model: row.model,
      promptBytes: row.promptBytes, startedAt: row.startedAt, latencyMs: row.latencyMs,
      status: row.status, failureKind: row.failureKind,
      weight: row.delivery === null ? weigh('none', null) : weigh(row.delivery, row.quality, row.fidelity),
      none: row.delivery === null || row.delivery === 'none', evidenceAt,
    }
  })
}

function replay(all: Event[], jobName: string | undefined, seed: number): RoutingBacktest {
  const jobs: BacktestJob[] = []
  let causalExcludedJudgements = 0
  const names = [...new Set(all.map((e) => e.job))].filter((name) => !jobName || name === jobName)
  for (const name of names) {
    const currentRng = seeded(seed ^ 0x43555252)
    const thompsonRng = seeded(seed ^ 0x54484f4d)
    let agreements = 0, currentMatched = 0, thompsonMatched = 0, commonMatched = 0, commonTotal = 0
    let currentExplores = 0, thompsonExplores = 0
    const rows = all.filter((e) => e.job === name)
    for (const event of rows) {
      const earlier = rows.filter((candidate) => candidate.id < event.id)
      const history = earlier.filter((candidate) => candidate.evidenceAt < event.startedAt)
      causalExcludedJudgements += earlier.length - history.length
      const current = currentChoice(event, history, currentRng, true)
      const thompson = thompsonChoice(event, history, thompsonRng, true)
      if (current.agent === thompson.agent) agreements++
      if (current.agent !== current.expected) currentExplores++
      if (thompson.agent !== thompson.expected) thompsonExplores++
      if (current.agent === event.agent) currentMatched++
      if (thompson.agent === event.agent) thompsonMatched++
      if (current.agent === event.agent && thompson.agent === event.agent) {
        commonMatched++
        commonTotal += event.weight
      }
    }
    // The log has no propensities or counterfactual reward. Compare realised
    // scores only on common support: dispatches where BOTH policies chose the
    // historical agent. Both policies therefore receive the same observed
    // judgement, while their own match counts remain visible as a warning
    // about how much selective support was discarded.
    const currentMean = commonMatched ? commonTotal / commonMatched : null
    const thompsonMean = commonMatched ? commonTotal / commonMatched : null
    const measurable = commonMatched >= MIN_SAMPLE
    const delta = thompsonMean! - currentMean!
    const verdict = !measurable ? 'unmeasurable'
      : delta > NOISE_BAND ? 'win'
        : delta < -NOISE_BAND ? 'loss' : 'tie'
    jobs.push({
      job: name, runs: rows.length, agreements, differences: rows.length - agreements,
      currentMatched, thompsonMatched, commonMatched, currentMean, thompsonMean,
      currentExplorationShare: rows.length ? currentExplores / rows.length : 0,
      thompsonExplorationShare: rows.length ? thompsonExplores / rows.length : 0,
      measurable, verdict,
    })
  }
  const trajectoryPass = passesRoutingBacktest(jobs)
  return {
    seed, causalExcludedJudgements,
    jobs,
    trajectoryPass,
  }
}

export function routingBacktest(jobName?: string, seed = ROUTING_BACKTEST_SEED): RoutingBacktest {
  return replay(events(), jobName, seed)
}

export function routingBacktestEnsemble(jobName?: string): RoutingBacktestEnsemble {
  const all = events()
  const trajectories = ROUTING_BACKTEST_SEEDS.map((seed) => replay(all, jobName, seed))
  const names = [...new Set(trajectories.flatMap((trajectory) => trajectory.jobs.map((job) => job.job)))]
  const jobs = names.map((job) => {
    const verdicts = trajectories.map((trajectory) => trajectory.jobs.find((row) => row.job === job)!.verdict)
    return {
      job,
      wins: verdicts.filter((verdict) => verdict === 'win').length,
      ties: verdicts.filter((verdict) => verdict === 'tie').length,
      losses: verdicts.filter((verdict) => verdict === 'loss').length,
      unmeasurable: verdicts.filter((verdict) => verdict === 'unmeasurable').length,
    }
  })
  const passCount = trajectories.filter((trajectory) => trajectory.trajectoryPass).length
  return {
    seeds: ROUTING_BACKTEST_SEEDS,
    requiredPasses: ROUTING_BACKTEST_REQUIRED_PASSES,
    passCount,
    jobs,
    trajectories,
    shouldWire: passCount >= ROUTING_BACKTEST_REQUIRED_PASSES,
  }
}
