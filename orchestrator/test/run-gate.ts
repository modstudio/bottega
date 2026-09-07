import { readdirSync } from 'node:fs'
import type { Database } from 'bun:sqlite'
import shards from './shards.json'
import {
  dockerInventoryTimeoutForSize,
  exclusiveShareViolations,
  recordTestFlake,
  runWithRetry,
  shardSize,
  shardTimeoutMs,
  weeklyFlakeCount,
  type FilePolicy,
  type ShardMap,
} from '../src/gate-policy.ts'
import { holdForGateCapacity, measureHostLoad, registerGatePid } from '../src/gate-load.ts'

type Result = { name: string; exitCode: number; files: string[]; flaky?: boolean }

const orchRoot = new URL('..', import.meta.url).pathname
const map = shards as ShardMap
const configured = map.shards.flatMap((shard) => shard.files)
const present = readdirSync(new URL('../src', import.meta.url))
  .filter((file) => file.endsWith('.cli.test.ts'))
  .map((file) => `src/${file}`)
  .sort()

const declared = Object.keys(map.files).sort()
const duplicates = configured.filter((file, index) => configured.indexOf(file) !== index)
const missing = present.filter((file) => !configured.includes(file))
const stale = configured.filter((file) => !present.includes(file))
const undeclared = present.filter((file) => !map.files[file])
const extraDeclared = declared.filter((file) => !present.includes(file))
const exclusiveViolations = exclusiveShareViolations(map)
if (duplicates.length || missing.length || stale.length || undeclared.length || extraDeclared.length
  || exclusiveViolations.length) {
  console.error('CLI shard table does not cover each CLI test file exactly once')
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
  name: string, argv: string[], files: string[], env: NodeJS.ProcessEnv,
): Promise<Result & { output: string }> {
  const child = Bun.spawn(argv, { cwd: orchRoot, stdout: 'pipe', stderr: 'pipe', env })
  const sink: string[] = []
  await Promise.all([
    pump(child.stdout, name, false, sink),
    pump(child.stderr, name, true, sink),
  ])
  return { name, exitCode: await child.exited, files, output: sink.join('\n') }
}

async function flakeStore(): Promise<Database | null> {
  try {
    const dbMod = await import('../src/db.ts')
    if (dbMod.linkedWorktreeReadOnly) return null
    return dbMod.writableDb()
  } catch {
    return null
  }
}

const unregister = registerGatePid()
try {
  const store = await flakeStore()
  const unit = await spawnTest('orchestrator unit', ['bun', 'run', 'test:unit'], [], process.env)
  const cli = await Promise.all(map.shards.map(async (shard, index) => {
    const name = `orchestrator CLI shard ${index + 1}/${map.shards.length}`
    const files = shard.files as string[]
    const policy = map.files as Record<string, FilePolicy>
    const timeout = shardTimeoutMs(policy, files)
    const size = shardSize(policy, files)
    const env = {
      ...process.env,
      ORCH_DOCKER_INVENTORY_TIMEOUT_MS: String(dockerInventoryTimeoutForSize(size)),
    }
    const argv = ['bun', 'test', '--timeout', String(timeout), ...files]
    const result = await runWithRetry({
      name,
      files,
      run: async () => {
        const held = await holdForGateCapacity()
        if (held.held) {
          console.error(`${name} held ${held.delayedMs}ms for host load `
            + `(gates=${held.load.gates} loadavg=${held.load.loadavg} ncpu=${held.load.ncpu})`)
        }
        return spawnTest(name, argv, files, env)
      },
      weeklyCount: (test, file) => store ? weeklyFlakeCount(store, test, file) : 0,
      recordFlake: (row) => {
        if (!store) {
          console.error(`FLAKY ${row.file} ${row.test} (${row.signal}); `
            + 'linked worktree cannot persist the flake table')
          return
        }
        recordTestFlake(store, { test: row.test, file: row.file, load: measureHostLoad() })
      },
    })
    if (result.question) console.error(result.question)
    if (result.flaky) console.error(`FLAKY ${name} passed after a named-signal failure`)
    return result
  }))

  const results: Result[] = [unit, ...cli]
  for (const result of results) {
    if (result.exitCode === 0) continue
    console.error(`${result.name} failed with exit ${result.exitCode}`)
    if (result.files.length) console.error(`failing shard files: ${result.files.join(', ')}`)
    console.error(`the prefixed Bun failure above names the failing test`)
  }
  process.exit(results.some((result) => result.exitCode !== 0) ? 1 : 0)
} finally {
  unregister()
}
