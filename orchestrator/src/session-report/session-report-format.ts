// concern: session-report
/** Human-readable session report presentation. */

import { duration } from '../commands/support.ts'
import type { SessionReportDelta, SessionWindowReport } from './session-report.ts'
import type { SessionReport } from './session-report-adapter.ts'

const signed = (value: number) => (value > 0 ? `+${value}` : String(value))
const groupLines = (label: string, groups: SessionWindowReport['runsWithoutCursor']['keyless']) => [
  `  ${label}: ${groups.reduce((sum, group) => sum + group.count, 0)}`,
  ...groups.map((group) => `    ${group.job}: ${group.count}`),
]

function windowLines(label: string, report: SessionWindowReport): string[] {
  const residue = report.residueAtWindowEnd
  return [
    `${label}: ${report.window.since} to ${report.window.until}`,
    'runs without a cursor:',
    `  total: ${report.runsWithoutCursor.total}`,
    ...groupLines('keyless', report.runsWithoutCursor.keyless),
    ...groupLines('keyed, no open task cursor', report.runsWithoutCursor.keyedUncovered),
    ...groupLines(
      `on a task cursor but not bound${report.runsWithoutCursor.admitted.asOf === 'approximate' ? ' (approximate)' : ''}`,
      report.runsWithoutCursor.admitted.byJob,
    ),
    'residue at window end:',
    `  unscored runs${residue.unscoredRuns.asOf === 'approximate' ? ' (approximate)' : ''}: ${residue.unscoredRuns.count}`,
    `  held trees${residue.heldTrees.asOf === 'now' ? ' (current)' : ''}: ${residue.heldTrees.count}`,
    `  open cursors${residue.openCursors.asOf === 'approximate' ? ' (approximate)' : ''}: ${residue.openCursors.count}`,
    ...residue.openCursors.cursors.map(
      (cursor) =>
        `    ${cursor.number || cursor.id} ${cursor.workflow}${cursor.taskKey ? ` ${cursor.taskKey}` : ''}: idle ${duration(cursor.idleMs)}`,
    ),
    `  unanswered questions: ${residue.unansweredQuestions.count}`,
    `hook output: ${report.hookOutput.message}`,
  ]
}

function deltaLines(delta: SessionReportDelta): string[] {
  return [
    'delta (current - comparison):',
    `  runs without a cursor: ${signed(delta.runsWithoutCursor.total)} (keyless ${signed(delta.runsWithoutCursor.keyless)}, keyed, no open task cursor ${signed(delta.runsWithoutCursor.keyedUncovered)})`,
    `  on a task cursor but not bound: ${signed(delta.runsWithoutCursor.admitted)}`,
    `  unscored runs: ${signed(delta.residueAtWindowEnd.unscoredRuns)}`,
    '  held trees: n/a',
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
