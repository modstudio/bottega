// concern: monitor-run-token-jump
/** Reports agent/job cells whose median tokens per run jumped during the current day. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { MIN_SAMPLE } from '../route/route.ts'
import { median } from '../state/statistics.ts'
import type { MonitorCondition } from './monitor-types.ts'

export const TOKENS_PER_RUN_JUMP_RATIO = 1.5
const DAY_MS = 24 * 60 * 60 * 1000
const BASELINE_DAYS = 7

export type RunTokenCell = {
  agent: string
  job: string
  recentTokens: number[]
  baselineTokens: number[]
}

export type RunTokenJump = {
  agent: string
  job: string
  recentMedian: number
  baselineMedian: number
  recentRuns: number
  baselineRuns: number
}

/** Decide the report from already-windowed cell values, without store or clock access. */
export function runTokenJump(cell: RunTokenCell): RunTokenJump | null {
  if (cell.recentTokens.length < MIN_SAMPLE || cell.baselineTokens.length < MIN_SAMPLE) return null
  const recentMedian = median(cell.recentTokens)!
  const baselineMedian = median(cell.baselineTokens)!
  if (recentMedian <= TOKENS_PER_RUN_JUMP_RATIO * baselineMedian) return null
  return {
    agent: cell.agent,
    job: cell.job,
    recentMedian,
    baselineMedian,
    recentRuns: cell.recentTokens.length,
    baselineRuns: cell.baselineTokens.length,
  }
}

/** Gather the current and preceding windows and render report-only monitor conditions. */
export function runTokenJumpConditions(database: Database, clock: number): MonitorCondition[] {
  const recentStart = new Date(clock - DAY_MS).toISOString()
  const baselineStart = new Date(clock - (BASELINE_DAYS + 1) * DAY_MS).toISOString()
  const end = new Date(clock).toISOString()
  const rows = database
    .query(
      `SELECT agent,job,started_at,vendor_tokens FROM run
       WHERE started_at>=? AND started_at<? AND vendor_tokens IS NOT NULL
         AND status IN ('ok','failed','stale') AND probe=0
         AND executor<>'harness' AND parent_run_record_id IS NULL`,
    )
    .all(baselineStart, end) as Array<{
    agent: string
    job: string
    started_at: string
    vendor_tokens: number
  }>
  const cells = new Map<string, RunTokenCell>()
  for (const row of rows) {
    const key = `${row.agent}\u0000${row.job}`
    const cell = cells.get(key) ?? {
      agent: row.agent,
      job: row.job,
      recentTokens: [],
      baselineTokens: [],
    }
    ;(row.started_at >= recentStart ? cell.recentTokens : cell.baselineTokens).push(
      row.vendor_tokens,
    )
    cells.set(key, cell)
  }
  return [...cells.values()].flatMap((cell) => {
    const jump = runTokenJump(cell)
    if (!jump) return []
    return [
      {
        kind: 'run-token-jump',
        subject: `${jump.agent}:${jump.job}`,
        since: recentStart,
        ageMs: null,
        severity: 'informational',
        detail:
          `${jump.agent} ${jump.job} median tokens per run is ${Math.round(jump.recentMedian).toLocaleString()} ` +
          `over ${jump.recentRuns} runs in the last 24 hours, versus ${Math.round(jump.baselineMedian).toLocaleString()} ` +
          `over ${jump.baselineRuns} runs in the previous 7 days`,
        action: `reported; inspect ${PLATFORM_SLUG} agent stats --job ${jump.job}`,
      },
    ]
  })
}
