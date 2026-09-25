import { describe, expect, test } from 'bun:test'
import {
  boundedGateOutputTail,
  decideGateCancellation,
  decideGateConcurrency,
  decideGateEligibility,
  GATE_CLOSE_REASON,
  GATE_OUTPUT_TAIL_BYTES,
  isGateToolingPath,
  resolveGateCommand,
  shapeGateResult,
} from './gate-decision.ts'

test('relative gate scripts resolve from main while PATH programs stay registered', () => {
  expect(resolveGateCommand('scripts/gate --plain', '/projects/app')).toBe(
    "'/projects/app/scripts/gate' --plain",
  )
  expect(resolveGateCommand('./scripts/gate', '/projects/app')).toBe("'/projects/app/scripts/gate'")
  expect(resolveGateCommand('bun run check', '/projects/app')).toBe('bun run check')
})

describe('worker gate eligibility', () => {
  test('requires an authenticated writer with a registered gate', () => {
    expect(
      decideGateEligibility({ authenticated: true, writer: true, gate: ' scripts/gate ' }),
    ).toEqual({ eligible: true, gate: 'scripts/gate' })
    expect(
      decideGateEligibility({ authenticated: true, writer: false, gate: 'scripts/gate' }),
    ).toEqual({ eligible: false, message: 'run_gate is available only to a writing worker run.' })
    expect(decideGateEligibility({ authenticated: true, writer: true, gate: null })).toEqual({
      eligible: false,
      message: "This run's project has no registered gate, so nothing was run.",
    })
  })
})

test('an active execution refuses a concurrent gate', () => {
  expect(decideGateConcurrency(true)).toEqual({
    allowed: false,
    message: 'A gate run is already in progress.',
  })
  expect(decideGateConcurrency(false)).toEqual({ allowed: true })
})

test('broker close cancels requests before a run ceases to be live', () => {
  expect(decideGateCancellation({ requestsClosed: true, runLive: true })).toBe(GATE_CLOSE_REASON)
  expect(decideGateCancellation({ requestsClosed: false, runLive: false })).toContain(
    'no longer live',
  )
  expect(decideGateCancellation({ requestsClosed: false, runLive: true })).toBeNull()
})

test('gate tooling paths include execution inputs and exclude ordinary source', () => {
  const matches = [
    'package.json',
    'apps/web/package-lock.json',
    'scripts/gate',
    'nested/scripts/release.ts',
    '.githooks/pre-commit',
    'Makefile',
    'ops/docker-compose.dev.yml',
    'compose.test.yaml',
    'eslint.config.ts',
    'biome.jsonc',
    'pyproject.toml',
    '.env.test',
    'tools/custom-gate',
  ]
  for (const path of matches)
    expect(isGateToolingPath(path, 'tools/custom-gate --plain')).toBe(true)
  for (const path of ['src/app.ts', 'nested/eslint.config.ts', 'README.md', 'package.ts']) {
    expect(isGateToolingPath(path, 'tools/custom-gate --plain')).toBe(false)
  }
})

test('gate result bounds the combined output tail and preserves timeout evidence', () => {
  const output = `discarded-${'x'.repeat(GATE_OUTPUT_TAIL_BYTES)}tail`
  const result = shapeGateResult({
    exitCode: -1,
    timedOut: true,
    elapsedMs: 1_200_000,
    output,
    outputPath: '/runs/42/scratch/gate-7.log',
    artifactPath: '/runs/42/artifacts/gate-7.log',
  })
  expect(Buffer.byteLength(result.outputTail)).toBeLessThanOrEqual(GATE_OUTPUT_TAIL_BYTES)
  expect(result.outputTail).toBe(boundedGateOutputTail(output))
  expect(result.outputTail.endsWith('tail')).toBe(true)
  expect(result.timedOut).toBe(true)
})
