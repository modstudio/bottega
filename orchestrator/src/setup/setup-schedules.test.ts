import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  RECORD_SYNC_PENDING_MARKER,
  recordSyncQueueDirectory,
  STATE_HOME_ENV,
} from '../../../shared/state-directory.ts'
import {
  MAINTENANCE_SCHEDULE_LABELS,
  maintenanceSchedulePlan,
  renderMaintenanceSchedule,
  requiredMaintenanceLabels,
  SYSTEMD_UNITS,
} from './setup-schedule-policy.ts'

const skipFacts = {
  modelHostAlias: '',
  recordTunnelApp: '',
  flyctlOnPath: false,
}

test('schedule install plan uses the canonical labels and shared skip decision', () => {
  expect(maintenanceSchedulePlan(skipFacts)).toEqual(
    MAINTENANCE_SCHEDULE_LABELS.map((label) => ({ label, skipReason: null })),
  )
})

test('required schedules are the unskipped canonical labels only at full level', () => {
  expect(requiredMaintenanceLabels(skipFacts, 'full')).toEqual([...MAINTENANCE_SCHEDULE_LABELS])
  expect(requiredMaintenanceLabels(skipFacts, 'record')).toEqual([])
})

test('distribution schedule rendering replaces every placeholder for both labels', () => {
  for (const label of MAINTENANCE_SCHEDULE_LABELS) {
    const template = readFileSync(
      join(import.meta.dir, '..', '..', '..', 'ops', 'launchd', `${label}.plist.template`),
      'utf8',
    )
    const rendered = renderMaintenanceSchedule(template, {
      bottegaBin: `/Applications/${PLATFORM_NAME}/${PLATFORM_SLUG}`,
      home: '/Users/operator',
      stateHomeEnvironment: 'BOTTEGA_STATE_HOME',
      stateHome: `/Users/operator/.local/state/${PLATFORM_SLUG}`,
    })
    expect(rendered).toContain(`/Applications/${PLATFORM_NAME}/${PLATFORM_SLUG}`)
    expect(rendered.match(/__[A-Z0-9_]+__/g)).toBeNull()
  }
})

test('record sync schedule drains the queue before record push', () => {
  const template = readFileSync(
    join(
      import.meta.dir,
      '..',
      '..',
      '..',
      'ops',
      'launchd',
      'com.user.orch-record-sync.plist.template',
    ),
    'utf8',
  )
  const rendered = renderMaintenanceSchedule(template, {
    bottegaBin: `/Applications/${PLATFORM_NAME}/${PLATFORM_SLUG}`,
    home: '/Users/operator',
    stateHomeEnvironment: 'BOTTEGA_STATE_HOME',
    stateHome: `/Users/operator/.local/state/${PLATFORM_SLUG}`,
  })
  const remove = rendered.indexOf('rm -f &quot;')
  const push = rendered.indexOf('record push')
  expect(remove).toBeGreaterThan(-1)
  expect(push).toBeGreaterThan(remove)
  const env = { [STATE_HOME_ENV]: `/Users/operator/.local/state/${PLATFORM_SLUG}` }
  const queue = recordSyncQueueDirectory(env)
  expect(rendered.match(/rm -f &quot;([^&]+)&quot;/)?.[1]).toBe(
    join(queue, RECORD_SYNC_PENDING_MARKER),
  )
  expect(
    rendered.match(/<key>QueueDirectories<\/key>\s*<array>\s*<string>([^<]+)<\/string>/)?.[1],
  ).toBe(queue)
})

test('systemd schedule units render every placeholder and preserve intervals and queue', () => {
  const directory = join(import.meta.dir, '..', '..', '..', 'ops', 'systemd')
  const values = {
    bottegaBin: `/opt/${PLATFORM_SLUG}/bin/${PLATFORM_SLUG}`,
    home: '/home/operator',
    stateHomeEnvironment: STATE_HOME_ENV,
    stateHome: `/home/operator/.local/state/${PLATFORM_SLUG}`,
  }
  const queue = recordSyncQueueDirectory({ [STATE_HOME_ENV]: values.stateHome })
  const expectations = new Map<string, string[]>([
    ['orch-sweep.service', ['machine sweep', 'Nice=10', 'IOSchedulingClass=idle']],
    ['orch-sweep.timer', ['OnStartupSec=120', 'OnUnitActiveSec=7200']],
    ['orch-record-sync.service', ['record push', 'record publish']],
    ['orch-record-sync.timer', ['OnStartupSec=60', 'OnUnitActiveSec=300']],
    ['orch-record-sync.path', [`DirectoryNotEmpty=${queue}`]],
  ])

  expect(SYSTEMD_UNITS['com.user.orch-sweep']).toEqual(['orch-sweep.service', 'orch-sweep.timer'])
  expect(SYSTEMD_UNITS['com.user.orch-record-sync']).toEqual([
    'orch-record-sync.service',
    'orch-record-sync.timer',
    'orch-record-sync.path',
  ])
  for (const units of Object.values(SYSTEMD_UNITS)) {
    for (const name of units) {
      const rendered = renderMaintenanceSchedule(
        readFileSync(join(directory, name), 'utf8'),
        values,
      )
      expect(rendered.match(/__[A-Z0-9_]+__/g)).toBeNull()
      for (const fragment of expectations.get(name) ?? []) expect(rendered).toContain(fragment)
    }
  }
})
