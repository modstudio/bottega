import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { classifySandboxLaunchFailure, renderSandboxReadinessRefusal } from './sandbox-runtime.ts'

const linuxSrtFailure = { platform: 'linux', sandboxKind: 'srt', turnFailed: true } as const

test('classifies Linux srt namespace and dependency failures as readiness refusals', () => {
  for (const failure of [
    { stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted', launchError: '' },
    { stderr: 'bwrap: setting up uid map: Permission denied', launchError: '' },
    { stderr: '', launchError: 'Sandbox dependencies not available: socat not installed' },
    { stderr: '', launchError: 'bubblewrap (bwrap) not installed' },
  ]) {
    expect(classifySandboxLaunchFailure({ ...linuxSrtFailure, ...failure })).toMatchObject({
      kind: 'sandbox-readiness',
    })
  }
})

test('renders unavailable and freshly available readiness rulings without inventing a remedy', () => {
  const failure = {
    kind: 'sandbox-readiness',
    signature: 'RTM_NEWADDR',
    evidence: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
  } as const
  const runtime = {
    available: false,
    location: '/runtime',
    missingSystemDependencies: [],
    condition: 'namespaces are blocked',
    remedy: '',
    fixes: ['install the profile', 'reload AppArmor'],
    sandboxProbeUnavailableReason: null,
  }
  expect(renderSandboxReadinessRefusal(failure, runtime, 'bwrap failed', 'doctor')).toBe(
    'sandbox runtime readiness failed; namespaces are blocked; install the profile; reload AppArmor\noriginal error: bwrap failed',
  )
  expect(
    renderSandboxReadinessRefusal(
      failure,
      { ...runtime, available: true, fixes: [] },
      'ignored',
      `${PLATFORM_SLUG} machine doctor`,
    ),
  ).toBe(
    `sandbox runtime readiness failed: RTM_NEWADDR; run ${PLATFORM_SLUG} machine doctor on this machine`,
  )
  expect(renderSandboxReadinessRefusal(failure, runtime, '', 'doctor')).toContain(
    'original error: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
  )
})

test('does not reclassify ordinary command failures or non-srt sandboxes', () => {
  expect(
    classifySandboxLaunchFailure({
      ...linuxSrtFailure,
      stderr: 'fatal: not a git repository',
      launchError: '',
    }),
  ).toBeNull()
  expect(
    classifySandboxLaunchFailure({
      platform: 'darwin',
      sandboxKind: 'srt',
      turnFailed: true,
      stderr: 'RTM_NEWADDR',
      launchError: '',
    }),
  ).toBeNull()
})

test('does not reclassify readiness text from a successful turn', () => {
  expect(
    classifySandboxLaunchFailure({
      platform: 'linux',
      sandboxKind: 'srt',
      turnFailed: false,
      stderr: 'worker test fixture: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
      launchError: '',
    }),
  ).toBeNull()
})
