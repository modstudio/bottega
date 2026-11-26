import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  LAUNCHD_TEMPLATE_PATHS,
  LONG_RUNNING_MAINTENANCE_LABELS,
  MAINTENANCE_SCHEDULE_LABELS,
  NOT_SCHEDULED_BY_THIS_INSTALL,
  SYSTEMD_TEMPLATE_DIRECTORY,
  SYSTEMD_UNITS,
  scheduleExpectation,
  systemdActivationUnits,
} from './schedule-policy.ts'

const checkoutOwners = [{ label: 'com.user.hub-collect', checkoutOnly: true }] as const

test('collector expectation follows platform and installation ownership', () => {
  const label = 'com.user.hub-collect'
  expect(
    scheduleExpectation(label, 'darwin', 'distribution', 'full', checkoutOwners).scheduled,
  ).toBe(true)
  expect(
    scheduleExpectation(label, 'linux', 'distribution', 'full', checkoutOwners).scheduled,
  ).toBe(true)
  expect(scheduleExpectation(label, 'darwin', 'checkout', 'record', checkoutOwners).scheduled).toBe(
    true,
  )
  expect(scheduleExpectation(label, 'linux', 'checkout', 'full', checkoutOwners)).toEqual({
    scheduled: false,
    reason: NOT_SCHEDULED_BY_THIS_INSTALL,
  })
  for (const platform of ['darwin', 'linux'] as const) {
    expect(scheduleExpectation(label, platform, 'distribution', 'record', checkoutOwners)).toEqual({
      scheduled: false,
      reason: NOT_SCHEDULED_BY_THIS_INSTALL,
    })
  }
  expect(
    scheduleExpectation(label, 'win32', 'distribution', 'full', checkoutOwners).scheduled,
  ).toBe(false)
  expect(scheduleExpectation(label, 'win32', 'checkout', 'full', checkoutOwners).scheduled).toBe(
    false,
  )
})

test('a non-checkout-only owner is not scheduled by a darwin checkout', () => {
  expect(
    scheduleExpectation('com.user.hub-collect', 'darwin', 'checkout', 'full', [
      { label: 'com.user.hub-collect', checkoutOnly: false },
    ]),
  ).toEqual({ scheduled: false, reason: NOT_SCHEDULED_BY_THIS_INSTALL })
})

test('a service-only systemd label activates its service', () => {
  expect(systemdActivationUnits('com.user.hub-collect')).toEqual(['hub-collect.service'])
})

test('declared long-running labels exactly match systemd and launchd templates', () => {
  const root = resolve(import.meta.dir, '..')
  const systemdLongRunning = MAINTENANCE_SCHEDULE_LABELS.filter((label) =>
    SYSTEMD_UNITS[label].some(
      (unit) =>
        unit.endsWith('.service') &&
        /^Type=simple$/m.test(
          readFileSync(resolve(root, SYSTEMD_TEMPLATE_DIRECTORY, unit), 'utf8'),
        ),
    ),
  )
  const launchdLongRunning = MAINTENANCE_SCHEDULE_LABELS.filter((label) =>
    /<key>KeepAlive<\/key>\s*<true\/>/.test(
      readFileSync(resolve(root, LAUNCHD_TEMPLATE_PATHS[label]), 'utf8'),
    ),
  )
  expect(systemdLongRunning).toEqual([...LONG_RUNNING_MAINTENANCE_LABELS])
  expect(launchdLongRunning).toEqual([...LONG_RUNNING_MAINTENANCE_LABELS])
})
