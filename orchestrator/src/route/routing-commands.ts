// concern: routing-commands
/** Knows routing reports, backtests, guidance and agreement. Must not know runs, transports, the CLI, worktrees, or reviews by value. */

import { resolveLens } from '../lens/lenses.ts'
import { projectAt } from '../project/projects.ts'
import { bradleyTerry } from '../score/agreement.ts'
import { duelMatrices } from '../score/duel.ts'
import { guide } from '../state/guide.ts'
import { evidenceFor, MIN_SAMPLE, pick, promptSizeBucketLabel, scoreboard } from './route.ts'
import {
  type RoutingBacktest,
  routingBacktest,
  routingBacktestEnsemble,
} from './routing-backtest.ts'

type RoutingFlags = { has(name: string): boolean; flag(name: string): string | undefined }
type RoutingPresentation = {
  log(...values: unknown[]): void
  dur(ms: number | null | undefined): string
}
type PickOptions = {
  jobName: string
  stack: string | null
  avoid: string[]
  distinctModels: string[]
  lens: string | undefined
  selectedAgent: string | undefined
}
type PickPresentation = {
  log(...values: unknown[]): void
  agents: Record<
    string,
    | {
        operatedBy: string
        probeResult?: unknown
      }
    | undefined
  >
}

export function routingBacktestCommand(
  flags: RoutingFlags,
  presentation: RoutingPresentation,
): void {
  const { has, flag } = flags
  const { log } = presentation
  const jobFilter = flag('job')
  const seedFlag = flag('seed')
  const seed = seedFlag === undefined ? undefined : Number(seedFlag)
  if (seedFlag !== undefined && (!/^\d+$/.test(seedFlag) || !Number.isSafeInteger(seed))) {
    throw new Error('--seed must be a non-negative integer')
  }
  const assumptions = {
    outcomeComparison:
      'not identifiable: agreements have the same logged outcome, while disagreements have no counterfactual outcome for the agent not run',
    policyLearning:
      'each simulated policy updates only from logged runs where it chose the historical agent',
    latency:
      'a matched successful run enters tie-break latency at chain completion whether or not it was scored',
    eligibility: 'current static capability, metered, prompt-size and context rules',
    cooldowns:
      'reconstructed from the full terminal operational stream, including quota/auth failures and successful probes; these events do not become scoring evidence',
    reachability: 'present-day reachability ignored',
    evidence:
      'every non-probe root dispatch is a decision; default distributions omit voided/evidence-excluded rows, while NOT_EVIDENCE runs remain decisions but never enter policy evidence',
    causalAvailability:
      'scored evidence enters at scored_at; eligible unjudged failures enter at the terminating chain member time; dispatch sees only earlier available evidence',
    ties: 'inside the noise band Thompson ties use reviewer precision when available, then unmetered and median latency',
    betaMapping: 'successes += (w + 0.5) / 1.5; failures += 1 - successes',
    exploration: 'choice differs from deterministic expected leader',
    scope: jobFilter ? `only job ${jobFilter}` : 'all displayed jobs',
  }
  const distribution = (values: Record<string, number>) =>
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([agent, count]) => `${agent}=${count}`)
      .join(', ') || 'none'
  const movedSelections = (baseline: RoutingBacktest, comparison: RoutingBacktest) => {
    const moved = (key: 'currentSelections' | 'thompsonSelections') =>
      baseline.jobs.reduce((total, row) => {
        const other = comparison.jobs.find((candidate) => candidate.job === row.job)
        const agents = new Set([...Object.keys(row[key]), ...Object.keys(other?.[key] ?? {})])
        return (
          total +
          [...agents].reduce(
            (sum, agent) => sum + Math.abs((row[key][agent] ?? 0) - (other?.[key][agent] ?? 0)),
            0,
          ) /
            2
        )
      }, 0)
    return { current: moved('currentSelections'), thompson: moved('thompsonSelections') }
  }
  const printTrajectory = (result: RoutingBacktest, voided: RoutingBacktest, indent = '') => {
    log(
      `${indent}seed ${result.seed}: causal exclusions ${result.causalExcludedJudgments}; unscored decisions ${result.unscoredDecisions}`,
    )
    const jobs = [...new Set([...result.jobs, ...voided.jobs].map((row) => row.job))]
    for (const job of jobs) {
      const row = result.jobs.find((candidate) => candidate.job === job)
      const included = voided.jobs.find((candidate) => candidate.job === job)
      log(
        `${indent}  ${job}: runs=${row?.runs ?? 0} agreements=${row?.agreements ?? 0} ` +
          `agreement=${((row?.agreementShare ?? 0) * 100).toFixed(1)}% ` +
          `Thompson-exploration=${((row?.thompsonExplorationShare ?? 0) * 100).toFixed(1)}% ` +
          `voided-excluded live-Thompson=[${distribution(row?.currentSelections ?? {})}] comparison-Thompson=[${distribution(row?.thompsonSelections ?? {})}]; ` +
          `voided-included live-Thompson=[${distribution(included?.currentSelections ?? {})}] ` +
          `Thompson=[${distribution(included?.thompsonSelections ?? {})}]`,
      )
    }
  }
  if (seed !== undefined) {
    const result = routingBacktest(jobFilter, seed)
    const voidedIncluded = routingBacktest(jobFilter, seed, { includeVoided: true })
    const cooldownDisabled = routingBacktest(jobFilter, seed, { cooldowns: false })
    const cooldownMoves = movedSelections(result, cooldownDisabled)
    const outputAssumptions = {
      ...assumptions,
      causalExclusions: `${result.causalExcludedJudgments} earlier judgment/dispatch pairs excluded`,
      unscoredDecisions: `${result.unscoredDecisions} dispatches have no score and contribute no quality evidence`,
      cooldownSensitivity: `disabling cooldown redistributes ${cooldownMoves.current} current-policy and ${cooldownMoves.thompson} Thompson selections`,
    }
    if (has('json')) {
      log(
        JSON.stringify({
          mode: 'single-seed-reproduction',
          assumptions: outputAssumptions,
          ...result,
          sensitivities: { voidedIncluded, cooldownDisabled: { selectionMoves: cooldownMoves } },
        }),
      )
      return
    }
    log(`routing replay diagnostic (seed ${seed}; descriptive only)`)
    log('assumptions:')
    for (const [key, value] of Object.entries(outputAssumptions)) log(`  ${key}: ${value}`)
    printTrajectory(result, voidedIncluded)
    return
  }
  const result = routingBacktestEnsemble(jobFilter)
  const voidedIncluded = routingBacktestEnsemble(jobFilter, { includeVoided: true })
  const cooldownDisabled = routingBacktestEnsemble(jobFilter, { cooldowns: false })
  const cooldownMoves = movedSelections(
    { seed: 0, causalExcludedJudgments: 0, unscoredDecisions: 0, jobs: result.jobs },
    { seed: 0, causalExcludedJudgments: 0, unscoredDecisions: 0, jobs: cooldownDisabled.jobs },
  )
  const causalExcludedJudgments = result.trajectories[0]?.causalExcludedJudgments ?? 0
  const unscoredDecisions = result.trajectories[0]?.unscoredDecisions ?? 0
  const outputAssumptions = {
    ...assumptions,
    causalExclusions: `${causalExcludedJudgments} earlier judgment/dispatch pairs excluded per trajectory`,
    unscoredDecisions: `${unscoredDecisions} dispatches have no score and contribute no quality evidence`,
    cooldownSensitivity: `disabling cooldown redistributes ${cooldownMoves.current} current-policy and ${cooldownMoves.thompson} Thompson selections across all seeds`,
  }
  if (has('json')) {
    log(
      JSON.stringify({
        mode: 'ensemble',
        assumptions: outputAssumptions,
        ...result,
        sensitivities: { voidedIncluded, cooldownDisabled: { selectionMoves: cooldownMoves } },
      }),
    )
    return
  }
  log(`routing replay diagnostic (seeds ${result.seeds.join(', ')}; descriptive only)`)
  log('assumptions:')
  for (const [key, value] of Object.entries(outputAssumptions)) log(`  ${key}: ${value}`)
  log('aggregate across seeds:')
  const jobs = [...new Set([...result.jobs, ...voidedIncluded.jobs].map((row) => row.job))]
  for (const job of jobs) {
    const row = result.jobs.find((candidate) => candidate.job === job)
    const included = voidedIncluded.jobs.find((candidate) => candidate.job === job)
    log(
      `  ${job}: decisions=${row?.runs ?? 0} agreements=${row?.agreements ?? 0} ` +
        `agreement=${((row?.agreementShare ?? 0) * 100).toFixed(1)}% ` +
        `Thompson-exploration=${((row?.thompsonExplorationShare ?? 0) * 100).toFixed(1)}% ` +
        `voided-excluded live-Thompson=[${distribution(row?.currentSelections ?? {})}] comparison-Thompson=[${distribution(row?.thompsonSelections ?? {})}]; ` +
        `voided-included live-Thompson=[${distribution(included?.currentSelections ?? {})}] ` +
        `Thompson=[${distribution(included?.thompsonSelections ?? {})}]`,
    )
  }
}

