import { describe, expect, test } from 'bun:test'
import { adoptedTreeCloseOutDecision } from './close-out-adoption.ts'

describe('adopted tree close-out', () => {
  test('forgets an attached tree when nothing is live', () => {
    expect(adoptedTreeCloseOutDecision('attached')).toBe('forgotten')
  })
})
