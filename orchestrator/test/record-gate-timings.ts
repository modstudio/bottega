/**
 * Run the orchestrator CLI test leg (or a supplied file list) with the
 * gate-timings reporter, merge bun's junit per-test times, and write
 * orchestrator/runs/gate-timings/<stamp>.json plus a markdown summary.
 *
 * Usage:
 *   bun test/record-gate-timings.ts
 *   bun test/record-gate-timings.ts src/route.cli.test.ts src/route.test.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const orchRoot = join(import.meta.dir, '..')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = join(orchRoot, 'runs', 'gate-timings')
mkdirSync(outDir, { recursive: true })
const jsonPath = join(outDir, `${stamp}.json`)
const junitPath = join(outDir, `${stamp}.junit.xml`)
const files = Bun.argv.slice(2)
const testArgs = files.length ? files : ['.cli.test.ts']

export type SpawnCounts = {
  spawn: number
  spawnSync: number
  bootstraps: number
  cli: number
  git: number
  other: number
  argv0: Record<string, number>
}

export type TestRow = {
  name: string
  file: string
  wallMs: number
  pass: boolean
  failure?: string
}

export type FileRow = SpawnCounts & {
  file: string
  wallMs: number
  tests: number
  failed: number
}

export type GateTimings = {
  stamp: string
  command: string[]
  elapsedMs: number
  exitCode: number
  tests: TestRow[]
  files: FileRow[]
}

function rel(path: string): string {
  if (!path) return path
  const raw = path.startsWith('file://') ? fileURLToPath(path) : path
  if (!raw.startsWith('/')) return raw.replace(/^\.\//, '')
  const fromRoot = relative(orchRoot, raw)
  if (fromRoot && !fromRoot.startsWith('..')) return fromRoot
  const idx = raw.lastIndexOf('/src/')
  if (idx !== -1) return raw.slice(idx + 1)
  return raw
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

function parseJunit(xml: string): {
  tests: TestRow[]
  fileWall: Map<string, number>
  suiteTests: Map<string, number>
  suiteFailures: Map<string, number>
} {
  const fileWall = new Map<string, number>()
  const suiteTests = new Map<string, number>()
  const suiteFailures = new Map<string, number>()
  for (const suite of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const attrs = suite[1]!
    const file = rel(attrs.match(/\bfile="([^"]+)"/)?.[1] ?? '')
    const timeS = Number(attrs.match(/\btime="([^"]+)"/)?.[1] ?? 0)
    if (file) {
      fileWall.set(file, Math.max(fileWall.get(file) ?? 0, timeS * 1000))
      suiteTests.set(file, Number(attrs.match(/\btests="([^"]+)"/)?.[1] ?? 0))
      suiteFailures.set(file, Number(attrs.match(/\bfailures="([^"]+)"/)?.[1] ?? 0))
    }
  }
  const tests: TestRow[] = []
  for (const node of xml.matchAll(/<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const tAttrs = node[1]!
    const tBody = node[2] ?? ''
    const name = decodeXml(tAttrs.match(/\bname="([^"]+)"/)?.[1] ?? '(unnamed)')
    const classname = decodeXml(tAttrs.match(/\bclassname="([^"]+)"/)?.[1] ?? '')
    const testFile = rel(tAttrs.match(/\bfile="([^"]+)"/)?.[1] ?? '')
    const wallMs = Number(tAttrs.match(/\btime="([^"]+)"/)?.[1] ?? 0) * 1000
    const failure = tBody.match(/<failure\b[^>]*message="([^"]*)"/)?.[1]
      ?? tBody.match(/<failure\b[^>]*>([\s\S]*?)<\/failure>/)?.[1]
    tests.push({
      name: classname ? `${classname} > ${name}` : name,
      file: testFile,
      wallMs,
      pass: !tBody.includes('<failure'),
      failure: failure ? decodeXml(failure).trim() : undefined,
    })
  }
  return { tests, fileWall, suiteTests, suiteFailures }
}

function emptySpawn(): SpawnCounts {
  return { spawn: 0, spawnSync: 0, bootstraps: 0, cli: 0, git: 0, other: 0, argv0: {} }
}

export function mergeTimings(
  sidecar: { elapsedMs?: number; files?: Record<string, SpawnCounts> },
  xml: string,
  meta: { stamp: string; command: string[]; elapsedMs: number; exitCode: number },
): GateTimings {
  const { tests, fileWall, suiteTests, suiteFailures } = parseJunit(xml)
  const spawnFiles = sidecar.files ?? {}
  const names = new Set([...Object.keys(spawnFiles), ...fileWall.keys(), ...tests.map((t) => t.file)])
  const files: FileRow[] = [...names].filter(Boolean).sort().map((file) => {
    const spawn = spawnFiles[file] ?? emptySpawn()
    const fileTests = tests.filter((t) => t.file === file)
    return {
      file,
      wallMs: fileWall.get(file) ?? fileTests.reduce((sum, t) => sum + t.wallMs, 0),
      tests: fileTests.length || suiteTests.get(file) || 0,
      failed: fileTests.length
        ? fileTests.filter((t) => !t.pass).length
        : suiteFailures.get(file) || 0,
      ...spawn,
      argv0: { ...spawn.argv0 },
    }
  })
  return { ...meta, tests, files }
}

export function markdownSummary(data: GateTimings, heading: string): string {
  const totalSpawn = data.files.reduce((s, f) => s + f.spawn + f.spawnSync, 0)
  const totalBoot = data.files.reduce((s, f) => s + f.bootstraps, 0)
  const failed = data.tests.filter((t) => !t.pass)
  const top = [...data.tests].sort((a, b) => b.wallMs - a.wallMs).slice(0, 20)
  const perFile = [...data.files].sort((a, b) => b.wallMs - a.wallMs)
  const lines = [
    `## ${heading}`,
    '',
    `- stamp: \`${data.stamp}\``,
    `- command: \`${data.command.join(' ')}\``,
    `- elapsed: ${(data.elapsedMs / 1000).toFixed(1)} s (exit ${data.exitCode})`,
    `- tests: ${data.tests.length} (${data.tests.filter((t) => t.pass).length} pass, ${failed.length} fail)`,
    `- process calls: ${totalSpawn} (spawn + spawnSync); database bootstraps: ${totalBoot}`,
    '',
    '### Per-file totals',
    '',
    '| file | wall s | tests | fail | spawn | spawnSync | bootstraps | cli | git | other |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...perFile.map((f) =>
      `| ${f.file} | ${(f.wallMs / 1000).toFixed(2)} | ${f.tests} | ${f.failed} | ${f.spawn} | ${f.spawnSync} | ${f.bootstraps} | ${f.cli} | ${f.git} | ${f.other} |`),
    '',
    '### Top 20 tests',
    '',
    '| test | file | wall s |',
    '|---|---|---:|',
    ...top.map((t) => `| ${t.name.replace(/\|/g, '\\|')} | ${t.file} | ${(t.wallMs / 1000).toFixed(3)} |`),
    '',
  ]
  if (failed.length) {
    lines.push('### Failures', '')
    for (const t of failed) {
      lines.push(`- **${t.file}** \`${t.name}\``, '', '```', t.failure ?? '(no failure text)', '```', '')
    }
  }
  return lines.join('\n')
}

const recorder = process.argv[1]?.endsWith('record-gate-timings.ts')
if (recorder) {
  const command = ['bun', 'test', ...testArgs, '--reporter=junit', `--reporter-outfile=${junitPath}`]
  const started = Date.now()
  const child = Bun.spawn(command, {
    cwd: orchRoot,
    env: { ...process.env, ORCH_GATE_TIMINGS: jsonPath },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  const elapsedMs = Date.now() - started
  const sidecarPath = `${jsonPath}.spawn.json`
  let sidecar: { elapsedMs?: number; files?: Record<string, SpawnCounts> } = {}
  try { sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) } catch { /* reporter may have failed */ }
  const xml = readFileSync(junitPath, 'utf8')
  const data = mergeTimings(sidecar, xml, { stamp, command: ['bun', 'test', ...testArgs], elapsedMs, exitCode })
  writeFileSync(jsonPath, JSON.stringify(data, null, 2))
  console.log(`\nwrote ${jsonPath}`)
  console.log(markdownSummary(data, 'CLI leg'))
  process.exit(exitCode)
}
