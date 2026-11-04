import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideLaunchAgentDoctor,
  launchAgentComparisonAvailability,
  launchAgentDefinitionSource,
  launchAgentDoctorReport,
  launchAgentOwningRoot,
  scheduleLine,
  schedulesFailed,
} from './launch-agent-doctor.ts'

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
  test('a checkout linked worktree renders definitions for its owning main checkout', () => {
    expect(
      launchAgentOwningRoot({
        installationKind: 'checkout',
        runningRoot: '/projects/platform/.claude/worktrees/DEV-2103',
        discoveredMainCheckout: '/projects/platform',
      }),
    ).toBe('/projects/platform')
    expect(
      launchAgentDefinitionSource({
        installationKind: 'checkout',
        runningRoot: '/projects/platform/.claude/worktrees/DEV-2103',
        discoveredMainCheckout: '/projects/platform',
        templatePath: 'ops/launchd/com.user.example.plist.template',
      }),
    ).toEqual({
      root: '/projects/platform',
      templatePath: '/projects/platform/ops/launchd/com.user.example.plist.template',
    })
  })

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
      definitionFindings: [],
      definitionUnverified: [],
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
      definitionFindings: [],
      definitionUnverified: [],
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
      definitionFindings: [],
      definitionUnverified: [],
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
        definitionFindings: [],
        definitionUnverified: [],
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
      expect(schedulesFailed(decision)).toBe(true)
      expect(decision.schedules.map(scheduleLine)).toEqual([
        `  com.user.orch-sweep NOT LOADED — last run 11/3/2026, 9:15:00 AM EST; run ${remedy}`,
        '  com.user.orch-record-sync NOT LOADED — last run never; skipped — env files are absent',
      ])
    }

    const unavailable = decideLaunchAgentDoctor({
      owners: scheduleOwners,
      installationKind: 'distribution',
      machineLevel: 'full',
      skipReasons: {},
      loadObservation: { kind: 'unavailable', reason: 'launchctl missing' },
      lastRuns: {},
    })
    expect(schedulesFailed(unavailable)).toBe(false)
    expect(scheduleLine(unavailable.schedules[0]!)).toBe(
      '  com.user.orch-sweep LOAD UNAVAILABLE — last run never',
    )

    const record = decideLaunchAgentDoctor({
      owners: scheduleOwners,
      installationKind: 'distribution',
      machineLevel: 'record',
      skipReasons: {},
      loadObservation: { kind: 'available', loadedLabels: new Set() },
      lastRuns: {},
    })
    expect(record.schedules.every((schedule) => schedule.remedy === null)).toBe(true)
    expect(schedulesFailed(record)).toBe(false)
  })

  test('flags a missing program and a drifted installed definition with owning remedies', () => {
    const definitionOwners = [
      { label: 'com.user.ops', command: 'ops/install.sh' },
      { label: 'com.user.hub', command: 'hub/bin/install-launchd.sh' },
    ]
    const decision = decideLaunchAgentDoctor({
      owners: definitionOwners,
      installationKind: 'checkout',
      machineLevel: 'full',
      skipReasons: {},
      loadObservation: {
        kind: 'available',
        loadedLabels: new Set(definitionOwners.map(({ label }) => label)),
      },
      lastRuns: {},
      definitions: {
        'com.user.ops': {
          programPath: '/missing/program',
          programExists: false,
          comparison: { kind: 'compared', plistMatches: true },
        },
        'com.user.hub': {
          programPath: '/usr/bin/true',
          programExists: true,
          comparison: { kind: 'compared', plistMatches: false },
        },
      },
    })

    expect(decision.definitionFindings).toEqual([
      {
        label: 'com.user.ops',
        reason: 'program missing',
        detail: '/missing/program',
        command: 'ops/install.sh',
      },
      {
        label: 'com.user.hub',
        reason: 'definition drifted',
        detail: 'installed plist differs from the current template',
        command: 'hub/bin/install-launchd.sh',
      },
    ])
  })

  test('missing installer inputs and malformed spare time make only affected definitions unverified', () => {
    expect(
      launchAgentComparisonAvailability({
        template: '__FLYCTL__ __HUB_HOSTED_URL__',
        flyctl: null,
        hostedUrl: undefined,
        spareStartTime: '22:00',
      }),
    ).toEqual({
      kind: 'unavailable',
      detail: 'flyctl is not installed; BOTTEGA_HOSTED_URL does not resolve',
      command: null,
    })
    expect(
      launchAgentComparisonAvailability({
        template: '__SPARE_START_HOUR__:__SPARE_START_MINUTE__',
        flyctl: '/usr/local/bin/flyctl',
        hostedUrl: 'https://hub.example.test',
        spareStartTime: '5pm',
      }),
    ).toEqual({
      kind: 'unavailable',
      detail: "spare.start_time is not HH:MM (got '5pm')",
      command: `${PLATFORM_SLUG} machine config set spare.start_time HH:MM`,
    })
    expect(
      launchAgentComparisonAvailability({
        template: '<plist/>',
        flyctl: null,
        hostedUrl: undefined,
        spareStartTime: '5pm',
      }),
    ).toEqual({ kind: 'available', spareStartMinutes: 0 })
  })

  test('an unavailable definition comparison is informational and does not become drift', () => {
    const decision = decideLaunchAgentDoctor({
      owners: [{ label: 'com.user.spare', command: 'ops/install.sh' }],
      installationKind: 'checkout',
      machineLevel: 'full',
      skipReasons: {},
      loadObservation: { kind: 'available', loadedLabels: new Set(['com.user.spare']) },
      lastRuns: {},
      definitions: {
        'com.user.spare': {
          programPath: '/usr/bin/true',
          programExists: true,
          comparison: {
            kind: 'unavailable',
            detail: "spare.start_time is not HH:MM (got '5pm')",
            command: `${PLATFORM_SLUG} machine config set spare.start_time HH:MM`,
          },
        },
      },
    })
    expect(decision.definitionFindings).toEqual([])
    expect(decision.definitionUnverified).toEqual([
      {
        label: 'com.user.spare',
        detail: "spare.start_time is not HH:MM (got '5pm')",
        command: `${PLATFORM_SLUG} machine config set spare.start_time HH:MM`,
      },
    ])
  })
})
