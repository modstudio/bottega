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
} from './setup-schedules.ts'

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
