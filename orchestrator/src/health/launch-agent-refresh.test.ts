import { expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { InstallationIdentity } from '../../../shared/install-root.ts'
import {
  LONG_RUNNING_MAINTENANCE_LABELS,
  MAINTENANCE_SCHEDULE_LABELS,
  scheduleExpectation,
} from '../../../shared/schedule-policy.ts'
import type { InstalledPlistOwner } from '../setup/launchd-owners.ts'
import { requiredMaintenanceLabels } from '../setup/setup-schedule-policy.ts'
import type { LaunchAgentDefinitionObservation } from './launch-agent-doctor.ts'
import { decideLaunchAgentRefresh, refreshLaunchAgents } from './launch-agent-refresh.ts'

const owners: InstalledPlistOwner[] = [
  { label: 'hub-label', command: 'hub/bin/install-launchd.sh' },
  { label: 'com.user.orch-record-sync', command: 'ops/install.sh' },
  { label: 'ops-label', command: 'ops/install.sh' },
]

const compared = (plistMatches: boolean): LaunchAgentDefinitionObservation => ({
  programPath: '/installed/program',
  programExists: true,
  comparison: { kind: 'compared', plistMatches },
})

test('checkout refreshes each drifted owner once in template-owner order', () => {
  const plan = decideLaunchAgentRefresh({
    installationKind: 'checkout',
    machineLevel: 'full',
    owners,
    observations: {
      'hub-label': compared(false),
      'com.user.orch-record-sync': compared(true),
      'ops-label': compared(false),
    },
    requiredMaintenanceLabels: new Set(),
  })
  expect(plan.checkoutCommands).toEqual(['hub/bin/install-launchd.sh', 'ops/install.sh'])
  expect(plan.labels.map(({ label }) => label)).toEqual(['hub-label', 'ops-label'])
})

test('distribution refreshes maintenance drift and leaves checkout-owned drift alone', () => {
  const plan = decideLaunchAgentRefresh({
    installationKind: 'distribution',
    machineLevel: 'full',
    owners,
    observations: {
      'hub-label': compared(true),
      'com.user.orch-record-sync': compared(false),
      'ops-label': compared(false),
    },
    requiredMaintenanceLabels: new Set(),
  })
  expect(plan.applyMaintenance).toBeTrue()
  expect(plan.labels).toEqual([
    {
      label: 'com.user.orch-record-sync',
      command: `${PLATFORM_SLUG} machine setup apply`,
    },
  ])
  expect(plan.notReleaseInstalled).toEqual(['ops-label'])
})

test('record-level distribution refreshes installed drift but does not add missing schedules', () => {
  const plan = decideLaunchAgentRefresh({
    installationKind: 'distribution',
    machineLevel: 'record',
    owners: [
      { label: 'com.user.hub-collect', command: 'hub/bin/install-launchd.sh' },
      { label: 'com.user.orch-record-sync', command: 'ops/install.sh' },
    ],
    observations: { 'com.user.hub-collect': compared(false) },
    requiredMaintenanceLabels: new Set(),
  })
  expect(plan.applyMaintenance).toBeTrue()
  expect(plan.labels).toEqual([
    {
      label: 'com.user.hub-collect',
      command: `${PLATFORM_SLUG} machine setup apply`,
    },
  ])
  expect(plan.notReleaseInstalled).toEqual([])
})

test('distribution installs required maintenance labels with no definition', () => {
  const plan = decideLaunchAgentRefresh({
    installationKind: 'distribution',
    machineLevel: 'full',
    owners,
    observations: { 'hub-label': compared(true), 'ops-label': compared(true) },
    requiredMaintenanceLabels: new Set(['com.user.orch-record-sync']),
  })
  expect(plan.applyMaintenance).toBeTrue()
  expect(plan.labels.map(({ label }) => label)).toEqual(['com.user.orch-record-sync'])
})

test('an unavailable comparison is unverified instead of drifted', () => {
  const plan = decideLaunchAgentRefresh({
    installationKind: 'checkout',
    machineLevel: 'full',
    owners: [owners[0]!],
    observations: {
      'hub-label': {
        programPath: '/installed/program',
        programExists: true,
        comparison: { kind: 'unavailable', detail: 'flyctl is not installed', command: null },
      },
    },
    requiredMaintenanceLabels: new Set(),
  })
  expect(plan.unverified).toEqual([{ label: 'hub-label', detail: 'flyctl is not installed' }])
  expect(plan.labels).toEqual([])
  expect(plan.checkoutCommands).toEqual([])
})

test('matching definitions produce an empty refresh plan', () => {
  const plan = decideLaunchAgentRefresh({
    installationKind: 'checkout',
    machineLevel: 'full',
    owners,
    observations: Object.fromEntries(owners.map(({ label }) => [label, compared(true)])),
    requiredMaintenanceLabels: new Set(),
  })
  expect(plan).toEqual({
    labels: [],
    checkoutCommands: [],
    applyMaintenance: false,
    unverified: [],
    notReleaseInstalled: [],
  })
})

test('checkout refresh installs each drifted command once and logs cleared labels', async () => {
  let observation = 0
  const installs: Array<{ root: string; command: string }> = []
  const lines: string[] = []
  await refreshLaunchAgents(
    'darwin',
    { log: (line) => lines.push(line) },
    {
      identity: { kind: 'checkout', root: '/checkout', version: 'development' },
      readOwners: async () => owners,
      observe: () => {
        observation += 1
        return Object.fromEntries(owners.map(({ label }) => [label, compared(observation > 1)]))
      },
      runCheckoutInstaller: (root, command) => installs.push({ root, command }),
    },
  )
  expect(installs).toEqual([
    { root: '/checkout', command: 'hub/bin/install-launchd.sh' },
    { root: '/checkout', command: 'ops/install.sh' },
  ])
  expect(lines).toEqual(owners.map(({ label }) => `${label} re-rendered`))
})

test('checkout refresh names every remaining label and command remedy', async () => {
  await expect(
    refreshLaunchAgents(
      'darwin',
      { log: () => {} },
      {
        identity: { kind: 'checkout', root: '/checkout', version: 'development' },
        readOwners: async () => owners,
        observe: () => Object.fromEntries(owners.map(({ label }) => [label, compared(false)])),
        runCheckoutInstaller: () => {},
      },
    ),
  ).rejects.toThrow(
    [
      'hub-label definition still drifted; run hub/bin/install-launchd.sh',
      'com.user.orch-record-sync definition still drifted; run ops/install.sh',
      'ops-label definition still drifted; run ops/install.sh',
    ].join('\n'),
  )
})

const distributionIdentity: InstallationIdentity = {
  kind: 'distribution',
  root: '/distribution',
  manifest: {
    name: PLATFORM_NAME,
    version: '1.2.3',
    built: '2026-11-06T12:00:00.000Z',
    commit: 'abc1234',
  },
}

test("distribution refresh and doctor's schedule expectation use one maintenance rule", async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    for (const level of ['record', 'full'] as const) {
      for (const label of MAINTENANCE_SCHEDULE_LABELS) {
        const expected = scheduleExpectation(label, platform, 'distribution', level, []).scheduled
        let applies = 0
        await refreshLaunchAgents(
          platform,
          { log: () => {} },
          {
            identity: distributionIdentity,
            readOwners: async () => [{ label, command: 'ops/install.sh' }],
            observe: () => ({}),
            readScheduleFacts: () => [
              {
                label,
                installed: applies > 0,
                loaded: applies > 0,
                definitionMatches: applies > 0,
              },
            ],
            applyMaintenance: async () => {
              applies += 1
              return [{ label, status: 'applied' }]
            },
            requiredMaintenanceLabels: () =>
              requiredMaintenanceLabels(
                { modelHostAlias: '', recordTunnelApp: '', flyctlOnPath: false },
                level,
              ),
            readMachineLevel: () => level,
            scheduleUserManagerAvailable: () => true,
          },
        )
        expect(applies).toBe(expected ? 1 : 0)
      }
    }
  }
})

