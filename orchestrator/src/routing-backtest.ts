import { AGENTS } from './agents.ts'
import { db, weigh } from './db.ts'
import { COOLS_DOWN, NOT_EVIDENCE } from './failure.ts'
import { JOBS } from './jobs.ts'
import {
  COOLDOWN_MIN, EVIDENCE_WINDOW, EXPLORE_RATE, MIN_SAMPLE, NOISE_BAND,
  OUTPUT_RESERVE, PROMPT_SIZE_BOUNDARY, STANDING_EXPLORE_RATE, median,
} from './route.ts'

export const ROUTING_BACKTEST_SEED = 287

export function betaContribution(weight: number): { successes: number; failures: number } {
  // Map the judgement range [-0.5, 1] linearly onto [0, 1]: `none` is one
  // whole failure and full/right is one whole success; intermediate verdicts
  // contribute fractional evidence without inventing a second score table.
  const successes = (weight + 0.5) / 1.5
  return { successes, failures: 1 - successes }
}

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
  shouldWire: boolean
}

export function passesRoutingBacktest(jobs: readonly BacktestJob[]): boolean {
  const eligible = jobs.filter((job) => job.runs >= MIN_SAMPLE)
  return eligible.length > 0 &&
    eligible.every((job) => job.measurable && job.thompsonMean! >= job.currentMean!) &&
    eligible.some((job) => job.thompsonMean! - job.currentMean! > NOISE_BAND)
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
    const v = v0 * v0 * v0
    const u = rng()
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

function beta(alpha: number, betaValue: number, rng: () => number): number {
  const x = gamma(Math.max(alpha, Number.EPSILON), rng)
  const y = gamma(Math.max(betaValue, Number.EPSILON), rng)
  return x / (x + y)
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
  const field = cells.filter((c) => c.evidence.length >= MIN_SAMPLE && c.score !== null).map((c) => c.score!)
  const priorWeight = field.length ? field.reduce((a, b) => a + b, 0) / field.length : 0.5
  const priorSuccess = betaContribution(priorWeight).successes
  const posterior = cells.map((cell) => {
    let successes = priorSuccess * MIN_SAMPLE
    let failures = (1 - priorSuccess) * MIN_SAMPLE
    for (const evidence of cell.evidence) {
      const update = betaContribution(evidence.weight)
      successes += update.successes; failures += update.failures
    }
    return { cell, mean: successes / (successes + failures), sample: draw ? beta(successes, failures, rng) : successes / (successes + failures) }
  })
  const exactTie = (a: typeof posterior[number], b: typeof posterior[number]) =>
    Number(b.cell.free) - Number(a.cell.free) ||
    (a.cell.latency ?? Infinity) - (b.cell.latency ?? Infinity) ||
    a.cell.agent.localeCompare(b.cell.agent)
  const expected = [...posterior].sort((a, b) => b.mean - a.mean || exactTie(a, b))[0]!.cell.agent
  const agent = [...posterior].sort((a, b) => b.sample - a.sample || exactTie(a, b))[0]!.cell.agent
  return { agent, expected }
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

export function routingBacktest(jobName?: string, seed = ROUTING_BACKTEST_SEED): RoutingBacktest {
  const all = events()
  const jobs: BacktestJob[] = []
  let causalExcludedJudgements = 0
  for (const name of [...new Set(all.map((e) => e.job))]) {
    const currentRng = seeded(seed ^ 0x43555252)
    const thompsonRng = seeded(seed ^ 0x54484f4d)
    let agreements = 0, currentMatched = 0, thompsonMatched = 0, currentTotal = 0, thompsonTotal = 0
    let currentExplores = 0, thompsonExplores = 0
    const rows = all.filter((e) => e.job === name)
    for (const event of rows) {
      const earlier = rows.filter((candidate) => candidate.id < event.id)
      const history = earlier.filter((candidate) => candidate.evidenceAt < event.startedAt)
      if (!jobName || name === jobName) causalExcludedJudgements += earlier.length - history.length
      const current = currentChoice(event, history, currentRng, true)
      const thompson = thompsonChoice(event, history, thompsonRng, true)
      if (current.agent === thompson.agent) agreements++
      if (current.agent !== current.expected) currentExplores++
      if (thompson.agent !== thompson.expected) thompsonExplores++
      if (current.agent === event.agent) { currentMatched++; currentTotal += event.weight }
      if (thompson.agent === event.agent) { thompsonMatched++; thompsonTotal += event.weight }
    }
    const currentMean = currentMatched ? currentTotal / currentMatched : null
    const thompsonMean = thompsonMatched ? thompsonTotal / thompsonMatched : null
    const measurable = currentMatched >= MIN_SAMPLE && thompsonMatched >= MIN_SAMPLE
    const verdict = !measurable ? 'unmeasurable'
      : thompsonMean! >= currentMean! ? (thompsonMean! - currentMean! > NOISE_BAND ? 'Thompson wins beyond noise' : 'Thompson matches within noise')
        : 'current wins'
    jobs.push({
      job: name, runs: rows.length, agreements, differences: rows.length - agreements,
      currentMatched, thompsonMatched, currentMean, thompsonMean,
      currentExplorationShare: rows.length ? currentExplores / rows.length : 0,
      thompsonExplorationShare: rows.length ? thompsonExplores / rows.length : 0,
      measurable, verdict,
    })
  }
  const shouldWire = passesRoutingBacktest(jobs)
  return {
    seed, causalExcludedJudgements,
    jobs: jobName ? jobs.filter((row) => row.job === jobName) : jobs,
    shouldWire,
  }
}
