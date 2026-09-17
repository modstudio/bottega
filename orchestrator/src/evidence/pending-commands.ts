// concern: evidence
/** Owns pending-evidence reporting and its nonzero result. Must not know CLI grammar. */
import { sessionId } from '../database/db.ts'
import { unrecordedPairsForSession } from '../score/duel.ts'
import { pendingForSession } from './evidence-query.ts'

export function pendingCommand(
  pairHint: (partner: { id: number; agent: string; reason?: string }) => string,
  presentation: { log(value: string): void; setExitCode(code: number): void },
): void {
  const rows = pendingForSession(sessionId())
  const pairs = unrecordedPairsForSession(sessionId())
  if (!rows.length && !pairs.length) {
    presentation.log('nothing of yours is unscored or awaiting comparison')
    return
  }
  renderRows(rows, presentation)
  renderPairs(pairs, rows.length > 0, pairHint, presentation)
  presentation.log('\nOnly you know whether these answers were useful. An unscored run')
  presentation.log('teaches the router nothing, and a guessed score teaches it something false.')
  presentation.setExitCode(1)
}

function renderRows(
  rows: ReturnType<typeof pendingForSession>,
  presentation: { log(value: string): void },
): void {
  if (!rows.length) return
  presentation.log(`${rows.length} run${rows.length === 1 ? '' : 's'} you made are unscored:\n`)
  for (const row of rows)
    presentation.log(
      `  orch score ${row.id} <none|partial|full> [wrong|mixed|right]   # ${row.agent}/${row.job}  ${row.prompt_head.slice(0, 40)}${row.rescore ? '  rescore' : ''}`,
    )
}

function renderPairs(
  pairs: ReturnType<typeof unrecordedPairsForSession>,
  afterRows: boolean,
  pairHint: (partner: { id: number; agent: string; reason?: string }) => string,
  presentation: { log(value: string): void },
): void {
  if (!pairs.length) return
  presentation.log(
    `${afterRows ? '\n' : ''}${pairs.length} scored pair${pairs.length === 1 ? '' : 's'} await comparison:\n`,
  )
  for (const pair of pairs) {
    presentation.log(`  run ${pair.runId}`)
    presentation.log(
      `    ${pairHint({ id: pair.partnerId, agent: pair.partnerAgent, reason: pair.reason })}`,
    )
  }
}