test('linux distribution refresh re-applies drifted maintenance and checks re-read facts', async () => {
  let factsRead = 0
  let applies = 0
  await refreshLaunchAgents(
    'linux',
    { log: () => {} },
    {
      identity: distributionIdentity,
      readOwners: async () => [owners[1]!],
      observe: () => {
        throw new Error('linux refresh must not observe launchd definitions')
      },
      readScheduleFacts: () => [
        {
          label: 'com.user.orch-record-sync',
          installed: true,
          loaded: true,
          definitionMatches: ++factsRead > 1,
        },
      ],
      applyMaintenance: async () => {
        applies += 1
        return [{ label: 'com.user.orch-record-sync', status: 'applied' }]
      },
      scheduleUserManagerAvailable: () => true,
    },
  )
  expect(applies).toBe(1)
  expect(factsRead).toBe(2)
})

test('linux distribution refresh logs the login-session remedy without applying when the user manager is unavailable', async () => {
  let applies = 0
  const lines: string[] = []
  await refreshLaunchAgents(
    'linux',
    { log: (line) => lines.push(line) },
    {
      identity: distributionIdentity,
      readOwners: async () => [owners[1]!],
      readScheduleFacts: () => [],
      applyMaintenance: async () => {
        applies += 1
        return []
      },
      requiredMaintenanceLabels: () => ['com.user.orch-record-sync'],
      scheduleUserManagerAvailable: () => false,
    },
  )
  expect(applies).toBe(0)
  expect(lines).toEqual([
    `systemd user manager unavailable in this session; maintenance schedules not installed; run ${PLATFORM_SLUG} machine setup apply from a login session`,
  ])
})

