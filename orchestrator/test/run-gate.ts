import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Database } from 'bun:sqlite'
import shards from './shards.json'
import {
  dockerInventoryTimeoutForSize,
  exclusiveShareViolations,
  mainCheckoutFlakeStore,
  parseShardMap,
  recordTestFlake,
  runWithRetry,
  shardSize,
  shardTimeoutMs,
  weeklyFlakeCount,
  type FlakeStore,
} from '../src/gate-policy.ts'
import { measureHostLoad, withGateSlot } from '../src/gate-load.ts'
import { mergeTimings, type GateTimings } from './record-gate-timings.ts'
import {
  publishTimingSummary,
  readCommittedTimingSummary,
  type CommittedTestTiming,
} from './gate-timing-summary.ts'

type Result = { name: string; exitCode: number; files: string[]; flaky?: boolean }

const orchRoot = new URL('..', import.meta.url).pathname
const map = parseShardMap(shards, new URL('./shards.json', import.meta.url).pathname)
const configured = map.shards.flatMap((shard) => shard.files)
const timingStamp = new Date().toISOString().replace(/[:.]/g, '-')
const timingDir = new URL('../runs/gate-timings/', import.meta.url).pathname
const timingPath = `${timingDir}${timingStamp}.json`
mkdirSync(timingDir, { recursive: true })
const invocationTimings = new Map<string, GateTimings>()
const declaredBoundaryTests = configured.filter((file) =>
  file.startsWith('test/process-boundary/') && existsSync(new URL(`../${file}`, import.meta.url)))
const present = [...declaredBoundaryTests].sort()

const declared = Object.keys(map.files).sort()
const declaredBoundary = declared.filter((file) => file.startsWith('test/process-boundary/'))
const duplicates = configured.filter((file, index) => configured.indexOf(file) !== index)
const missing = present.filter((file) => !configured.includes(file))
const stale = configured.filter((file) => !present.includes(file))
const undeclared = present.filter((file) => !map.files[file])
const extraDeclared = declaredBoundary.filter((file) => !present.includes(file))
const exclusiveViolations = exclusiveShareViolations(map)
if (duplicates.length || missing.length || stale.length || undeclared.length || extraDeclared.length
  || exclusiveViolations.length) {
  console.error('process-boundary shard table does not cover each boundary test file exactly once')
  if (duplicates.length) console.error(`duplicates: ${[...new Set(duplicates)].join(', ')}`)
  if (missing.length) console.error(`missing: ${missing.join(', ')}`)
  if (stale.length) console.error(`not found: ${stale.join(', ')}`)
  if (undeclared.length) console.error(`no size declared: ${undeclared.join(', ')}`)
  if (extraDeclared.length) console.error(`declared but absent: ${extraDeclared.join(', ')}`)
  if (exclusiveViolations.length) {
    console.error('exclusive files share a shard: '
      + exclusiveViolations.map((files) => files.join(', ')).join(' | '))
  }
  process.exit(1)
}

async function pump(
  stream: ReadableStream<Uint8Array>, name: string, error: boolean, sink: string[],
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    pending += decoder.decode(chunk.value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop()!
    for (const line of lines) {
      sink.push(line)
      ;(error ? console.error : console.log)(`[${name}] ${line}`)
    }
  }
  pending += decoder.decode()
  if (pending) {
    sink.push(pending)
    ;(error ? console.error : console.log)(`[${name}] ${pending}`)
  }
}

async function spawnTest(
  name: string, argv: string[], files: string[], env: NodeJS.ProcessEnv, timingKey: string,
): Promise<Result & { output: string }> {
  const junitPath = `${timingDir}${timingStamp}.${timingKey}.junit.xml`
  const sidecarBase = `${timingDir}${timingStamp}.${timingKey}.json`
  const command = [...argv, '--reporter=junit', `--reporter-outfile=${junitPath}`]
  const started = Date.now()
  const child = Bun.spawn(command, {
    cwd: orchRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...env, ORCH_GATE_TIMINGS: sidecarBase },
  })
  const sink: string[] = []
  await Promise.all([
    pump(child.stdout, name, false, sink),
    pump(child.stderr, name, true, sink),
  ])
  const exitCode = await child.exited
  const elapsedMs = Date.now() - started
  const sidecarPath = `${sidecarBase}.spawn.json`
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'))
  const timing = mergeTimings(sidecar, readFileSync(junitPath, 'utf8'), {
    stamp: timingStamp,
    command,
    elapsedMs,
    exitCode,
  })
  invocationTimings.set(timingKey, timing)
  unlinkSync(junitPath)
  unlinkSync(sidecarPath)
  return { name, exitCode, files, output: sink.join('\n') }
}

function balancedShards(summary: CommittedTestTiming[] | undefined): string[][] {
  const recorded = new Map(summary?.map((row) => [row.path, row.wallMs]) ?? [])
  const fallback = new Map<string, number>()
  for (const shard of map.shards) {
    const perFile = ((shard.measuredSeconds ?? shard.files.length) * 1_000) / shard.files.length
    for (const file of shard.files) fallback.set(file, perFile)
  }
  const ranked = [...configured].sort((a, b) =>
    (recorded.get(`orchestrator/${b}`) ?? fallback.get(b) ?? 0)
      - (recorded.get(`orchestrator/${a}`) ?? fallback.get(a) ?? 0))
  const balanced = map.shards.map(() => ({ files: [] as string[], wallMs: 0, exclusive: false }))
  for (const file of ranked) {
    const candidates = map.files[file]?.exclusive
      ? balanced.filter((shard) => !shard.exclusive)
      : balanced
    const target = candidates.reduce((lightest, shard) => shard.wallMs < lightest.wallMs ? shard : lightest)
    target.files.push(file)
    target.wallMs += recorded.get(`orchestrator/${file}`) ?? fallback.get(file) ?? 0
    if (map.files[file]?.exclusive) target.exclusive = true
  }
  return balanced.map((shard) => shard.files)
}

