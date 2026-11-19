import { expect, test } from 'bun:test'
import { classifySandboxLaunchFailure } from './sandbox-launch-failure.ts'

const linuxSrt = { platform: 'linux', sandboxKind: 'srt' } as const

test('classifies Linux srt namespace and dependency failures as readiness refusals', () => {
  for (const failure of [
    { stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted', launchError: '' },
    { stderr: 'bwrap: setting up uid map: Permission denied', launchError: '' },
    { stderr: '', launchError: 'Sandbox dependencies not available: socat not installed' },
    { stderr: '', launchError: 'bubblewrap (bwrap) not installed' },
  ]) {
    expect(classifySandboxLaunchFailure({ ...linuxSrt, ...failure })).toEqual({
      kind: 'sandbox-readiness',
    })
  }
})

test('does not reclassify ordinary command failures or non-srt sandboxes', () => {
  expect(
    classifySandboxLaunchFailure({
      ...linuxSrt,
      stderr: 'fatal: not a git repository',
      launchError: '',
    }),
  ).toBeNull()
  expect(
    classifySandboxLaunchFailure({
      platform: 'darwin',
      sandboxKind: 'srt',
      stderr: 'RTM_NEWADDR',
      launchError: '',
    }),
  ).toBeNull()
})
