import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { localGateRegistrationDecision } from './local-gate-registration.ts'

describe('local machine-state check registration', () => {
  const checkout = '/home/dev/Projects/bottega'

  test('runs for a registered checkout', () => {
    expect(localGateRegistrationDecision(checkout, { kind: 'registered' })).toEqual({
      kind: 'run',
    })
  })

  test('skips an unregistered checkout with the registration remedy', () => {
    expect(localGateRegistrationDecision(checkout, { kind: 'unregistered' })).toEqual({
      kind: 'skip',
      message: `checkout ${checkout} is not registered because the project register has no project containing this checkout; remedy: ${PLATFORM_SLUG} project add ${JSON.stringify(checkout)}`,
    })
  })

  test('skips when the store is absent', () => {
    expect(localGateRegistrationDecision(checkout, { kind: 'absent-store' })).toMatchObject({
      kind: 'skip',
      message: expect.stringContaining('the orchestrator store is absent'),
    })
  })

  test('skips when the store has no project table', () => {
    expect(localGateRegistrationDecision(checkout, { kind: 'absent-register' })).toMatchObject({
      kind: 'skip',
      message: expect.stringContaining('the orchestrator store has no project register'),
    })
  })

  test('fails instead of skipping when a registered checkout store is unreadable', () => {
    expect(
      localGateRegistrationDecision(checkout, {
        kind: 'unreadable-store',
        detail: 'permission denied',
      }),
    ).toEqual({
      kind: 'fail',
      message: `cannot read the project register for checkout ${checkout}: permission denied`,
    })
  })
})