test('linux distribution refresh accepts matching inactive units and logs their status remedies', async () => {
  let factsRead = 0
  const lines: string[] = []
  await refreshLaunchAgents(
    'linux',
    { log: (line) => lines.push(line) },
    {
      identity: distributionIdentity,
      readOwners: async () => [owners[1]!],
      readScheduleFacts: () => [
        {
          label: 'com.user.orch-record-sync',
          installed: true,
          loaded: false,
          definitionMatches: ++factsRead > 1,
        },
      ],
      applyMaintenance: async () => [{ label: 'com.user.orch-record-sync', status: 'applied' }],
      scheduleUserManagerAvailable: () => true,
    },
  )
  expect(lines).toEqual([
    'orch-record-sync.timer installed but not active; run systemctl --user status orch-record-sync.timer',
    'orch-record-sync.path installed but not active; run systemctl --user status orch-record-sync.path',
    'com.user.orch-record-sync re-rendered',
  ])
})

test('linux distribution refresh still rejects a definition mismatch after apply', async () => {
  await expect(
    refreshLaunchAgents(
      'linux',
      { log: () => {} },
      {
        identity: distributionIdentity,
        readOwners: async () => [owners[1]!],
        readScheduleFacts: () => [
          {
            label: 'com.user.orch-record-sync',
            installed: true,
            loaded: true,
            definitionMatches: false,
          },
        ],
        applyMaintenance: async () => [{ label: 'com.user.orch-record-sync', status: 'applied' }],
        scheduleUserManagerAvailable: () => true,
      },
    ),
  ).rejects.toThrow('com.user.orch-record-sync definition still drifted')
})

test('distribution refresh installs a required missing maintenance definition', async () => {
  let applied = false
  let applies = 0
  await refreshLaunchAgents(
    'darwin',
    { log: () => {} },
    {
      identity: distributionIdentity,
      readOwners: async () => [owners[1]!],
      observe: (observedOwners) => {
        expect(observedOwners).toEqual([])
        return {}
      },
      readScheduleFacts: () => [
        {
          label: 'com.user.orch-record-sync',
          installed: applied,
          loaded: applied,
          definitionMatches: applied,
        },
      ],
      runCheckoutInstaller: () => {
        throw new Error('checkout installer must not run')
      },
      applyMaintenance: async () => {
        applies += 1
        applied = true
        return [{ label: 'com.user.orch-record-sync', status: 'applied' }]
      },
      requiredMaintenanceLabels: () => ['com.user.orch-record-sync'],
    },
  )
  expect(applies).toBe(1)
})

test('distribution refresh rejects when a required definition stays missing after apply', async () => {
  let applies = 0
  await expect(
    refreshLaunchAgents(
      'darwin',
      { log: () => {} },
      {
        identity: distributionIdentity,
        readOwners: async () => [owners[1]!],
        observe: (observedOwners) => {
          expect(observedOwners).toEqual([])
          return {}
        },
        readScheduleFacts: () => [
          {
            label: 'com.user.orch-record-sync',
            installed: false,
            loaded: false,
            definitionMatches: false,
          },
        ],
        runCheckoutInstaller: () => {
          throw new Error('checkout installer must not run')
        },
        applyMaintenance: async () => {
          applies += 1
          return [{ label: 'com.user.orch-record-sync', status: 'applied' }]
        },
        requiredMaintenanceLabels: () => ['com.user.orch-record-sync'],
      },
    ),
  ).rejects.toThrow('com.user.orch-record-sync definition still drifted')
  expect(applies).toBe(1)
})