export function guideCommand(flags: RoutingFlags, presentation: RoutingPresentation): void {
  const { flag } = flags
  const { log, dur } = presentation
  const rawPromptBytes = flag('prompt-bytes')
  const promptBytes = rawPromptBytes === undefined ? undefined : Number(rawPromptBytes)
  if (
    promptBytes !== undefined &&
    (!/^\d+$/.test(rawPromptBytes!) || !Number.isSafeInteger(promptBytes))
  ) {
    throw new Error('--prompt-bytes must be a non-negative integer')
  }
  const gs = guide(flag('job'), promptBytes, flag('lens'))
  if (flag('lens')) {
    const p = projectAt(process.cwd())
    const resolved = resolveLens(flag('lens')!, p?.name ?? null)
    log(
      `lens profiles: ${resolved ? resolved.profiles.map((x) => `${x.axis}=${x.name}@${x.version}`).join(', ') : 'free-form (no catalogue row)'}`,
    )
  }
  const size = (b: number) => (b >= 1024 ? `${Math.round(b / 1024)}KB` : `${Math.round(b)}B`)
  const tradeoffs: string[] = []
  let decided = 0,
    provisional = 0,
    blank = 0

  for (const g of gs) {
    const bucket =
      g.promptBucket === null ? '' : ` [${promptSizeBucketLabel(g.promptBucket)} prompts]`
    log(`\n${g.job}${bucket}  ${g.what}`)
    if (!g.tried.length) {
      blank++
      log('  no runs yet - nothing to compare')
    } else {
      if (g.decided) decided++
      else if (g.best) provisional++
      if (g.best) {
        const rawBest = [...g.tried]
          .filter((candidate) => candidate.score !== null)
          .sort((a, b) => b.score! - a.score! || b.evidence - a.evidence)[0]
        log(
          `  best     ${g.best.agent.padEnd(11)} ${((g.best.score! * 100).toFixed(0) + '%').padStart(5)}` +
            ` raw, ${((g.best.shrunk! * 100).toFixed(0) + '%').padStart(5)} shrunk` +
            // "judged", not "scored": the percentage now includes failed runs
            // at the `unusable` weight, so labeling it with the verdict count
            // alone described a smaller denominator than the number came from.
            `  over ${g.best.evidence} judged` +
            (g.best.failures ? ` (incl. ${g.best.failures} failed)` : '') +
            (rawBest && rawBest.agent !== g.best.agent
              ? `   SHRUNK LEADER (raw: ${rawBest.agent})`
              : '') +
            (g.decided ? '' : `   PROVISIONAL - needs ${MIN_SAMPLE}`),
        )
      } else log('  best     - nothing scored yet')

      // With one agent tried there is no quickest, only a measurement.
      const q = g.quickest ?? g.tried[0]!
      const solo = !g.quickest
      log(
        `  ${solo ? 'speed   ' : 'quickest'} ${q.agent.padEnd(11)} ${dur(q.latencyMs).padStart(5)}` +
          `  median over ${q.runs} run${q.runs === 1 ? '' : 's'}, ~${size(q.promptBytes)} prompts` +
          (solo ? '   (only agent tried)' : ''),
      )
      if (g.best && g.quickest && g.best.agent !== g.quickest.agent) {
        tradeoffs.push(
          `${g.job}${bucket}: ${g.best.agent} judges best, ${g.quickest.agent} is ` +
            `${dur(g.quickest.latencyMs)} vs ${dur(g.best.latencyMs)}`,
        )
      }
    }
    if (g.untried.length) log(`  untried  ${g.untried.join(', ')}`)
    for (const e of g.excluded) log(`  excluded ${e.agent}: ${e.why}`)
    for (const cell of g.evidenceCells) {
      log(
        `  evidence ${cell.name}: ` +
          (cell.counts.length
            ? cell.counts.map((row) => `${row.agent}=${row.evidence}`).join(', ')
            : 'no judgments'),
      )
    }
    log(`  routes to ${g.routesTo}   (${g.reason})`)
  }

  if (tradeoffs.length) {
    log('\n  Best and quickest disagree - pick on what the job needs:')
    for (const t of tradeoffs) log(`    ${t}`)
  }
  log(
    `\n  ${decided} bucket(s) decided by evidence, ${provisional} provisional, ${blank} with no runs.` +
      `\n  Routing and latency evidence are separated at the provisional 16 KiB prompt boundary.`,
  )
}

