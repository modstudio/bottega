import { describe, expect, test } from 'bun:test'
import { decideShipToReach } from './ship-to-reach.ts'

describe('ship-to reach', () => {
  test.each([
    ['branch', false],
    ['trunk', true],
    ['production', true],
  ] as const)('%s with no rungs', (level, mayMerge) => {
    expect(decideShipToReach(level, [])).toEqual({
      allowed: true,
      mayMerge,
      reach: [],
      remaining: [],
    })
  })

  test('branch and trunk leave every rung remaining and ignore depth', () => {
    expect(decideShipToReach('branch', ['staging', 'production'], 'absent')).toEqual({
      allowed: true,
      mayMerge: false,
      reach: [],
      remaining: ['staging', 'production'],
    })
    expect(decideShipToReach('trunk', ['staging', 'production'], 'staging')).toEqual({
      allowed: true,
      mayMerge: true,
      reach: [],
      remaining: ['staging', 'production'],
    })
  })

  test('production reaches every rung when depth is absent', () => {
    expect(decideShipToReach('production', ['staging', 'production'])).toEqual({
      allowed: true,
      mayMerge: true,
      reach: ['staging', 'production'],
      remaining: [],
    })
  })

  test('production depth reaches through the named first rung', () => {
    expect(decideShipToReach('production', ['staging', 'production'], 'staging')).toEqual({
      allowed: true,
      mayMerge: true,
      reach: ['staging'],
      remaining: ['production'],
    })
  })

  test('production refuses a depth that names no registered rung', () => {
    expect(decideShipToReach('production', ['staging', 'production'], 'preview')).toEqual({
      allowed: false,
      refusal:
        'ship-to depth "preview" names no registered release rung; registered rungs: staging, production; pass a registered rung name or omit depth',
    })
  })
})
