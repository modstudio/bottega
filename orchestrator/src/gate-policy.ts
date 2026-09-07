import type { Database } from 'bun:sqlite'
import type { z } from 'zod'
import { HostLoadSchema } from '../../shared/orch-contract.ts'

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

/** Elapsed assertions that must stay well under a lock wait. */
export const ELAPSED_ASSERTION_MS = {
  short: 50,
  moderate: 200,
  long: 1_000,
} as const

export const RETRY_SIGNALS = [
  {
    signal: 'exit-143' as const,
    match: (exitCode: number, _output: string) => exitCode === 143,
  },
  {
    signal: 'timeout' as const,
    match: (_exitCode: number, output: string) =>
      /this test timed out after \d+ms/i.test(output) || /timed out after \d+ms/i.test(output),
  },
  {
    signal: 'lock-wait' as const,
    match: (_exitCode: number, output: string) =>
      /lock wait|waiting for .{0,80} lock/i.test(output),
  },
  {
    signal: 'listen-eperm' as const,
    match: (_exitCode: number, output: string) =>
      /listen[\s\S]{0,80}EPERM|EPERM[\s\S]{0,80}listen/i.test(output),
  },
]
export type RetrySignal = (typeof RETRY_SIGNALS)[number]['signal']

export const FLAKE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const FLAKE_WEEK_LIMIT = 2

export type FilePolicy = { size: TestSize; exclusive?: boolean }

export type ShardSpec = { measuredSeconds?: number; files: string[] }

export type ShardMap = {
  files: Record<string, FilePolicy>
  shards: ShardSpec[]
}

function isTestSize(value: unknown): value is TestSize {
  return typeof value === 'string' && (TEST_SIZES as readonly string[]).includes(value)
}

export function parseShardMap(raw: unknown, source: string): ShardMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source}: shard map must be an object`)
  }
  const value = raw as Record<string, unknown>
  if (value.files === null || typeof value.files !== 'object' || Array.isArray(value.files)) {
    throw new Error(`${source}: files must be an object`)
  }
  const files: Record<string, FilePolicy> = {}
  for (const [path, entry] of Object.entries(value.files as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${source}: ${path} is not a file policy`)
    }
    const policy = entry as Record<string, unknown>
    if (!isTestSize(policy.size)) {
      throw new Error(`${source}: ${path} has invalid size ${JSON.stringify(policy.size)}`)
    }
    if (policy.exclusive !== undefined && typeof policy.exclusive !== 'boolean') {
      throw new Error(`${source}: ${path} has invalid exclusive ${JSON.stringify(policy.exclusive)}`)
    }
    files[path] = policy.exclusive === undefined
      ? { size: policy.size }
      : { size: policy.size, exclusive: policy.exclusive }
  }
  if (!Array.isArray(value.shards)) {
    throw new Error(`${source}: shards must be an array`)
  }
  const shards: ShardSpec[] = []
  for (const [index, shard] of value.shards.entries()) {
    if (shard === null || typeof shard !== 'object' || Array.isArray(shard)) {
      throw new Error(`${source}: shards[${index}] is not a shard`)
    }
    const spec = shard as Record<string, unknown>
    if (!Array.isArray(spec.files) || spec.files.some((file) => typeof file !== 'string')) {
      throw new Error(`${source}: shards[${index}].files must be a string array`)
    }
    const shardFiles = spec.files as string[]
    for (const file of shardFiles) {
      if (!files[file]) {
        throw new Error(`${source}: ${file} is missing from files`)
      }
    }
    const measured = spec.measuredSeconds
    shards.push(
      typeof measured === 'number'
        ? { files: shardFiles, measuredSeconds: measured }
        : { files: shardFiles },
    )
  }
  return { files, shards }
}

export type HostLoad = z.infer<typeof HostLoadSchema>

export type FailingTest = { file: string; test: string }

export type ShardRunResult = {
  name: string
  exitCode: number
  output: string
  files: string[]
  flaky?: boolean
  flakyLine?: string
  question?: string
}

export function formatFlakyLine(name: string): string {
  return `FLAKY ${name} passed after a named-signal failure`
}

export function timeoutMsForSize(size: TestSize): number {
  return TIMEOUT_MS[size]
}

export function dockerInventoryTimeoutForSize(size: TestSize): number {
  return DOCKER_INVENTORY_TIMEOUT_BY_SIZE[size]
}

export function elapsedAssertionMs(size: TestSize): number {
  return ELAPSED_ASSERTION_MS[size]
}

/** Lock wait used with elapsedAssertionMs; a real wait must exceed the elapsed bound. */
export function elapsedLockTimeoutMs(size: TestSize): number {
  return elapsedAssertionMs(size) * 5
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
  return RETRY_SIGNALS.find((row) => row.match(exitCode, output))?.signal ?? null
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
  row: { test: string; file: string; load: HostLoad; signal: RetrySignal; at?: string },
): void {
  database.query(
    `INSERT INTO test_flake (test, file, load_at_failure, signal, at) VALUES (?,?,?,?,?)`,
  ).run(
    row.test,
    row.file,
    JSON.stringify(HostLoadSchema.parse(row.load)),
    row.signal,
    row.at ?? new Date().toISOString(),
  )
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
      flakyLine: formatFlakyLine(opts.name),
    }
  }
  return { name: opts.name, files: opts.files, exitCode: second.exitCode, output: second.output }
}