export function statsCommand(flags: RoutingFlags, presentation: RoutingPresentation): void {
  const { flag } = flags
  const { log, dur } = presentation
  // scoreboard(), not a query of its own. The comment that used to sit here
  // claimed exactly that and had stopped being true: this filtered
  // status='ok' after the router stopped, so grok on review-lens read 96%
  // here and 69% to the thing actually choosing an agent. A report that
  // disagrees with the decision it describes is worse than no report.
  const rows = scoreboard(flag('job')).sort(
    (a, b) => a.job.localeCompare(b.job) || (b.shrunk ?? -9) - (a.shrunk ?? -9),
  )
  const matrices = duelMatrices(flag('job'))
  if (!rows.length && !matrices.length) {
    log('no runs yet')
    return
  }
  if (rows.length) {
    log(
      'job / prompt bucket            agent        runs  judged    raw  shrunk  median    vendor tokens      cost',
    )
    for (const r of rows) {
      const score = r.score === null ? '—' : `${(r.score * 100).toFixed(0)}%`
      const shrunk = r.shrunk === null ? '—' : `${(r.shrunk * 100).toFixed(0)}%`
      const cost = r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : '—'
      // Failures are part of the score, so they are shown beside it rather than
      // left for someone to wonder why the percentage looks low.
      const judged = r.failures ? `${r.evidence}(${r.failures}f)` : String(r.evidence)
      log(
        `${`${r.job} [${promptSizeBucketLabel(r.promptBucket)}]`.padEnd(30)} ` +
          `${r.agent.padEnd(11)} ${String(r.runs).padStart(5)} ${judged.padStart(7)}` +
          ` ${score.padStart(6)} ${shrunk.padStart(7)} ${dur(r.latencyMs).padStart(8)} ${r.tokens.toLocaleString().padStart(17)}` +
          ` ${cost.padStart(9)}`,
      )
    }
  }
  for (const matrix of matrices) {
    const duelCount = matrix.agents.reduce(
      (sum, agent) =>
        sum +
        matrix.agents.reduce(
          (agentSum, opponent) => agentSum + matrix.cells[agent]![opponent]!.wins,
          0,
        ),
      0,
    )
    if (duelCount >= MIN_SAMPLE) {
      const strengths = bradleyTerry(
        matrix.agents,
        (winner, loser) => matrix.cells[winner]![loser]!.wins,
      )
      log(`\n${matrix.job} Bradley-Terry strengths (${duelCount} duels)`)
      log('agent        strength')
      for (const row of strengths) {
        log(`${row.agent.padEnd(12)} ${row.strength.toFixed(3).padStart(8)}`)
      }
      continue
    }
    const width = Math.max(7, ...matrix.agents.map((agent) => agent.length))
    log(`\n${matrix.job} duels (wins-losses)`)
    log(`${'agent'.padEnd(width)} ${matrix.agents.map((a) => a.padStart(width)).join(' ')}`)
    for (const agent of matrix.agents) {
      const cells = matrix.agents
        .map((opponent) => {
          if (opponent === agent) return '-'.padStart(width)
          const cell = matrix.cells[agent]![opponent]!
          return `${cell.wins}-${cell.losses}`.padStart(width)
        })
        .join(' ')
      log(`${agent.padEnd(width)} ${cells}`)
    }
  }
}

