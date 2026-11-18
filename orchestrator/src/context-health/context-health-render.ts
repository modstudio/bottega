// concern: context-health
/** Text presentation for the context health decision. */
import type { ContextHealthFinding, ContextHealthReport } from './context-health.ts'

const age = (milliseconds: number | null) => {
  if (milliseconds === null) return 'n/a'
  const hours = Math.floor(milliseconds / 3_600_000)
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

function itemLine(item: ContextHealthFinding, shape = false): string {
  const task = item.taskKey ?? '-'
  const size = shape ? ` size=${item.size}/${item.cap}` : ''
  const references = item.unverifiable
    ? ` unverifiable=${item.unverifiable}`
    : item.staleReferences.length
      ? ` stale=${item.staleReferences.map(({ rule }) => rule).join(',')}`
      : ''
  return `  ${item.holder} task=${task} item=${item.id} kind=${item.kind} age=${age(item.ageMs)}${size}${references}\n    remedy: ${item.remedy}`
}

export function renderContextHealth(report: ContextHealthReport): string {
  if (report.unreachable) {
    return [
      'Context health: unreachable',
      `${report.unreachable.resource}: ${report.unreachable.detail}`,
      `remedy: ${report.unreachable.remedy}`,
    ].join('\n')
  }
  const lines: string[] = [`Context health: ${report.verdict} (since ${report.since})`]
  const itemSection = (label: string, items: ContextHealthFinding[], shape = false) => {
    lines.push('', `${label}: ${items.length}`)
    lines.push(...items.map((item) => itemLine(item, shape)))
  }
  itemSection('S1 unreached', report.signals.s1)
  itemSection('S2 done residue', report.signals.s2)
  itemSection('S3 over shape', report.signals.s3, true)
  itemSection('S4 duplicate', report.signals.s4)
  itemSection('S5 aging', report.signals.s5)
  lines.push(
    `  distribution: count=${report.aging.count} min=${age(report.aging.minimumMs)} median=${age(report.aging.medianMs)} max=${age(report.aging.maximumMs)}`,
    '',
    `S6 review blind: ${report.signals.s6.length}`,
    ...report.signals.s6.map(
      (row) => `  session=${row.sessionId} reviews=${row.reviews} items=${row.items}`,
    ),
    '',
    `S7 compaction briefs: ${report.signals.s7.length}`,
    ...report.signals.s7.map(
      (row) =>
        `  session=${row.sessionId} compact=${row.compactBriefs} zero_cursor=${row.zeroCursorBriefs} (${(row.zeroCursorShare * 100).toFixed(1)}%) over_cap=${row.overCapBriefs} (${(row.overCapShare * 100).toFixed(1)}%)`,
    ),
  )
  itemSection('S8 stale citation', report.signals.s8)
  lines.push('', 'Not measured')
  for (const gap of report.notMeasured) lines.push(`  ${gap.criterion}: ${gap.missing}`)
  return lines.join('\n')
}
