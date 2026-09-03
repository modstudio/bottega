import { db } from './db.ts'
import { JOBS } from './jobs.ts'
import { candidates, pick, median, MIN_SAMPLE } from './route.ts'

export type AgentOnJob = {
  agent: string
  runs: number
  scored: number
  /** Runs that produced nothing to judge. Counted against the agent, as `unusable`. */
  failures: number
  /** Verdicts plus failures: everything this is entitled to call a judgement. */
  evidence: number
  /** Mean verdict weight, or null until anything has been judged. */
  score: number | null
  /** Score pulled toward the job-wide proven-agent mean by MIN_SAMPLE judgements. */
  shrunk: number | null
  /** Median run time; a mean is hostage to the one call that hung. */
  latencyMs: number | null
  /** Median prompt size, because a speed claim without it means nothing. */
  promptBytes: number
  costUsd: number
}

export type JobGuide = {
  job: string
  what: string
  /** Highest-scoring agent tried, whether or not there is enough evidence. */
  best: AgentOnJob | null
  /** Fastest agent tried; null when only one was, since that is not a comparison. */
  quickest: AgentOnJob | null
  /** True once `best` rests on MIN_SAMPLE judgements rather than one or two. */
  decided: boolean
  /** Eligible agents nobody has tried, where a run buys the most information. */
  untried: string[]
  /** Where a run goes by default. Exploration can still divert a share elsewhere. */
  routesTo: string
  reason: string
  tried: AgentOnJob[]
}

/**
 * What to use for what, per job.
 *
 * Two agents can each be the right answer to the same job - one because it
 * judges better, one because it turns around faster - so both are named rather
 * than collapsed into a single winner. `decided` is the honest part: with fewer
 * than MIN_SAMPLE judgements a leader is whoever happened to go first, and
 * presenting that as a recommendation would launder a guess into a finding.
 */
export function guide(onlyJob?: string): JobGuide[] {
  // Scores come from candidates(), not from a second copy of the same SQL here.
  // There used to be one, and the two drifted the moment routing learned to
  // count failures: the router demoted an agent while the guide, still filtering
  // to successful runs, went on recommending it. A guide that disagrees with the
  // router is worse than no guide, because it is consulted precisely when
  // someone wants to know what the router will do.
  const raw = db().query(
    `SELECT job, agent, latency_ms, prompt_bytes FROM run
      WHERE status='ok' AND probe=0 AND latency_ms IS NOT NULL`,
  ).all() as { job: string; agent: string; latency_ms: number; prompt_bytes: number }[]

  const key = (j: string, a: string) => `${j} ${a}`
  const samples = new Map<string, { lat: number[]; bytes: number[] }>()
  for (const r of raw) {
    const e = samples.get(key(r.job, r.agent)) ?? { lat: [], bytes: [] }
    e.lat.push(r.latency_ms)
    e.bytes.push(r.prompt_bytes ?? 0)
    samples.set(key(r.job, r.agent), e)
  }
  return Object.keys(JOBS)
    .filter((n) => !onlyJob || n === onlyJob)
    .map((name) => {
      const eligible = candidates(name).filter((c) => c.eligible)
      const tried: AgentOnJob[] = eligible
        .map((c) => ({
          agent: c.agent,
          runs: c.runs,
          scored: c.scored,
          failures: c.failures,
          evidence: c.evidence,
          score: c.score,
          shrunk: c.shrunk,
          latencyMs: c.latencyMs,
          promptBytes: median(samples.get(key(name, c.agent))?.bytes ?? []) ?? 0,
          costUsd: c.costUsd,
        }))
        // An agent that has only ever failed here has still been tried, and
        // saying so is the useful part: it is the difference between "no answer
        // yet" and "asked, and it cannot".
        .filter((c) => c.runs > 0 || c.failures > 0)

      const judged = tried.filter((c) => c.score !== null)
      const best = [...judged].sort((a, b) => b.shrunk! - a.shrunk! || b.evidence - a.evidence)[0] ?? null
      // One agent tried is a measurement, not a race; leaving this null stops
      // the caller crowning the winner of a field of one.
      const quickest = tried.length > 1
        ? ([...tried].filter((c) => c.latencyMs !== null).sort((a, b) => a.latencyMs! - b.latencyMs!)[0] ?? null)
        : null
      const chosen = pick(name, undefined, 0, false)

      return {
        job: name,
        what: JOBS[name]!.what,
        best,
        quickest,
        decided: !!best && best.evidence >= MIN_SAMPLE,
        untried: eligible.filter((c) => !tried.some((t) => t.agent === c.agent)).map((c) => c.agent),
        routesTo: chosen.agent,
        reason: chosen.reason,
        tried,
      }
    })
}
