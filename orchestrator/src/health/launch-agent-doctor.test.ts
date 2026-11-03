import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideLaunchAgentDoctor, launchAgentDoctorReport } from './launch-agent-doctor.ts'

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
  test('reads and reports no launch-agent facts on Linux', async () => {
    let reads = 0
    expect(
      await launchAgentDoctorReport(
        'linux',
        async () => {
          reads += 1
          return owners
        },
        'checkout',
        'full',
      ),
    ).toEqual({ lines: [], failed: false })
    expect(reads).toBe(0)
  })

  test('reports skips and unloaded findings while omitting loaded agents', () => {
    expect(
      decideLaunchAgentDoctor({
        owners,
        installationKind: 'checkout',
        machineLevel: 'full',
        skipReasons,
        loadObservation: { kind: 'available', loadedLabels: new Set(['com.user.loaded']) },
        lastRuns: {},
      }),
    ).toEqual({
      skipped: [{ label: 'com.user.skipped', reason: 'configuration is absent' }],
      findings: [{ label: 'com.user.unloaded', command: 'ops/install.sh' }],
      informational: [],
      schedules: [],
      launchctlUnavailable: null,
    })
  })

  test('a distribution reports checkout-only installers without a nonexistent remedy', () => {
    expect(
      decideLaunchAgentDoctor({
        owners,
        installationKind: 'distribution',
        machineLevel: 'full',
        skipReasons,
        loadObservation: { kind: 'available', loadedLabels: new Set(['com.user.loaded']) },
        lastRuns: {},
      }),
    ).toEqual({
      skipped: [{ label: 'com.user.skipped', reason: 'configuration is absent' }],
      findings: [],
      informational: [{ label: 'com.user.unloaded', reason: 'not installed by a release install' }],
      schedules: [],
      launchctlUnavailable: null,
    })
  })

  test('an unreadable installation identity reports checkout-only installers as informational', () => {
    expect(
      decideLaunchAgentDoctor({
        owners,
        installationKind: null,
        machineLevel: 'full',
        skipReasons,
        loadObservation: { kind: 'available', loadedLabels: new Set(['com.user.loaded']) },
        lastRuns: {},
      }),
    ).toEqual({
      skipped: [{ label: 'com.user.skipped', reason: 'configuration is absent' }],
      findings: [],
      informational: [{ label: 'com.user.unloaded', reason: 'not installed by a release install' }],
      schedules: [],
      launchctlUnavailable: null,
    })
  })

  test('reports unavailable load checks without treating unloaded agents as findings', () => {
    for (const reason of ['launchctl missing', 'gui domain unreachable'] as const) {
      expect(
        decideLaunchAgentDoctor({
          owners,
          installationKind: 'checkout',
          machineLevel: 'full',
          skipReasons,
          loadObservation: { kind: 'unavailable', reason },
          lastRuns: {},
        }),
      ).toEqual({
        skipped: [{ label: 'com.user.skipped', reason: 'configuration is absent' }],
        findings: [],
        informational: [],
        schedules: [],
        launchctlUnavailable: reason,
      })
    }
  })

  test('worker schedules refuse by install kind while record and skipped schedules inform', () => {
    const scheduleOwners = [
      { label: 'com.user.orch-sweep', command: 'ops/install.sh' },
      { label: 'com.user.orch-record-sync', command: 'ops/install.sh' },
    ]
    for (const [installationKind, remedy] of [
      ['distribution', `${PLATFORM_SLUG} machine setup apply`],
      ['checkout', 'ops/install.sh'],
    ] as const) {
      const decision = decideLaunchAgentDoctor({
        owners: scheduleOwners,
        installationKind,
        machineLevel: 'full',
        skipReasons: {
          'com.user.orch-sweep': null,
          'com.user.orch-record-sync': 'env files are absent',
        },
        loadObservation: { kind: 'available', loadedLabels: new Set() },
        lastRuns: { 'com.user.orch-sweep': '11/3/2026, 9:15:00 AM EST' },
      })
      expect(decision.schedules).toEqual([
        {
          label: 'com.user.orch-sweep',
          loaded: false,
          lastRun: '11/3/2026, 9:15:00 AM EST',
          skipReason: null,
          remedy,
        },
        {
          label: 'com.user.orch-record-sync',
          loaded: false,
          lastRun: 'never',
          skipReason: 'env files are absent',
          remedy: null,
        },
      ])
    }

    const record = decideLaunchAgentDoctor({
      owners: scheduleOwners,
      installationKind: 'distribution',
      machineLevel: 'record',
      skipReasons: {},
      loadObservation: { kind: 'available', loadedLabels: new Set() },
      lastRuns: {},
    })
    expect(record.schedules.every((schedule) => schedule.remedy === null)).toBe(true)
  })
})
