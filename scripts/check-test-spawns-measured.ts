#!/usr/bin/env bun
/**
 * The measured half of the test-spawn rule. The static half stays in
 * scripts/check-test-spawns.ts and runs with `bun run check`; this half runs
 * against one gate run's own timing artifact, named explicitly, right after
 * the gate that wrote it (orchestrator/test/run-gate.ts). It never reads the
 * newest file in the timing directory, and a run that produced no artifact is
 * a missing measurement rather than a pass. CI reports; local and worker gates
 * block.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decideSpawnRule,
  describeSpawnViolation,
  loweredSpawnBaseline,
  parseSpawnBaseline,
  SPAWN_LIMIT,
  type SpawnBaseline,
  type SpawnMeasurement,
} from './quality/test-spawns-decision.ts'
import { baselineDisposition } from './quality/test-timing-decision.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const BASELINE = 'scripts/quality/test-spawns-baseline.json'
const BASELINE_PATH = join(ROOT, BASELINE)
const REPORT_ONLY_MESSAGE = 'test spawn ceiling is report-only in CI and blocks locally'

/** Orchestrator unit test rows from one gate timing artifact, repo-relative. */
function artifactSpawnMeasurements(artifact: unknown): SpawnMeasurement[] {
  const files = (artifact as { files?: unknown } | null)?.files
  if (!Array.isArray(files)) throw new Error('gate timing artifact has no files table')
  return files.flatMap((row) => {
    const file = (row as { file?: unknown }).file
    if (typeof file !== 'string' || !file.startsWith('src/') || !file.endsWith('.test.ts')) {
      return []
    }
    const spawn = Number((row as { spawn?: unknown }).spawn ?? 0)
    const spawnSync = Number((row as { spawnSync?: unknown }).spawnSync ?? 0)
    return [{ file: `orchestrator/${file}`, spawns: spawn + spawnSync }]
  })
}

function measurementsFromArtifact(artifactPath: string): SpawnMeasurement[] | null {
  if (!existsSync(artifactPath)) return null
  return artifactSpawnMeasurements(JSON.parse(readFileSync(artifactPath, 'utf8')))
}

function reportMissingMeasurement(artifactPath: string, ci: boolean): number {
  console.error(
    `check-test-spawns: the measurement is missing; no gate timing artifact at ${artifactPath}`,
  )
  if (!ci) return 1
  console.error(REPORT_ONLY_MESSAGE)
  return 0
}

function run(): number {
  const args = Bun.argv.slice(2)
  const update = args.includes('--update')
  const artifactArgument = args.find((argument) => argument.startsWith('--artifact='))
  const unexpected = args.filter(
    (argument) => argument !== '--update' && !argument.startsWith('--artifact='),
  )
  if (unexpected.length > 0) {
    console.error(`unrecognized arguments: ${unexpected.join(' ')}`)
    return 1
  }
  if (artifactArgument === undefined || artifactArgument === '--artifact=') {
    console.error(
      'usage: bun scripts/check-test-spawns-measured.ts --artifact=<gate timing artifact> [--update]',
    )
    return 1
  }
  const artifactPath = artifactArgument.slice('--artifact='.length)
  const ci = Boolean(process.env.CI)
  const measurements = measurementsFromArtifact(artifactPath)
  if (measurements === null) {
    if (update) {
      console.error(`check-test-spawns: cannot regenerate ${BASELINE} without a measurement`)
      return 1
    }
    return reportMissingMeasurement(artifactPath, ci)
  }
  let baseline: SpawnBaseline
  try {
    baseline = parseSpawnBaseline(readFileSync(BASELINE_PATH, 'utf8'))
  } catch (error) {
    console.error(
      `check-test-spawns: ${BASELINE} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }
  if (update) {
    const lowered = loweredSpawnBaseline({ measurements, baseline })
    writeFileSync(BASELINE_PATH, `${JSON.stringify(lowered, null, 2)}\n`)
    console.log(
      `check-test-spawns: wrote ${BASELINE} (${Object.keys(lowered.files).length} files above the fixed limit ${SPAWN_LIMIT})`,
    )
    return 0
  }
  const result = decideSpawnRule({ measurements, baseline })
  if (result.status === 'pass') {
    console.log(
      `check-test-spawns: measured ${result.measuredFiles} orchestrator unit test files, fixed limit ${SPAWN_LIMIT}`,
    )
    return 0
  }
  for (const violation of result.violations) {
    console.error(`check-test-spawns: ${describeSpawnViolation(violation)}`)
  }
  // A local run blocks and asks for a fix; only a fresh measurement lowers the
  // baseline, through --update, and only where it shrank.
  const disposition = baselineDisposition({ changed: true, ci })
  if (disposition === 'report') {
    console.error(REPORT_ONLY_MESSAGE)
    return 0
  }
  console.error(
    `check-test-spawns: remedy: remove the spawns, or lower ${BASELINE} with --update from a fresh artifact, which only accepts counts that shrink.`,
  )
  return 1
}

if (import.meta.main) process.exit(run())
