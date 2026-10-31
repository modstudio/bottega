import { afterEach, describe, expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../../shared/embedded-assets.ts'
import { acpRuntimeGaps } from '../transport/transport.ts'
import {
  affectedSelectorDoctorFinding,
  canonEvalDoctorDecision,
  doctorAcpStatus,
  workerCheckDoctorFinding,
} from './doctor.ts'

afterEach(() => registerEmbeddedAssets(null))

describe('doctor canon eval presentation', () => {
  test('marks only an established result against the current platform canon as current', () => {
    expect(
      canonEvalDoctorDecision({
        pass: true,
        recordedSha: 'current-sha',
        currentSha: 'current-sha',
        currentCanonError: null,
      }),
    ).toEqual({ result: 'pass (current canon)', unavailableReason: null })
  })

  test('keeps reporting rows and names why the platform canon could not be computed', () => {
    expect(
      canonEvalDoctorDecision({
        pass: true,
        recordedSha: 'recorded-sha',
        currentSha: null,
        currentCanonError: 'project has no canon',
      }),
    ).toEqual({ result: 'pass', unavailableReason: 'project has no canon' })
    expect(
      canonEvalDoctorDecision({
        pass: false,
        recordedSha: 'recorded-sha',
        currentSha: null,
        currentCanonError: 'project has no canon',
      }),
    ).toEqual({ result: 'FAIL', unavailableReason: 'project has no canon' })
  })
})

test('a missing optional ACP runtime is informational', () => {
  expect(doctorAcpStatus('codex-acp is not installed')).toBe(
    'informational — codex-acp is not installed',
  )
  expect(doctorAcpStatus(null)).toBe('ready')
})

test('a compiled install reports missing codex-acp as informational', () => {
  registerEmbeddedAssets({
    assets: {},
    files: {},
    manifest: {
      name: PLATFORM_NAME,
      version: '1.2.3',
      built: '2026-10-05T00:00:00.000Z',
      commit: 'abcdef1234567890',
    },
  })
  const gap = acpRuntimeGaps({
    env: {},
    which: () => null,
    sdkResolve: () => '/fake/sdk',
    ajvResolve: () => '/fake/ajv',
  })
  expect(gap).toContain('codex-acp executable is not installed')
  expect(doctorAcpStatus(gap)).toStartWith('informational — ')
})

describe('project worker check diagnosis', () => {
  test('reports a differing registered command with the exact repair', () => {
    expect(
      workerCheckDoctorFinding({
        project: 'fixture',
        workerCheck: 'bun run old-worker-check',
        scripts: { 'check:worker': 'bun scripts/check.ts --worker' },
      }),
    ).toBe(
      `fixture: registered workerCheck "bun run old-worker-check" differs from package script "bun run check:worker"; set it with: ${PLATFORM_SLUG} project set fixture --settings '{"workerCheck":"bun run check:worker"}'`,
    )
  })

  test('reports nothing for the matching command or a project without the script', () => {
    expect(
      workerCheckDoctorFinding({
        project: 'fixture',
        workerCheck: 'bun run check:worker',
        scripts: { 'check:worker': 'bun scripts/check.ts --worker' },
      }),
    ).toBeNull()
    expect(
      workerCheckDoctorFinding({
        project: 'fixture',
        workerCheck: 'bun run old-worker-check',
        scripts: { check: 'bun scripts/check.ts' },
      }),
    ).toBeNull()
  })
})

describe('project affected-test selector diagnosis', () => {
  test('reports nothing without the package script marker', () => {
    expect(
      affectedSelectorDoctorFinding({
        project: 'fixture',
        focusedTests: undefined,
        scripts: { test: 'bun test' },
      }),
    ).toBeNull()
  })

  test('reports an unset selector with the exact repair', () => {
    expect(
      affectedSelectorDoctorFinding({
        project: 'fixture',
        focusedTests: { command: 'bun', args: ['test'] },
        scripts: { 'test:affected': 'scripts/affected-tests.ts' },
      }),
    ).toBe(
      `fixture: registered focusedTests.affected (unset) differs from package script "bun run test:affected"; set it with: ${PLATFORM_SLUG} project set fixture --settings '{"focusedTests":{"affected":{"command":"bun","args":["run","test:affected"]}}}'`,
    )
  })

  test('reports a different registered selector', () => {
    expect(
      affectedSelectorDoctorFinding({
        project: 'fixture',
        focusedTests: {
          command: 'bun',
          args: ['test'],
          affected: { command: 'scripts/old-affected-tests.ts', args: [] },
        },
        scripts: { 'test:affected': 'scripts/affected-tests.ts' },
      }),
    ).toContain(
      'registered focusedTests.affected {"command":"scripts/old-affected-tests.ts","args":[]}',
    )
  })

  test('reports nothing for the canonical selector', () => {
    expect(
      affectedSelectorDoctorFinding({
        project: 'fixture',
        focusedTests: {
          command: 'bun',
          args: ['test'],
          affected: { command: 'bun', args: ['run', 'test:affected'] },
        },
        scripts: { 'test:affected': 'scripts/affected-tests.ts' },
      }),
    ).toBeNull()
  })
})
