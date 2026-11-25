import { expect, test } from 'bun:test'
import {
  NOT_SCHEDULED_BY_THIS_INSTALL,
  scheduleExpectation,
  systemdActivationUnits,
} from './schedule-policy.ts'

const checkoutOwners = [
  { label: 'com.user.hub-collect', checkoutOnly: true },
  { label: 'com.user.orch-sweep', checkoutOnly: true },
] as const

for (const label of ['com.user.hub-collect', 'com.user.orch-sweep'] as const) {
  test(`${label} expectation follows platform and installation ownership`, () => {
    expect(
      scheduleExpectation(label, 'darwin', 'distribution', 'full', checkoutOwners).scheduled,
    ).toBe(true)
    expect(
      scheduleExpectation(label, 'linux', 'distribution', 'full', checkoutOwners).scheduled,
    ).toBe(true)
    expect(
      scheduleExpectation(label, 'darwin', 'checkout', 'record', checkoutOwners).scheduled,
    ).toBe(true)
    expect(scheduleExpectation(label, 'linux', 'checkout', 'full', checkoutOwners)).toEqual({
      scheduled: false,
      reason: NOT_SCHEDULED_BY_THIS_INSTALL,
    })
    for (const platform of ['darwin', 'linux'] as const) {
      expect(
        scheduleExpectation(label, platform, 'distribution', 'record', checkoutOwners),
      ).toEqual({ scheduled: false, reason: NOT_SCHEDULED_BY_THIS_INSTALL })
    }
    expect(
      scheduleExpectation(label, 'win32', 'distribution', 'full', checkoutOwners).scheduled,
    ).toBe(false)
    expect(scheduleExpectation(label, 'win32', 'checkout', 'full', checkoutOwners).scheduled).toBe(
      false,
    )
  })
}

test('a service-only systemd label activates its service', () => {
  expect(systemdActivationUnits('com.user.hub-collect')).toEqual(['hub-collect.service'])
})
