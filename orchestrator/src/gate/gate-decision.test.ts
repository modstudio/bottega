import { describe, expect, test } from 'bun:test'
import type { SandboxRuntimeConfig } from '../sandbox/sandbox.ts'
import {
  boundedGateOutputTail,
  brokerGateEnvironment,
  changedGateToolingPaths,
  decideBrokerLaunch,
  decideGateCancellation,
  decideGateEligibility,
  decideGateExecutionFinalization,
  decideGateHeadCommit,
  decideGateRequest,
  decideGateToolingDiffBase,
  decideGateWait,
  formatGateRequestDecision,
  GATE_CLOSE_REASON,
  GATE_COMMAND_TIMEOUT_MS,
  GATE_OUTPUT_TAIL_BYTES,
  isGateToolingPath,
  RUN_GATE_WAIT_MS,
  resolveGateCommand,
  shapeGateResult,
  withholdSecretShapedGateLines,
} from './gate-decision.ts'

test('both writing ACP broker command shapes retain the real writer profile', () => {
  const writer: SandboxRuntimeConfig = {
    network: {
      allowedDomains: ['127.0.0.1:43127'],
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [],
      allowWithinDeny: [],
      allowWrite: ['/tree', '/scratch'],
      denyWrite: ['/tree/.git'],
    },
  }
  expect(
    decideBrokerLaunch({ kind: 'srt', profile: writer }, 'sh', ['-c', 'bun run check']),
  ).toEqual({
    kind: 'srt',
    profile: writer,
    bin: 'sh',
    argv: ['-c', 'bun run check'],
  })
  expect(
    decideBrokerLaunch({ kind: 'srt', profile: writer }, 'bun', ['test', 'one.test.ts']),
  ).toEqual({
    kind: 'srt',
    profile: writer,
    bin: 'bun',
    argv: ['test', 'one.test.ts'],
  })
})

test('broker gate environment adds host paths without exposing secrets and applies overlay last', () => {
  expect(
    brokerGateEnvironment(
      { PATH: '/bin' },
      {
        HOME: '/Users/operator',
        TMPDIR: '/tmp/operator',
        ANTHROPIC_API_KEY: 'secret',
      },
      { HOME: '/sandbox/home', ORCH_RUN_ID: '41', ORCH_GATE_PIDS: '/worker/controlled' },
    ),
  ).toEqual({
    PATH: '/bin',
    HOME: '/sandbox/home',
    TMPDIR: '/tmp/operator',
    ORCH_RUN_ID: '41',
  })
})

test('relative gate scripts resolve from the run tree while PATH programs stay registered', () => {
  expect(resolveGateCommand('scripts/gate --plain', '/runs/41/tree')).toBe(
    "'/runs/41/tree/scripts/gate' --plain",
  )
  expect(resolveGateCommand('./scripts/gate', '/runs/41/tree')).toBe("'/runs/41/tree/scripts/gate'")
  expect(resolveGateCommand('bun run check', '/runs/41/tree')).toBe('bun run check')
})

test('broker gate records HEAD only for a clean tree', () => {
  const headCommit = 'a'.repeat(40)
  expect(decideGateHeadCommit({ headCommit, porcelainPaths: [] })).toBe(headCommit)
  expect(decideGateHeadCommit({ headCommit, porcelainPaths: [' M src/app.ts'] })).toBeNull()
  expect(decideGateHeadCommit({ headCommit: '', porcelainPaths: [] })).toBeNull()
})

test('broker tooling compares a rebased worker to the live merge-base, not its recorded base', () => {
  const base = decideGateToolingDiffBase({ recordedBase: 'recorded-base', mergeBase: 'merge-base' })
  expect(base).toBe('merge-base')
  const pathsByBase: Record<string, string[]> = {
    'recorded-base': ['scripts/trunk.ts', 'scripts/worker.ts'],
    'merge-base': ['scripts/worker.ts'],
  }
  expect(
    changedGateToolingPaths({
      diffPaths: pathsByBase[base]!,
      untrackedPaths: [],
      gateCommand: 'scripts/gate',
    }),
  ).toEqual(['scripts/worker.ts'])
  expect(decideGateToolingDiffBase({ recordedBase: 'recorded-base', mergeBase: null })).toBe(
    'recorded-base',
  )
})

