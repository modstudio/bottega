import { readdirSync } from 'node:fs'
import shards from './shards.json'

type Result = { name: string; exitCode: number; files: string[] }

const orchRoot = new URL('..', import.meta.url).pathname
const configured = shards.shards.flatMap((shard) => shard.files)
const present = readdirSync(new URL('../src', import.meta.url))
  .filter((file) => file.endsWith('.cli.test.ts'))
  .map((file) => `src/${file}`)
  .sort()

const duplicates = configured.filter((file, index) => configured.indexOf(file) !== index)
const missing = present.filter((file) => !configured.includes(file))
const stale = configured.filter((file) => !present.includes(file))
if (duplicates.length || missing.length || stale.length) {
  console.error('CLI shard table does not cover each CLI test file exactly once')
  if (duplicates.length) console.error(`duplicates: ${[...new Set(duplicates)].join(', ')}`)
  if (missing.length) console.error(`missing: ${missing.join(', ')}`)
  if (stale.length) console.error(`not found: ${stale.join(', ')}`)
  process.exit(1)
}

async function pump(stream: ReadableStream<Uint8Array>, name: string, error: boolean) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    pending += decoder.decode(chunk.value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop()!
    for (const line of lines) (error ? console.error : console.log)(`[${name}] ${line}`)
  }
  pending += decoder.decode()
  if (pending) (error ? console.error : console.log)(`[${name}] ${pending}`)
}

async function run(name: string, argv: string[], files: string[]): Promise<Result> {
  const child = Bun.spawn(argv, { cwd: orchRoot, stdout: 'pipe', stderr: 'pipe' })
  await Promise.all([
    pump(child.stdout, name, false),
    pump(child.stderr, name, true),
  ])
  return { name, exitCode: await child.exited, files }
}

// Four CLI workers are the measured cap. Keep the unchanged unit process out
// of that resource-heavy window; the root gate still runs hub and web beside
// both phases.
const unit = await run('orchestrator unit', ['bun', 'run', 'test:unit'], [])
const cli = await Promise.all(shards.shards.map((shard, index) => run(
    `orchestrator CLI shard ${index + 1}/${shards.shards.length}`,
    ['bun', 'test', ...shard.files],
    shard.files,
  )))
const results = [unit, ...cli]

for (const result of results) {
  if (result.exitCode === 0) continue
  console.error(`${result.name} failed with exit ${result.exitCode}`)
  if (result.files.length) console.error(`failing shard files: ${result.files.join(', ')}`)
  console.error(`the prefixed Bun failure above names the failing test`)
}
process.exit(results.some((result) => result.exitCode !== 0) ? 1 : 0)
