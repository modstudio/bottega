#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { concernStateDirectory } from '../shared/state-directory.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const GATE_TIMING_DIR = join(concernStateDirectory('orchestrator'), 'runs', 'gate-timings')
const SPAWN_LIMIT = 20
const STATIC_TEST_ROOTS = ['.githooks', 'hub', 'scripts', 'shared']

type SpawnMeasurement = {
  file: string
  spawn: number
  spawnSync: number
}

type StaticViolation = { file: string; line: number; reason: string }

function testFilesUnder(path: string): string[] {
  if (!existsSync(path)) return []
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.test\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => `${entry.parentPath}/${entry.name}`)
    .filter((file) => !file.includes('/node_modules/'))
}

function staticViolations(): StaticViolation[] {
  const files = STATIC_TEST_ROOTS.flatMap((path) => testFilesUnder(`${ROOT}/${path}`))
  return files.flatMap((file) => {
    const lines = readFileSync(file, 'utf8').split('\n')
    const mainCheckoutBindings = lines.flatMap((line) => {
      const match = line.match(/\b(?:const|let|var)\s+(\w+)\s*=\s*mainCheckoutOf\s*\(/)
      return match?.[1] ? [match[1]] : []
    })
    return lines.flatMap((line, index) => {
      let reason: string | null = null
      if (/\bBun\.spawnSync\s*\(/.test(line)) reason = 'real Bun.spawnSync call'
      else if (/\bBun\.spawn\s*\(/.test(line)) reason = 'real Bun.spawn call'
      else if (/\bexeca\s*\(/.test(line)) reason = 'real execa call'
      else if (/\b(?:from|require\s*\()\s*['"](?:node:)?child_process['"]/.test(line)) {
        reason = 'child_process import'
      } else if (/\bcopyLiveHub\b/.test(line)) reason = 'live hub store access'
      else if (
        /\b(?:hub|orch)\.db\b/.test(line) &&
        mainCheckoutBindings.some((binding) => line.includes(`join(${binding}`))
      ) {
        reason = 'live store joined from mainCheckoutOf'
      }
      return reason ? [{ file: file.slice(ROOT.length + 1), line: index + 1, reason }] : []
    })
  })
}

const staticFailures = staticViolations()
for (const violation of staticFailures) {
  console.error(`${violation.file}:${violation.line}: ${violation.reason}`)
}
if (staticFailures.length) process.exit(1)

function newestSpawnMeasurements(): SpawnMeasurement[] | null {
  if (!existsSync(GATE_TIMING_DIR)) return null
  const artifacts = readdirSync(GATE_TIMING_DIR)
    .filter((name) => /^\d{4}-.+\.json$/.test(name))
    .map((name) => `${GATE_TIMING_DIR}/${name}`)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (!artifacts.length) return null
  const artifact = JSON.parse(readFileSync(artifacts[0]!, 'utf8')) as {
    files?: SpawnMeasurement[]
  }
  if (!Array.isArray(artifact.files)) {
    throw new Error(`${artifacts[0]}: gate timing artefact has no files table`)
  }
  return artifact.files.filter(
    (row) => row.file.startsWith('src/') && row.file.endsWith('.test.ts'),
  )
}

const measurements = newestSpawnMeasurements()
if (!measurements) {
  console.log(
    'check-test-spawns: static rule ok; no gate timing artefact, fixed spawn rule not measured',
  )
  process.exit(0)
}
const violations = measurements
  .map((row) => ({ file: row.file, spawns: row.spawn + row.spawnSync }))
  .filter((row) => row.spawns > SPAWN_LIMIT)
for (const row of violations) {
  console.error(
    `orchestrator/${row.file}: measured ${row.spawns} spawns, fixed limit ${SPAWN_LIMIT}`,
  )
}
if (violations.length) process.exit(1)
console.log(
  `check-test-spawns: static rule ok; measured ${measurements.length} orchestrator unit test files, fixed limit ${SPAWN_LIMIT}`,
)