function aggregateTimings(exitCode: number, elapsedMs: number): GateTimings {
  const timings = [...invocationTimings.values()]
  return {
    stamp: timingStamp,
    command: ['bun', 'run', 'test:gate'],
    elapsedMs,
    exitCode,
    tests: timings.flatMap((timing) => timing.tests),
    files: timings.flatMap((timing) => timing.files),
  }
}

function printTopTen(timing: GateTimings) {
  console.log('orchestrator test wall time top ten:')
  for (const file of [...timing.files].sort((a, b) => b.wallMs - a.wallMs).slice(0, 10)) {
    console.log(`${file.file} ${Math.round(file.wallMs)}ms`)
  }
}

async function flakeStore(): Promise<FlakeStore | null> {
  try {
    const dbMod = await import('../src/db.ts')
    if (dbMod.linkedWorktreeReadOnly) return mainCheckoutFlakeStore(process.cwd())
    const database: Database = dbMod.writableDb()
    return {
      count: (test, file) => weeklyFlakeCount(database, test, file),
      record: (row) => recordTestFlake(database, row),
    }
  } catch {
    return null
  }
}

async function runGateTest(
  name: string,
  files: string[],
  run: () => Promise<Result & { output: string }>,
  store: FlakeStore | null,
): Promise<Result> {
  const result = await runWithRetry({
    name,
    files,
    run,
    weeklyCount: (test, file) => store ? store.count(test, file) : 0,
    recordFlake: (row) => {
      if (!store) {
        console.error(`FLAKY ${row.file} ${row.test} (${row.signal}); flake store is unavailable`)
        return
      }
      store.record({ test: row.test, file: row.file, load: measureHostLoad(), signal: row.signal })
    },
  })
  if (result.question) console.error(result.question)
  if (result.flakyLine) console.error(result.flakyLine)
  return result
}

const gateStarted = Date.now()
const store = await flakeStore()
const unitName = 'orchestrator unit'
const moderateUnitFiles = Object.entries(map.files)
  .filter(([file, policy]) => file.startsWith('src/') && policy.size === 'moderate')
  .map(([file]) => file)
  .sort()
const unitResults = await withGateSlot(async () => {
  const unitShort = await runGateTest(unitName, [], () => spawnTest(unitName, [
    'bun', 'test', '--path-ignore-patterns', 'runs/**', '--path-ignore-patterns', '**/runs/**',
    ...declaredBoundaryTests.flatMap((file) => ['--path-ignore-patterns', file]),
    ...moderateUnitFiles.flatMap((file) => ['--path-ignore-patterns', file]),
  ], [], process.env, 'unit-short'), store)
  const unitModerate = moderateUnitFiles.length
    ? await runGateTest(`${unitName} moderate`, moderateUnitFiles, () => spawnTest(
        `${unitName} moderate`, ['bun', 'test', '--timeout', String(shardTimeoutMs(map.files, moderateUnitFiles)), ...moderateUnitFiles],
        moderateUnitFiles, process.env, 'unit-moderate',
      ), store)
    : null
  return unitModerate ? [unitShort, unitModerate] : [unitShort]
})
const shardGroups = balancedShards(readCommittedTimingSummary()?.files)
const boundary = await withGateSlot(() => Promise.all(shardGroups.map(async (files, index) => {
    const name = `orchestrator process-boundary shard ${index + 1}/${map.shards.length}`
    const timeout = shardTimeoutMs(map.files, files)
    const size = shardSize(map.files, files)
    const env = {
      ...process.env,
      ORCH_DOCKER_INVENTORY_TIMEOUT_MS: String(dockerInventoryTimeoutForSize(size)),
    }
    const argv = ['bun', 'test', '--timeout', String(timeout), ...files]
    return runGateTest(
      name, files, () => spawnTest(name, argv, files, env, `cli-${index + 1}`), store,
    )
})))

const results: Result[] = [...unitResults, ...boundary]
for (const result of results) {
  if (result.exitCode === 0) continue
  console.error(`${result.name} failed with exit ${result.exitCode}`)
  if (result.files.length) console.error(`failing shard files: ${result.files.join(', ')}`)
  console.error(`the prefixed Bun failure above names the failing test`)
}
const testFailed = results.some((result) => result.exitCode !== 0)
const timing = aggregateTimings(testFailed ? 1 : 0, Date.now() - gateStarted)
writeFileSync(timingPath, `${JSON.stringify(timing, null, 2)}\n`)
console.log(`wrote ${timingPath}`)
printTopTen(timing)
const unitElapsedMs = unitResults.reduce((sum, result) => {
  const key = result.name === unitName ? 'unit-short' : 'unit-moderate'
  return sum + (invocationTimings.get(key)?.elapsedMs ?? 0)
}, 0)
const timingPassed = publishTimingSummary(timing.files, unitElapsedMs)
process.exit(testFailed || !timingPassed ? 1 : 0)
