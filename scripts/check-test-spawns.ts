#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const STATE_FILE = `${ROOT}/scripts/quality/test-init-sites.json`
const STATE_LABEL = 'scripts/quality/test-init-sites.json'
const SPAWN_STATE_FILE = `${ROOT}/scripts/quality/test-spawn-ceiling.json`
const SPAWN_STATE_LABEL = 'scripts/quality/test-spawn-ceiling.json'
const GATE_TIMING_DIR = `${ROOT}/orchestrator/runs/gate-timings`

type SpawnMeasurement = {
  file: string
  spawn: number
  spawnSync: number
}

function testFiles(): string[] {
  const files: string[] = []
  const visit = (directory: string, recursive: boolean) => {
    for (const entry of readdirSync(directory)) {
      const absolute = resolve(directory, entry)
      if (statSync(absolute).isDirectory()) {
        if (recursive && !['node_modules', 'dist'].includes(entry)) visit(absolute, true)
      } else if (/\.test\.tsx?$/.test(entry)) {
        files.push(relative(ROOT, absolute))
      }
    }
  }
  visit(resolve(ROOT, 'orchestrator/src'), false)
  visit(resolve(ROOT, 'hub'), true)
  visit(resolve(ROOT, 'shared'), true)
  return files.sort()
}

function initSiteCount(source: string): number {
  const directRanges = [...source.matchAll(/\['git', 'init'[^\]\n]*\]/g)]
    .map((match) => [match.index, match.index + match[0].length] as const)
  const helperSites = [...source.matchAll(/(?:'init', '-b'|\['init')/g)]
    .filter((match) => !directRanges.some(([start, end]) => start <= match.index && match.index < end))
  return directRanges.length + helperSites.length
}

function ordered(state: Record<string, number>) {
  return Object.fromEntries(Object.entries(state).sort(([a], [b]) => a.localeCompare(b)))
}

function newestSpawnMeasurements(): SpawnMeasurement[] | null {
  if (!existsSync(GATE_TIMING_DIR)) return null
  const artifacts = readdirSync(GATE_TIMING_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => `${GATE_TIMING_DIR}/${name}`)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (!artifacts.length) return null
  const artifact = JSON.parse(readFileSync(artifacts[0]!, 'utf8')) as {
    files?: SpawnMeasurement[]
  }
  if (!Array.isArray(artifact.files)) {
    throw new Error(`${artifacts[0]}: gate timing artefact has no files table`)
  }
  return artifact.files.filter((row) => row.file.startsWith('src/') && row.file.endsWith('.test.ts'))
}

/** A run's spawn count moves by a few calls with retries and timing; the band absorbs that, never a new subprocess. */
function spawnBand(ceiling: number): number {
  return Math.max(2, Math.ceil(ceiling * 0.05))
}

function checkSpawnCeilings(): { measured: number; ceilings: number; failed: boolean } {
  const measurements = newestSpawnMeasurements()
  const ceilings = existsSync(SPAWN_STATE_FILE)
    ? JSON.parse(readFileSync(SPAWN_STATE_FILE, 'utf8')) as Record<string, number>
    : {}
  if (!measurements) return { measured: 0, ceilings: Object.keys(ceilings).length, failed: false }
  const next = { ...ceilings }
  const violations: string[] = []
  const tightenings: string[] = []
  for (const row of measurements) {
    const path = `orchestrator/${row.file}`
    const count = row.spawn + row.spawnSync
    const ceiling = ceilings[path]
    if (ceiling === undefined) {
      next[path] = count
      tightenings.push(`${SPAWN_STATE_LABEL}: ${path} recorded initial ceiling ${count}`)
    } else if (count > ceiling + spawnBand(ceiling)) {
      violations.push(`${path}: measured ${count} spawns, committed ceiling ${ceiling}`)
    } else if (count < ceiling - spawnBand(ceiling)) {
      next[path] = count
      tightenings.push(`${SPAWN_STATE_LABEL}: ${path} tightened ${ceiling} -> ${count}`)
    }
  }
  for (const path of Object.keys(ceilings)) {
    if (existsSync(resolve(ROOT, path))) continue
    delete next[path]
    tightenings.push(`${SPAWN_STATE_LABEL}: ${path} tightened ${ceilings[path]} -> removed`)
  }
  if (JSON.stringify(ordered(next)) !== JSON.stringify(ordered(ceilings))) {
    writeFileSync(SPAWN_STATE_FILE, `${JSON.stringify(ordered(next), null, 2)}\n`)
  }
  for (const message of tightenings) console.error(message)
  for (const message of violations) console.error(message)
  if (tightenings.length) console.error(`baseline tightened; commit ${SPAWN_STATE_LABEL} and re-run`)
  return {
    measured: measurements.length,
    ceilings: Object.keys(next).length,
    failed: violations.length > 0 || tightenings.length > 0,
  }
}

const allowed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, number>
const measured = new Map(testFiles().map((path) => [
  path, initSiteCount(readFileSync(resolve(ROOT, path), 'utf8')),
]))
const next = { ...allowed }
const violations: string[] = []
const tightenings: string[] = []

for (const [path, count] of measured) {
  const ceiling = allowed[path] ?? 0
  if (count > ceiling) violations.push(`${path}: ${count} git init sites, permitted ${ceiling}`)
  if (allowed[path] !== undefined && count < ceiling) {
    if (count === 0) delete next[path]
    else next[path] = count
    tightenings.push(`${STATE_LABEL}: ${path} tightened ${ceiling} -> ${count}`)
  }
}
for (const path of Object.keys(allowed)) {
  if (measured.has(path) || existsSync(resolve(ROOT, path))) continue
  delete next[path]
  tightenings.push(`${STATE_LABEL}: ${path} tightened ${allowed[path]} -> removed`)
}

if (JSON.stringify(ordered(next)) !== JSON.stringify(ordered(allowed))) {
  writeFileSync(STATE_FILE, `${JSON.stringify(ordered(next), null, 2)}\n`)
}
for (const message of tightenings) console.error(message)
for (const message of violations) console.error(message)
if (tightenings.length) console.error(`baseline tightened; commit ${STATE_LABEL} and re-run`)
const spawnCheck = checkSpawnCeilings()
if (violations.length || tightenings.length || spawnCheck.failed) process.exit(1)
console.log(`check-test-spawns: ok (${measured.size} unit test files, ${Object.keys(allowed).length} allowed init sites, ${spawnCheck.measured} measured spawn ceilings of ${spawnCheck.ceilings})`)