test('broker execution finalizes normal and cancelled runs without losing lifecycle evidence', () => {
  expect(
    decideGateExecutionFinalization({
      exitCode: 0,
      timedOut: false,
      cancelledReason: null,
      logCreated: true,
      artifactPath: '/artifacts/gate-7.log',
    }),
  ).toEqual({
    exitCode: 0,
    timedOut: false,
    cancelledReason: null,
    artifactPath: '/artifacts/gate-7.log',
  })
  expect(
    decideGateExecutionFinalization({
      exitCode: -1,
      timedOut: false,
      cancelledReason: GATE_CLOSE_REASON,
      logCreated: false,
      artifactPath: '/artifacts/gate-8.log',
    }),
  ).toEqual({
    exitCode: -1,
    timedOut: false,
    cancelledReason: GATE_CLOSE_REASON,
    artifactPath: null,
  })
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

test('worker gate requests join, return an undelivered result, or start', () => {
  const join = decideGateRequest({
    execution: { id: 7, finished: false },
    resultPending: false,
  })
  expect(join).toEqual({ action: 'join', executionId: 7 })
  expect(formatGateRequestDecision(join)).toBe(
    'Gate execution 7 was already running; this call waited for the same execution.',
  )
  const late = decideGateRequest({
    execution: { id: 8, finished: true },
    resultPending: true,
  })
  expect(late).toEqual({ action: 'return', executionId: 8 })
  expect(formatGateRequestDecision(late)).toBe(
    'Gate execution 8 finished after an earlier run_gate call stopped waiting; returning that result.',
  )
  expect(decideGateRequest({ execution: { id: 8, finished: true }, resultPending: false })).toEqual(
    { action: 'start' },
  )
  expect(decideGateRequest({ execution: null, resultPending: false })).toEqual({ action: 'start' })
})

test('worker gate wait is bounded below the harness and gate command ceilings', () => {
  expect(RUN_GATE_WAIT_MS).toBeLessThan(5 * 60_000)
  expect(RUN_GATE_WAIT_MS).toBeLessThan(GATE_COMMAND_TIMEOUT_MS)
  expect(
    decideGateWait({
      finished: false,
      waitElapsedMs: RUN_GATE_WAIT_MS,
      executionElapsedMs: RUN_GATE_WAIT_MS,
    }),
  ).toEqual({
    wait: false,
    message:
      `The gate is still running after ${RUN_GATE_WAIT_MS}ms. ` +
      'Call run_gate again to wait for this same execution. ' +
      'Do not report done before you have its result.',
  })
  expect(
    decideGateWait({
      finished: false,
      waitElapsedMs: RUN_GATE_WAIT_MS - 1,
      executionElapsedMs: RUN_GATE_WAIT_MS,
    }),
  ).toEqual({ wait: true })
  expect(
    decideGateWait({
      finished: true,
      waitElapsedMs: RUN_GATE_WAIT_MS,
      executionElapsedMs: RUN_GATE_WAIT_MS,
    }),
  ).toEqual({ wait: false })
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

test('broker tooling evidence combines, deduplicates, filters, and sorts repository observations', () => {
  expect(
    changedGateToolingPaths({
      diffPaths: ['src/app.ts', 'scripts/gate', 'package.json'],
      untrackedPaths: ['scripts/gate', '.githooks/pre-commit'],
      gateCommand: 'scripts/gate',
    }),
  ).toEqual(['.githooks/pre-commit', 'package.json', 'scripts/gate'])
})

test('gate output with a 40-hex base and a failure list is kept verbatim', () => {
  const output = `--base=${'a'.repeat(40)}\ngate failures: scripts/check-architecture.ts`
  expect(withholdSecretShapedGateLines(output)).toBe(output)
})

test('gate output withholds only the secret-shaped line and names the rule', () => {
  expect(
    withholdSecretShapedGateLines(
      [
        'gate failures: scripts/check-architecture.ts',
        'ghp_123456789012345678901234567890123456',
        'ok',
      ].join('\n'),
    ),
  ).toBe(
    ['gate failures: scripts/check-architecture.ts', '[withheld line: provider-prefix]', 'ok'].join(
      '\n',
    ),
  )
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
