import { expect, test } from 'bun:test'
import { classifySandboxLaunchFailure } from './sandbox-runtime.ts'

const linuxSrtFailure = { platform: 'linux', sandboxKind: 'srt', turnFailed: true } as const

test('classifies Linux srt namespace and dependency failures as readiness refusals', () => {
  for (const failure of [
    { stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted', launchError: '' },
    { stderr: 'bwrap: setting up uid map: Permission denied', launchError: '' },
    { stderr: '', launchError: 'Sandbox dependencies not available: socat not installed' },
    { stderr: '', launchError: 'bubblewrap (bwrap) not installed' },
  ]) {
    expect(classifySandboxLaunchFailure({ ...linuxSrtFailure, ...failure })).toEqual({
      kind: 'sandbox-readiness',
    })
  }
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
