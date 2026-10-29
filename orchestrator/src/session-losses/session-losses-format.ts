// concern: session-losses-format
/** Presents compaction-loss reports without knowing their sources. */

import type { SessionLossResult } from './session-losses-adapter.ts'

const number = (value: number | null) => (value === null ? '—' : Math.round(value).toLocaleString())

export function formatSessionLosses(reports: SessionLossResult[]): string {
  if (!reports.length) return 'no sessions matched after reading the transcript data'
  return reports
    .map((report) => {
      if ('error' in report) return `session ${report.sessionId}\n  error ${report.error}`
      const lines = [
        `session ${report.sessionId}`,
        `  wall hours ${report.wallHours.toFixed(2)}`,
        `  tokens/session-hour input=${number(report.tokensPerSessionHour.input)} cache-read=${number(report.tokensPerSessionHour.cacheRead)} cache-creation=${number(report.tokensPerSessionHour.cacheCreation)} output=${number(report.tokensPerSessionHour.output)} total=${number(report.tokensPerSessionHour.total)}`,
        `  cost/session-hour ${report.costPerSessionHour}`,
      ]
      for (const boundary of report.boundaries) {
        lines.push(
          `  boundary ${boundary.at} trigger=${boundary.trigger} pre=${number(boundary.preTokens)} post=${number(boundary.postTokens)}`,
          `    before turns=${boundary.before.turns} mean=${number(boundary.before.mean)} p90=${number(boundary.before.p90)}; after turns=${boundary.after.turns} mean=${number(boundary.after.mean)} p90=${number(boundary.after.p90)}`,
          `    lost runs=${boundary.lost.runs.count} [${boundary.lost.runs.ids.join(', ')}] cursors=${boundary.lost.cursors.count} [${boundary.lost.cursors.ids.join(', ')}] claims=${boundary.lost.claims.count} [${boundary.lost.claims.ids.join(', ')}]`,
          `    candidates=${boundary.candidateCount} file=${boundary.candidateFile}${boundary.judge ? ` judge=${boundary.judge.runId ?? '-'} (${boundary.judge.status}, rubric=${boundary.judge.rubricRevision ?? '-'})${boundary.judge.error ? ` error=${boundary.judge.error}` : ''}` : ''}`,
        )
      }
      return lines.join('\n')
    })
    .join('\n\n')
}
