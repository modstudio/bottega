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

export type CommittedTimingSummary = {
  unitElapsedMs: number
  files: CommittedTestTiming[]
}

type Reporter = Pick<Console, 'error' | 'log'>

export function readCommittedTimingSummary(): CommittedTimingSummary | undefined {
  const result = Bun.spawnSync(['git', 'show', `HEAD:${TIMING_SUMMARY_LABEL}`], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) return undefined
  const parsed = JSON.parse(result.stdout.toString()) as CommittedTimingSummary | CommittedTestTiming[]
  return Array.isArray(parsed) ? { unitElapsedMs: 0, files: parsed } : parsed
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

function unitTimingResult(
  unitElapsedMs: number,
  committedMs: number | undefined,
  ci: boolean,
  reporter: Reporter,
): { changed: boolean; fatal: boolean; nextMs: number; initial: boolean } {
  const decision = decideTestTiming({ currentMs: unitElapsedMs, committedMs, growthLimit: GROWTH_LIMIT })
  if (decision === 'initial' || decision === 'tighten') {
    const description = decision === 'initial'
      ? 'recorded initial total'
      : `tightened ${committedMs}ms ->`
    reporter.error(`${TIMING_SUMMARY_LABEL}: orchestrator unit ${description} ${unitElapsedMs}ms`)
    return { changed: true, fatal: false, nextMs: unitElapsedMs, initial: decision === 'initial' }
  }
  if (decision === 'fail') {
    const limitMs = Math.floor(committedMs! * (1 + GROWTH_LIMIT))
    reporter.error(`${TIMING_SUMMARY_LABEL}: orchestrator unit total ${unitElapsedMs}ms exceeds 5% growth limit ${limitMs}ms (committed ${committedMs}ms)`)
    reporter.error(`${TIMING_SUMMARY_LABEL}: growth is informational; the suite runtime budget is the gate`)
    return { changed: false, fatal: false, nextMs: committedMs!, initial: false }
  }
  return { changed: false, fatal: false, nextMs: committedMs!, initial: false }
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

export function publishTimingSummary(
  files: FileRow[], unitElapsedMs: number, reporter: Reporter = console,
): boolean {
  const current = summaryRows(files)
  const committedSummary = readCommittedTimingSummary()
  const committed = committedSummary?.files
  const currentTotals = totals(current)
  const committedTotals = committed ? totals(committed) : new Map<string, number>()
  const ci = Boolean(process.env.CI)
  const keepCommitted = new Set<string>()
  let baselineChanged = false
  let fatal = false
  const unit = unitTimingResult(
    unitElapsedMs, committedSummary?.unitElapsedMs || undefined, ci, reporter,
  )
  const reseedFiles = unit.initial
  baselineChanged = unit.changed
  fatal = unit.fatal
  const nextUnitElapsedMs = unit.nextMs
  for (const [packageName, currentMs] of currentTotals) {
    const committedMs = committedTotals.get(packageName)
    const decision = decideTestTiming({ currentMs, committedMs, growthLimit: GROWTH_LIMIT })
    if (decision === 'initial') {
      baselineChanged = true
      reporter.error(`${TIMING_SUMMARY_LABEL}: ${packageName} recorded initial total ${currentMs}ms`)
      continue
    }
    if (decision === 'tighten') {
      baselineChanged = true
      reporter.error(`${TIMING_SUMMARY_LABEL}: ${packageName} tightened ${committedMs}ms -> ${currentMs}ms`)
      continue
    }
    // The baseline only moves down: a package that held or grew keeps its committed rows.
    if (!reseedFiles) keepCommitted.add(packageName)
    if (decision === 'pass') continue
    const limitMs = Math.floor(committedMs! * (1 + GROWTH_LIMIT))
    reporter.error(`${TIMING_SUMMARY_LABEL}: ${packageName} total ${currentMs}ms exceeds 5% growth limit ${limitMs}ms (committed ${committedMs}ms)`)
    reporter.error(`${TIMING_SUMMARY_LABEL}: largest file growth: ${largestGrowth(current, committed!, packageName)}`)
    // Wall clock cannot separate a slower suite from a busier machine, so growth
    // is informational everywhere: the baseline is measured on one machine and
    // its band is narrower than run-to-run jitter, so growth is a trend to read,
    // and the absolute suite runtime budget in scripts/check-runtime.ts is the
    // check that fails a slow suite.
    reporter.error(`${TIMING_SUMMARY_LABEL}: growth is informational; the suite runtime budget is the gate`)
  }
  const next = committed
    ? [
        ...current.filter((row) => !keepCommitted.has(packageOf(row.path))),
        ...committed.filter((row) => keepCommitted.has(packageOf(row.path))),
      ].sort((a, b) => a.path.localeCompare(b.path))
    : current
  if (baselineChanged) {
    writeFileSync(TIMING_SUMMARY_PATH, `${JSON.stringify({ unitElapsedMs: nextUnitElapsedMs, files: next }, null, 2)}\n`)
    reporter.error(`test timing baseline changed; commit ${TIMING_SUMMARY_LABEL} and re-run`)
    return false
  }
  reporter.log(`test timing ratchet: ok (${current.length} files)`)
  return !fatal
}

export function readTimingSummary(): CommittedTestTiming[] {
  const parsed = JSON.parse(readFileSync(TIMING_SUMMARY_PATH, 'utf8')) as CommittedTimingSummary | CommittedTestTiming[]
  return Array.isArray(parsed) ? parsed : parsed.files
}
