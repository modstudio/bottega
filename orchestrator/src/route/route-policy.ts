// concern: route ranking policy
/** Pure posterior ranking and exploration decisions shared by live routing and replay. */

export type PolicyCandidate = {
  agent: string
  scored: number
  failures: number
  none: number
  evidence: number
  score: number | null
  shrunk: number | null
  free: boolean
  latencyMs: number | null
  precision?: number | null
}

export type PolicySelection<T extends PolicyCandidate> = {
  chosen: T
  mode: 'challenger' | 'standing-challenger' | 'best' | 'preference' | 'only'
  tied: number
}

type PosteriorCandidate = Pick<
  PolicyCandidate,
  'agent' | 'evidence' | 'score' | 'free' | 'latencyMs' | 'precision'
>

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

export function rankThompson<T extends PosteriorCandidate>(
  candidates: readonly T[],
  draw: boolean,
  rng: () => number,
  minSample: number,
  contribution: (weight: number) => { successes: number; failures: number },
  posteriorNoiseBand: number,
): { chosen: T; expected: T; posteriorMean: number; tied: number } {
  const field = candidates
    .filter((candidate) => candidate.evidence >= minSample && candidate.score !== null)
    .map((candidate) => candidate.score!)
  const priorWeight = field.length ? field.reduce((a, b) => a + b, 0) / field.length : 0.5
  const priorSuccess = contribution(priorWeight).successes
  const posterior = candidates.map((candidate) => {
    const observed = contribution(candidate.score ?? 0)
    const successes = priorSuccess * minSample + observed.successes * candidate.evidence
    const failures = (1 - priorSuccess) * minSample + observed.failures * candidate.evidence
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
    const tied = posterior.filter((row) => leader[metric] - row[metric] <= posteriorNoiseBand)
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

const worthExploring = (candidate: PolicyCandidate) =>
  !(
    (candidate.scored === 0 && candidate.failures > 0) ||
    (candidate.scored > 0 && candidate.none === candidate.scored)
  )

function preferredChallenger<T extends PolicyCandidate>(
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

type PolicyDependencies<T extends PolicyCandidate> = {
  minSample: number
  exploreRate: number
  standingExploreRate: (evidence: number) => number
  rank: (candidates: readonly T[], draw: boolean, rng: () => number) => { chosen: T; tied: number }
}

function provenSelection<T extends PolicyCandidate>(
  candidates: readonly T[],
  proven: readonly T[],
  unproven: readonly T[],
  explore: boolean,
  rng: () => number,
  explorationExcluded: ReadonlySet<string>,
  deps: PolicyDependencies<T>,
): PolicySelection<T> {
  const worthTrying = unproven.filter(
    (candidate) => worthExploring(candidate) && !explorationExcluded.has(candidate.agent),
  )
  if (explore && worthTrying.length > 0 && rng() < deps.exploreRate) {
    const challenger = [...worthTrying].sort((a, b) => a.evidence - b.evidence)[0]!
    return { chosen: challenger, mode: 'challenger', tied: 0 }
  }
  const ranked = deps.rank(proven, explore, rng)
  const best = ranked.chosen
  if (
    explore &&
    unproven.length === 0 &&
    proven.length === candidates.length &&
    rng() < deps.standingExploreRate(best.evidence)
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

export function selectCurrentPolicy<T extends PolicyCandidate>(
  candidates: readonly T[],
  prefer: readonly string[],
  explore: boolean,
  rng: () => number,
  explorationExcluded: ReadonlySet<string>,
  declaredPreferences: ReadonlySet<string>,
  deps: PolicyDependencies<T>,
): PolicySelection<T> {
  const proven = candidates.filter(
    (candidate) => candidate.evidence >= deps.minSample && candidate.score !== null,
  )
  const unproven = candidates.filter((candidate) => candidate.evidence < deps.minSample)
  const declared = preferredChallenger(unproven, prefer, explorationExcluded, declaredPreferences)
  if (declared) return { chosen: declared, mode: 'preference', tied: 0 }
  if (proven.length > 0)
    return provenSelection(candidates, proven, unproven, explore, rng, explorationExcluded, deps)
  for (const name of prefer) {
    const preferred = candidates.find((candidate) => candidate.agent === name)
    if (preferred) return { chosen: preferred, mode: 'preference', tied: 0 }
  }
  return { chosen: candidates[0]!, mode: 'only', tied: 0 }
}
