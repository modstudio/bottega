import { afterEach, describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../../shared/embedded-assets.ts'
import { acpRuntimeGaps } from '../transport/transport.ts'
import { canonEvalDoctorDecision, doctorAcpStatus } from './doctor.ts'

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
