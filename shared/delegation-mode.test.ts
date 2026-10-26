import { describe, expect, test } from 'bun:test'
import { type DelegationSettings, delegationClass, delegationMode } from './delegation-mode.ts'

const settings: DelegationSettings = {
  'delegation.implement': 'harness',
  'delegation.review': 'external',
}

describe('delegation mode', () => {
  test('classifies every writing job as implement and every other job as review', () => {
    expect(delegationClass({ writesRepo: true })).toBe('implement')
    expect(delegationClass({ writesRepo: false })).toBe('review')
    expect(delegationClass({})).toBe('review')
  })

  test('reads the selected class from machine settings', () => {
    expect(delegationMode({ writesRepo: true }, settings)).toBe('harness')
    expect(delegationMode({ readsRepo: true }, settings)).toBe('external')
  })
})
