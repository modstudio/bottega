import { describe, expect, test } from 'bun:test'
import { decideLaunchAgentDoctor } from './launch-agent-doctor.ts'

const owners = [
  { label: 'com.user.skipped', command: 'ops/install.sh' },
  { label: 'com.user.loaded', command: 'hub/bin/install-launchd.sh' },
  { label: 'com.user.unloaded', command: 'ops/install.sh' },
]
const skipReasons = {
  'com.user.skipped': 'configuration is absent',
  'com.user.loaded': null,
  'com.user.unloaded': null,
}

describe('launch agent doctor decision', () => {
  test('reports skips and unloaded findings while omitting loaded agents', () => {
    expect(
      decideLaunchAgentDoctor({
        owners,
        skipReasons,
        loadedLabels: new Set(['com.user.loaded']),
      }),
    ).toEqual({
      skipped: [{ label: 'com.user.skipped', reason: 'configuration is absent' }],
      findings: [{ label: 'com.user.unloaded', command: 'ops/install.sh' }],
      launchctlUnavailable: false,
    })
  })

  test('reports the check unavailable without treating unloaded agents as findings', () => {
    expect(decideLaunchAgentDoctor({ owners, skipReasons, loadedLabels: null })).toEqual({
      skipped: [{ label: 'com.user.skipped', reason: 'configuration is absent' }],
      findings: [],
      launchctlUnavailable: true,
    })
  })
})