export function pickCommand(
  options: PickOptions,
  flags: RoutingFlags,
  presentation: PickPresentation,
): void {
  void flags
  const { log, agents } = presentation
  // --stack, or the stack of wherever you are standing. A route is a claim
  // about a job IN A CONTEXT, and reporting it without the context invites
  // reading a php verdict as a node one.
  const { jobName, stack, avoid, distinctModels, lens, selectedAgent } = options
  // explore=false: a report that spent the exploration coin would name a
  // different agent each time it was read.
  const p = pick(
    jobName,
    selectedAgent,
    0,
    false,
    stack,
    { agents: avoid, models: distinctModels },
    false,
    lens,
  )
  const ev = evidenceFor(jobName, 0, stack, undefined, lens)
  if (lens) {
    const resolved = resolveLens(lens, projectAt(process.cwd())?.name ?? null)
    log(
      `selected profiles: ${resolved ? resolved.profiles.map((x) => `${x.axis}=${x.name}@${x.version}`).join(', ') : 'free-form (no catalogue row)'}`,
    )
  }
  const counts = (rows: typeof ev.cands) =>
    rows
      .filter((candidate) => candidate.evidence > 0)
      .map((candidate) => `${candidate.agent}=${candidate.evidence}`)
      .join(', ') || 'no judgments'
  log(
    `${jobName} -> ${p.agent}   (${p.reason})\n` +
      `  deciding cell: ${ev.level === 'lens' ? `lens ${ev.lens}` : ev.level === 'stack' ? `stack ${ev.stack}` : 'job-wide'}\n` +
      (ev.scoped && ev.lens
        ? `  lens ${ev.lens} evidence: ${counts(ev.scoped)}\n  job-wide evidence: ${counts(ev.job)}\n`
        : `  evidence: ${ev.level === 'stack' ? `${ev.stack} only` : 'all stacks'}` +
          `${stack && ev.level === 'job' ? ` (too little on ${stack} to compare agents there)` : ''}\n`),
  )
  const listed = [...ev.cands].sort((a, b) => {
    const rank = (candidate: typeof a) =>
      agents[candidate.agent]?.operatedBy === 'self' && candidate.preferred ? 0 : 1
    return rank(a) - rank(b)
  })
  for (const c of listed) {
    const probe = agents[c.agent]?.probeResult as { mcp?: { verifiable?: boolean } } | null
    const mcpNote = probe?.mcp && probe.mcp.verifiable === false ? ' mcp: unverifiable' : ''
    log(
      `  ${c.agent.padEnd(7)} ${c.eligible ? 'eligible' : 'excluded'.padEnd(8)}` +
        ` declared=${c.declared?.join(',') ?? 'any'} preferred=${c.preferred ? 'yes' : 'no'}` +
        ` runs=${String(c.runs).padStart(3)} judged=${String(c.evidence).padStart(3)}` +
        ` score=${c.score === null ? '—' : (c.score * 100).toFixed(0) + '%'}` +
        ` shrunk=${c.shrunk === null ? '—' : (c.shrunk * 100).toFixed(0) + '%'}  ${c.why}${mcpNote}`,
    )
  }
  log(`\n  (a rate steers routing only at ${MIN_SAMPLE}+ scored runs)`)
}