test('distribution refresh verifies maintenance drift with setup facts after apply', async () => {
  let factsRead = 0
  let applies = 0
  const lines: string[] = []
  await refreshLaunchAgents(
    'darwin',
    { log: (line) => lines.push(line) },
    {
      identity: distributionIdentity,
      readOwners: async () => [owners[1]!],
      observe: (observedOwners) => {
        expect(observedOwners).toEqual([])
        return {}
      },
      readScheduleFacts: () => [
        {
          label: 'com.user.orch-record-sync',
          installed: true,
          loaded: true,
          definitionMatches: ++factsRead > 1,
        },
      ],
      applyMaintenance: async () => {
        applies += 1
        return [{ label: 'com.user.orch-record-sync', status: 'applied' }]
      },
    },
  )
  expect(applies).toBe(1)
  expect(factsRead).toBe(2)
  expect(lines).toEqual(['com.user.orch-record-sync re-rendered'])
})

test('distribution refresh logs a skipped maintenance label without reporting drift', async () => {
  const lines: string[] = []
  await refreshLaunchAgents(
    'darwin',
    { log: (line) => lines.push(line) },
    {
      identity: distributionIdentity,
      readOwners: async () => [owners[1]!],
      observe: (observedOwners) => {
        expect(observedOwners).toEqual([])
        return {}
      },
      readScheduleFacts: () => [
        {
          label: 'com.user.orch-record-sync',
          installed: true,
          loaded: true,
          definitionMatches: false,
        },
      ],
      applyMaintenance: async () => [
        {
          label: 'com.user.orch-record-sync',
          status: 'skipped',
          reason: 'disabled by machine policy',
        },
      ],
    },
  )
  expect(lines).toEqual(['com.user.orch-record-sync skipped — disabled by machine policy'])
})

test('darwin refresh restarts declared long-running labels only for a distribution', async () => {
  for (const identity of [
    distributionIdentity,
    { kind: 'checkout', root: '/checkout', version: 'development' } as const,
  ]) {
    const restarted: string[] = []
    await refreshLaunchAgents(
      'darwin',
      { log: () => {} },
      {
        identity,
        readOwners: async () => [],
        observe: () => ({}),
        readScheduleFacts: () => [],
        restartLongRunning: true,
        restartLongRunningMaintenance: () =>
          LONG_RUNNING_MAINTENANCE_LABELS.map((label) => {
            restarted.push(label)
            return { label, status: 'restarted', command: `restart ${label}` }
          }),
      },
    )
    expect(restarted).toEqual(
      identity.kind === 'distribution' ? [...LONG_RUNNING_MAINTENANCE_LABELS] : [],
    )
  }
})

test('darwin distribution refresh skips inactive services and logs unreachable gui remedies', async () => {
  for (const [status, expectedLines] of [
    ['inactive', []],
    [
      'unreachable',
      LONG_RUNNING_MAINTENANCE_LABELS.map(
        (label) =>
          `${label} could not be restarted because the launchd gui domain is unreachable; run launchctl kill SIGTERM gui/501/${label} from a login session`,
      ),
    ],
  ] as const) {
    const lines: string[] = []
    await refreshLaunchAgents(
      'darwin',
      { log: (line) => lines.push(line) },
      {
        identity: distributionIdentity,
        readOwners: async () => [],
        observe: () => ({}),
        readScheduleFacts: () => [],
        restartLongRunning: true,
        restartLongRunningMaintenance: () =>
          LONG_RUNNING_MAINTENANCE_LABELS.map((label) => ({
            label,
            status,
            command: `launchctl kill SIGTERM gui/501/${label}`,
          })),
      },
    )
    expect(lines).toEqual([...expectedLines])
  }
})

test('linux restart-only refresh logs one setup remedy when the user manager is unavailable', async () => {
  const lines: string[] = []
  let restarts = 0
  await refreshLaunchAgents(
    'linux',
    { log: (line) => lines.push(line) },
    {
      identity: distributionIdentity,
      readOwners: async () => [],
      readScheduleFacts: () => [],
      scheduleUserManagerAvailable: () => false,
      restartLongRunning: true,
      restartLongRunningMaintenance: () => {
        restarts += 1
        return []
      },
    },
  )
  expect(restarts).toBe(0)
  expect(lines).toEqual([
    `systemd user manager unavailable in this session; maintenance schedules not refreshed and long-running services not restarted; run ${PLATFORM_SLUG} machine setup apply from a login session`,
  ])
})
