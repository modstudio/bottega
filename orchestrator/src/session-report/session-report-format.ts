// concern: session-report
/** Human-readable session report presentation. */

import type { SessionReportDelta, SessionWindowReport } from './session-report.ts'
import type { SessionReport } from './session-report-adapter.ts'

const signed = (value: number) => (value > 0 ? `+${value}` : String(value))
const groupLines = (label: string, groups: SessionWindowReport['runsWithoutCursor']['keyless']) => [
  `  ${label}: ${groups.reduce((sum, group) => sum + group.count, 0)}`,
  ...groups.map((group) => `    ${group.job}: ${group.count} (${group.runIds.join(', ')})`),
]

function windowLines(label: string, report: SessionWindowReport): string[] {
  const residue = report.residueAtWindowEnd
  return [
    `${label}: ${report.window.since} to ${report.window.until}`,
    'runs without a cursor:',
    `  total: ${report.runsWithoutCursor.total}`,
    ...groupLines('keyless', report.runsWithoutCursor.keyless),
    ...groupLines('keyed-overridden', report.runsWithoutCursor.keyedOverridden),
    'residue at window end:',
    `  unscored runs: ${residue.unscoredRuns.count}`,
    `  held trees: ${residue.heldTrees.count}`,
    `  open cursors: ${residue.openCursors.count}`,
    ...residue.openCursors.cursors.map((cursor) => `    ${cursor.id}: idle ${cursor.idleMs}ms`),
    `  unanswered questions: ${residue.unansweredQuestions.count}`,
    `hook output: ${report.hookOutput.message}`,
  ]
}

function deltaLines(delta: SessionReportDelta): string[] {
  return [
    'delta (current - comparison):',
    `  runs without a cursor: ${signed(delta.runsWithoutCursor.total)} (keyless ${signed(delta.runsWithoutCursor.keyless)}, keyed-overridden ${signed(delta.runsWithoutCursor.keyedOverridden)})`,
    `  unscored runs: ${signed(delta.residueAtWindowEnd.unscoredRuns)}`,
    `  held trees: ${signed(delta.residueAtWindowEnd.heldTrees)}`,
    `  open cursors: ${signed(delta.residueAtWindowEnd.openCursors)}`,
    `  unanswered questions: ${signed(delta.residueAtWindowEnd.unansweredQuestions)}`,
  ]
}

export function formatSessionReport(report: SessionReport): string {
  return report.sessions
    .flatMap((session) => [
      `session ${session.sessionId}`,
      ...windowLines('current window', session.current),
      ...(session.comparison ? windowLines('comparison window', session.comparison) : []),
      ...(session.delta ? deltaLines(session.delta) : []),
    ])
    .join('\n')
}
