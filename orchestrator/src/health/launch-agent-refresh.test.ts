import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { InstalledPlistOwner } from '../setup/launchd-owners.ts'
import type { LaunchAgentDefinitionObservation } from './launch-agent-doctor.ts'
import { decideLaunchAgentRefresh } from './launch-agent-refresh.ts'

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
