import { expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { InstallationIdentity } from '../../../shared/install-root.ts'
import type { InstalledPlistOwner } from '../setup/launchd-owners.ts'
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
    owners,
    observations: {
      'hub-label': compared(false),
      'com.user.orch-record-sync': compared(true),
      'ops-label': compared(false),
    },
  })
  expect(plan.checkoutCommands).toEqual(['hub/bin/install-launchd.sh', 'ops/install.sh'])
  expect(plan.labels.map(({ label }) => label)).toEqual(['hub-label', 'ops-label'])
})

test('distribution refreshes maintenance drift and leaves checkout-owned drift alone', () => {
  const plan = decideLaunchAgentRefresh({
    installationKind: 'distribution',
    owners,
    observations: {
      'hub-label': compared(true),
      'com.user.orch-record-sync': compared(false),
      'ops-label': compared(false),
    },
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

test('an unavailable comparison is unverified instead of drifted', () => {
  const plan = decideLaunchAgentRefresh({
    installationKind: 'checkout',
    owners: [owners[0]!],
    observations: {
      'hub-label': {
        programPath: '/installed/program',
        programExists: true,
        comparison: { kind: 'unavailable', detail: 'flyctl is not installed', command: null },
      },
    },
  })
  expect(plan.unverified).toEqual([{ label: 'hub-label', detail: 'flyctl is not installed' }])
  expect(plan.labels).toEqual([])
  expect(plan.checkoutCommands).toEqual([])
})

test('matching definitions produce an empty refresh plan', () => {
  const plan = decideLaunchAgentRefresh({
    installationKind: 'checkout',
    owners,
    observations: Object.fromEntries(owners.map(({ label }) => [label, compared(true)])),
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
          loaded: true,
          plistMatches: ++factsRead > 1,
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
        { label: 'com.user.orch-record-sync', loaded: true, plistMatches: false },
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
