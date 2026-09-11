/**
 * Publishes the latest gate measurement and compares package totals with the
 * committed surface. It knows timing rows, not how the gate runs tests.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { decideTestTiming } from '../../scripts/quality/test-timing-decision.ts'
import type { FileRow } from './record-gate-timings.ts'

const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
export const TIMING_SUMMARY_LABEL = 'scripts/quality/test-timings.json'
export const TIMING_SUMMARY_PATH = `${root}/${TIMING_SUMMARY_LABEL}`
const GROWTH_LIMIT = 0.05

export type CommittedTestTiming = {
  path: string
  wallMs: number
  tests: number
  cliShaped: boolean
  spawns: number
}

type Reporter = Pick<Console, 'error' | 'log'>

export function readCommittedTimingSummary(): CommittedTestTiming[] | undefined {
  const result = Bun.spawnSync(['git', 'show', `HEAD:${TIMING_SUMMARY_LABEL}`], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) return undefined
  return JSON.parse(result.stdout.toString()) as CommittedTestTiming[]
}

function packageOf(path: string): string {
  return path.split('/', 1)[0]!
}

function totals(rows: CommittedTestTiming[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const row of rows) result.set(packageOf(row.path), (result.get(packageOf(row.path)) ?? 0) + row.wallMs)
  return result
}

function largestGrowth(
  current: CommittedTestTiming[], committed: CommittedTestTiming[], packageName: string,
): string {
  const prior = new Map(committed.map((row) => [row.path, row.wallMs]))
  const growth = current
    .filter((row) => packageOf(row.path) === packageName)
    .map((row) => ({ path: row.path, delta: row.wallMs - (prior.get(row.path) ?? 0) }))
    .filter((row) => row.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3)
  return growth.map((row) => `${row.path} +${row.delta}ms`).join(', ') || '(no individual file grew)'
}

export function summaryRows(files: FileRow[]): CommittedTestTiming[] {
  return files.filter((file) => file.file.endsWith('.test.ts')).map((file) => ({
    path: `orchestrator/${file.file}`,
    wallMs: Math.round(file.wallMs),
    tests: file.tests,
    cliShaped: file.file.endsWith('.cli.test.ts'),
    spawns: file.spawn + file.spawnSync,
  })).sort((a, b) => a.path.localeCompare(b.path))
}

export function publishTimingSummary(files: FileRow[], reporter: Reporter = console): boolean {
  const current = summaryRows(files)
  const committed = readCommittedTimingSummary()
  writeFileSync(TIMING_SUMMARY_PATH, `${JSON.stringify(current, null, 2)}\n`)
  const currentTotals = totals(current)
  const committedTotals = committed ? totals(committed) : new Map<string, number>()
  let passed = true
  for (const [packageName, currentMs] of currentTotals) {
    const committedMs = committedTotals.get(packageName)
    const decision = decideTestTiming({ currentMs, committedMs, growthLimit: GROWTH_LIMIT })
    if (decision === 'pass') continue
    passed = false
    if (decision === 'initial') {
      reporter.error(`${TIMING_SUMMARY_LABEL}: ${packageName} recorded initial total ${currentMs}ms`)
      continue
    }
    if (decision === 'tighten') {
      reporter.error(`${TIMING_SUMMARY_LABEL}: ${packageName} tightened ${committedMs}ms -> ${currentMs}ms`)
      continue
    }
    const limitMs = Math.floor(committedMs! * (1 + GROWTH_LIMIT))
    reporter.error(`${TIMING_SUMMARY_LABEL}: ${packageName} total ${currentMs}ms exceeds 5% growth limit ${limitMs}ms (committed ${committedMs}ms)`)
    reporter.error(`${TIMING_SUMMARY_LABEL}: largest file growth: ${largestGrowth(current, committed!, packageName)}`)
  }
  if (!passed) {
    reporter.error(`test timing baseline changed; commit ${TIMING_SUMMARY_LABEL} and re-run`)
    return false
  }
  reporter.log(`test timing ratchet: ok (${current.length} files)`)
  return true
}

export function readTimingSummary(): CommittedTestTiming[] {
  return JSON.parse(readFileSync(TIMING_SUMMARY_PATH, 'utf8')) as CommittedTestTiming[]
}
