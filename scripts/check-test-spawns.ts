#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const GATE_TIMING_DIR = `${ROOT}/orchestrator/runs/gate-timings`
const SPAWN_LIMIT = 20

type SpawnMeasurement = {
  file: string
  spawn: number
  spawnSync: number
}

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
  return artifact.files.filter((row) => row.file.startsWith('src/') && row.file.endsWith('.test.ts'))
}

const measurements = newestSpawnMeasurements()
if (!measurements) {
  console.log('check-test-spawns: no gate timing artefact; fixed spawn rule not measured')
  process.exit(0)
}
const violations = measurements
  .map((row) => ({ file: row.file, spawns: row.spawn + row.spawnSync }))
  .filter((row) => row.spawns > SPAWN_LIMIT)
for (const row of violations) {
  console.error(`orchestrator/${row.file}: measured ${row.spawns} spawns, fixed limit ${SPAWN_LIMIT}`)
}
if (violations.length) process.exit(1)
console.log(`check-test-spawns: ok (${measurements.length} unit test files, fixed limit ${SPAWN_LIMIT})`)
