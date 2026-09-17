// concern: metric-commands
/** Owns metric collection and reporting. Must not know CLI grammar. */
import { collect, summary } from './metric.ts'

export async function metricCommand(
  options: { collect: boolean; days: number; window: number },
  presentation: { log(value: string): void; now(): number },
): Promise<void> {
  if (options.collect) {
    const started = presentation.now()
    const count = await collect(options.days)
    presentation.log(
      `collected ${count} day(s) in ${((presentation.now() - started) / 1000).toFixed(1)}s`,
    )
  }
  const report = summary(options.window)
  if (!report.days) {
    presentation.log('no metric data — run: orch metric collect')
    return
  }
  renderSummary(report, presentation)
  renderLenses(report, presentation)
  renderMix(report, presentation)
  renderSeries(report, presentation)
}

type Report = ReturnType<typeof summary>
type Output = { log(value: string): void }

function renderSummary(report: Report, presentation: Output): void {
  presentation.log(`\nClaude tokens per shipped task — last ${report.days} day(s) with data\n`)
  presentation.log(`  canon tokens  ${report.canonTokens.toLocaleString()}`)
  presentation.log(`  total tokens  ${report.tokens.toLocaleString()}`)
  presentation.log(`  untracked     ${report.otherTokens.toLocaleString()}`)
  presentation.log(`  tasks shipped ${report.tasks}`)
  presentation.log(`  PER TASK      ${report.perTask ? report.perTask.toLocaleString() : '—'}`)
  presentation.log(
    `  per message   ${report.perMessage ? report.perMessage.toLocaleString() : '—'}   (average context carried per turn)`,
  )
  const arrow = { improving: 'DOWN', worsening: 'UP', flat: 'FLAT', unknown: '—' }[report.direction]
  const pct = report.changePct === null ? '' : ` ${Math.abs(report.changePct).toFixed(0)}%`
  presentation.log(
    `  TREND         ${arrow}${pct}  ${report.direction === 'unknown' ? '(too few tasks in a half to say)' : `(${report.earlier.perTask?.toLocaleString()} -> ${report.recent.perTask?.toLocaleString()} per task, halves of the window)`}`,
  )
  if (report.excluded)
    presentation.log(
      `                excluding ${report.excluded} day(s): today is incomplete, and a day with tasks but no tokens is a gap`,
    )
}

function renderLenses(report: Report, presentation: Output): void {
  const compact = (value: number) =>
    value >= 1e9
      ? `${(value / 1e9).toFixed(1)}B`
      : value >= 1e6
        ? `${(value / 1e6).toFixed(1)}M`
        : value >= 1e3
          ? `${(value / 1e3).toFixed(1)}k`
          : String(value)
  presentation.log(
    '\n  LENSES — canon spend over four denominators, none of them trustworthy alone\n',
  )
  for (const lens of report.lenses) {
    presentation.log(
      `  ${lens.label.padEnd(18)}${String(lens.denom).padStart(9)}  ->  ${(lens.perUnit ? compact(lens.perUnit) : '—').padStart(8)}`,
    )
    presentation.log(`  ${''.padEnd(18)}${lens.caveat}`)
  }
}

function renderMix(report: Report, presentation: Output): void {
  const mixTotal = report.mix.reduce((sum, item) => sum + item.lines, 0)
  if (mixTotal > 0) {
    presentation.log('\n  lines changed by kind:')
    for (const item of report.mix)
      presentation.log(
        `    ${item.kind.padEnd(11)}${item.lines.toLocaleString().padStart(11)}  ${((item.lines / mixTotal) * 100).toFixed(1).padStart(5)}%`,
      )
  }
  if (report.untrackedShare > 0.02)
    presentation.log(
      `\n  ${(report.untrackedShare * 100).toFixed(1)}% of spend was outside the canon repos — work with no denominator here.`,
    )
}

function renderSeries(report: Report, presentation: Output): void {
  presentation.log('\n  day          tokens        tasks   per task')
  for (const row of report.series.slice(-10)) {
    const perTask = row.tasks ? Math.round(row.canon_tokens / row.tasks).toLocaleString() : '—'
    const suffix = row.partial ? '  <- today, incomplete' : row.gap ? '  <- no tokens recorded' : ''
    presentation.log(
      `  ${row.day}  ${row.claude_tokens.toLocaleString().padStart(13)}  ${String(row.tasks).padStart(6)}  ${perTask.padStart(10)}${suffix}`,
    )
  }
}
