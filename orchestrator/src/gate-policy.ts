import type { Database } from 'bun:sqlite'

export const TEST_SIZES = ['short', 'moderate', 'long'] as const
export type TestSize = (typeof TEST_SIZES)[number]

export const TIMEOUT_MS = {
  short: 30_000,
  moderate: 120_000,
  long: 600_000,
  unit: 5_000,
} as const

export const DOCKER_INVENTORY_TIMEOUT_BY_SIZE = {
  short: 1_000,
  moderate: 4_000,
  long: 20_000,
} as const

export const RETRY_SIGNALS = ['timeout', 'exit-143', 'lock-wait', 'listen-eperm'] as const
export type RetrySignal = (typeof RETRY_SIGNALS)[number]

export const FLAKE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const FLAKE_WEEK_LIMIT = 2

export type FilePolicy = { size: TestSize; exclusive?: boolean }

export type ShardSpec = { measuredSeconds?: number; files: string[] }

export type ShardMap = {
  files: Record<string, FilePolicy>
  shards: ShardSpec[]
}

export type HostLoad = {
  gates: number
  loadavg: number
  ncpu: number
  freeMem: number
}

export type FailingTest = { file: string; test: string }

export type ShardRunResult = {
  name: string
  exitCode: number
  output: string
  files: string[]
  flaky?: boolean
  question?: string
}

export function timeoutMsForSize(size: TestSize): number {
  return TIMEOUT_MS[size]
}

export function dockerInventoryTimeoutForSize(size: TestSize): number {
  return DOCKER_INVENTORY_TIMEOUT_BY_SIZE[size]
}

export function shardSize(files: Record<string, FilePolicy>, paths: string[]): TestSize {
  let size: TestSize = 'short'
  for (const path of paths) {
    const declared = files[path]?.size
    if (declared === 'long') return 'long'
    if (declared === 'moderate') size = 'moderate'
  }
  return size
}

export function shardTimeoutMs(files: Record<string, FilePolicy>, paths: string[]): number {
  return timeoutMsForSize(shardSize(files, paths))
}

export function namedFailureSignal(exitCode: number, output: string): RetrySignal | null {
  if (exitCode === 143) return 'exit-143'
  if (/this test timed out after \d+ms/i.test(output) || /timed out after \d+ms/i.test(output)) {
    return 'timeout'
  }
  if (/lock wait|waiting for .{0,80} lock/i.test(output)) return 'lock-wait'
  if (/listen[\s\S]{0,80}EPERM|EPERM[\s\S]{0,80}listen/i.test(output)) return 'listen-eperm'
  return null
}

export function failingTests(output: string): FailingTest[] {
  const found: FailingTest[] = []
  let file = '(unknown)'
  for (const line of output.split('\n')) {
    const stripped = line.replace(/^(?:\[[^\]]+\]\s*)+/, '')
    const fileMatch = stripped.match(/^(src\/\S+\.cli\.test\.ts)\b/)
    if (fileMatch) file = fileMatch[1]!
    const fail = stripped.match(/^\(fail\)\s+(.+)$/)
    if (fail) found.push({ file, test: fail[1]!.trim() })
  }
  return found
}

export function exclusiveShareViolations(map: ShardMap): string[][] {
  const violations: string[][] = []
  for (const shard of map.shards) {
    const exclusive = shard.files.filter((path) => map.files[path]?.exclusive)
    if (exclusive.length > 1) violations.push(exclusive)
  }
  return violations
}

export function weeklyFlakeCount(
  database: Database,
  test: string,
  file: string,
  now = new Date(),
): number {
  const from = new Date(now.getTime() - FLAKE_WEEK_MS).toISOString()
  const row = database.query(
    `SELECT COUNT(*) AS n FROM test_flake
      WHERE test=? AND file=? AND datetime(at) >= datetime(?)`,
  ).get(test, file, from) as { n: number } | null
  return row?.n ?? 0
}

export function recordTestFlake(
  database: Database,
  row: { test: string; file: string; load: HostLoad; at?: string },
): void {
  database.query(
    `INSERT INTO test_flake (test, file, load_at_failure, at) VALUES (?,?,?,?)`,
  ).run(row.test, row.file, JSON.stringify(row.load), row.at ?? new Date().toISOString())
}

export async function runWithRetry(opts: {
  name: string
  files: string[]
  run: () => Promise<Pick<ShardRunResult, 'exitCode' | 'output'>>
  weeklyCount: (test: string, file: string) => number
  recordFlake: (row: FailingTest & { signal: RetrySignal }) => void
}): Promise<ShardRunResult> {
  const first = await opts.run()
  const base = { name: opts.name, files: opts.files, exitCode: first.exitCode, output: first.output }
  if (first.exitCode === 0) return base
  const signal = namedFailureSignal(first.exitCode, first.output)
  if (!signal) return base
  const fails = failingTests(first.output)
  const subjects = fails.length ? fails : [{ file: opts.files[0] ?? opts.name, test: opts.name }]
  const blocked = subjects.find((row) => opts.weeklyCount(row.test, row.file) >= FLAKE_WEEK_LIMIT)
  if (blocked) {
    const question =
      `QUESTION: ${blocked.test} in ${blocked.file} has flaked twice this week; not retrying`
    return { ...base, question }
  }
  const second = await opts.run()
  if (second.exitCode === 0) {
    for (const row of subjects) opts.recordFlake({ ...row, signal })
    return {
      name: opts.name,
      files: opts.files,
      exitCode: 0,
      output: second.output,
      flaky: true,
    }
  }
  return { name: opts.name, files: opts.files, exitCode: second.exitCode, output: second.output }
}
