// concern: route ranking policy
/** Pure posterior ranking and exploration decisions shared by live routing and replay. */
import { weigh } from '../score/score.ts'

/** Below this many JUDGMENTS — verdicts plus unjudged failures — a score is noise. */
export const MIN_SAMPLE = 5

const EXPLORE_RATE = 0.25
export const STANDING_EXPLORE_RATE = 0.1
const STANDING_EXPLORE_FLOOR = 0.03

export function standingExploreRate(leaderEvidence: number): number {
  return Math.max(
    STANDING_EXPLORE_FLOOR,
    STANDING_EXPLORE_RATE / Math.sqrt(leaderEvidence / MIN_SAMPLE),
  )
}

/** Linear width of the judgment-weight range mapped onto a Beta probability. */
export const BETA_SCALE = 1.5
/** One adjacent quality step in the current judgment matrix. */
export const QUALITY_STEP = weigh('full', 'right') - weigh('full', 'mixed')
export const NOISE_BAND = QUALITY_STEP / MIN_SAMPLE
export const POSTERIOR_NOISE_BAND = NOISE_BAND / BETA_SCALE

export function betaContribution(weight: number): { successes: number; failures: number } {
  const successes = (weight + 0.5) / BETA_SCALE
  return { successes, failures: 1 - successes }
}

function normal(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

function gamma(alpha: number, rng: () => number): number {
  if (alpha < 1) return gamma(alpha + 1, rng) * Math.max(rng(), Number.EPSILON) ** (1 / alpha)
  const d = alpha - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  while (true) {
    const x = normal(rng)
    const v0 = 1 + c * x
    if (v0 <= 0) continue
    const v = v0 ** 3
    const u = rng()
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v)))
      return d * v
  }
}

function beta(alpha: number, betaValue: number, rng: () => number): number {
  const x = gamma(Math.max(alpha, Number.EPSILON), rng)
  const y = gamma(Math.max(betaValue, Number.EPSILON), rng)
  return x / (x + y)
}

type ThompsonCandidate = {
  agent: string
  evidence: number
  score: number | null
  free: boolean
  latencyMs: number | null
  precision?: number | null
}

export function thompsonRank<T extends ThompsonCandidate>(
  candidates: readonly T[],
  draw = true,
  rng: () => number = Math.random,
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
  const tie = (a: (typeof posterior)[number], b: (typeof posterior)[number]) =>
    (a.candidate.precision === null || a.candidate.precision === undefined
      ? b.candidate.precision === null || b.candidate.precision === undefined
        ? 0
        : 1
      : b.candidate.precision === null || b.candidate.precision === undefined
        ? -1
        : b.candidate.precision - a.candidate.precision) ||
    Number(b.candidate.free) - Number(a.candidate.free) ||
    (a.candidate.latencyMs ?? Infinity) - (b.candidate.latencyMs ?? Infinity) ||
    b.candidate.evidence - a.candidate.evidence ||
    a.candidate.agent.localeCompare(b.candidate.agent)
  const rank = (metric: 'mean' | 'sample') => {
    const leader = [...posterior].sort((a, b) => b[metric] - a[metric])[0]!
    const tied = posterior.filter((row) => leader[metric] - row[metric] <= POSTERIOR_NOISE_BAND)
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

type CurrentPolicyCandidate = ThompsonCandidate & {
  scored: number
  failures: number
  none: number
  shrunk: number | null
}

export type CurrentPolicySelection<T extends CurrentPolicyCandidate> = {
  chosen: T
  mode: 'challenger' | 'standing-challenger' | 'best' | 'preference' | 'only'
  tied: number
}

const worthExploring = (candidate: CurrentPolicyCandidate) =>
  !(
    (candidate.scored === 0 && candidate.failures > 0) ||
    (candidate.scored > 0 && candidate.none === candidate.scored)
  )

function preferredChallenger<T extends CurrentPolicyCandidate>(
  candidates: readonly T[],
  prefer: readonly string[],
  explorationExcluded: ReadonlySet<string>,
  declaredPreferences?: ReadonlySet<string>,
): T | undefined {
  for (const name of prefer) {
    if (declaredPreferences && !declaredPreferences.has(name)) continue
    const preferred = candidates.find(
      (candidate) =>
        candidate.agent === name &&
        worthExploring(candidate) &&
        !explorationExcluded.has(candidate.agent),
    )
    if (preferred) return preferred
  }
}

function provenSelection<T extends CurrentPolicyCandidate>(
  candidates: readonly T[],
  proven: readonly T[],
  unproven: readonly T[],
  explore: boolean,
  rng: () => number,
  explorationExcluded: ReadonlySet<string>,
): CurrentPolicySelection<T> {
  const worthTrying = unproven.filter(
    (candidate) => worthExploring(candidate) && !explorationExcluded.has(candidate.agent),
  )
  if (explore && worthTrying.length > 0 && rng() < EXPLORE_RATE) {
    const challenger = [...worthTrying].sort((a, b) => a.evidence - b.evidence)[0]!
    return { chosen: challenger, mode: 'challenger', tied: 0 }
  }
  const ranked = thompsonRank(proven, explore, rng)
  const best = ranked.chosen
  if (
    explore &&
    unproven.length === 0 &&
    proven.length === candidates.length &&
    rng() < standingExploreRate(best.evidence)
  ) {
    const challenger = [...proven]
      .filter(
        (candidate) =>
          candidate.agent !== best.agent &&
          worthExploring(candidate) &&
          !explorationExcluded.has(candidate.agent),
      )
      .sort((a, b) => a.evidence - b.evidence)[0]
    if (challenger) return { chosen: challenger, mode: 'standing-challenger', tied: ranked.tied }
  }
  return { chosen: best, mode: 'best', tied: ranked.tied }
}

export function currentPolicySelection<T extends CurrentPolicyCandidate>(
  candidates: readonly T[],
  prefer: readonly string[],
  explore = true,
  rng: () => number = Math.random,
  explorationExcluded: ReadonlySet<string> = new Set(),
  declaredPreferences: ReadonlySet<string> = new Set(),
): CurrentPolicySelection<T> {
  const proven = candidates.filter(
    (candidate) => candidate.evidence >= MIN_SAMPLE && candidate.score !== null,
  )
  const unproven = candidates.filter((candidate) => candidate.evidence < MIN_SAMPLE)
  const declared = preferredChallenger(unproven, prefer, explorationExcluded, declaredPreferences)
  if (declared) return { chosen: declared, mode: 'preference', tied: 0 }
  if (proven.length > 0)
    return provenSelection(candidates, proven, unproven, explore, rng, explorationExcluded)
  for (const name of prefer) {
    const preferred = candidates.find((candidate) => candidate.agent === name)
    if (preferred) return { chosen: preferred, mode: 'preference', tied: 0 }
  }
  return { chosen: candidates[0]!, mode: 'only', tied: 0 }
}
