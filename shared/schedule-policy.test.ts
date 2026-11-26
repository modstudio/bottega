import { expect, test } from 'bun:test'
import {
  NOT_SCHEDULED_BY_THIS_INSTALL,
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
