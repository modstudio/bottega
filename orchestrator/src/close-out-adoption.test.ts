import { describe, expect, test } from 'bun:test'
import { adoptedTreeCloseOutDecision } from './close-out-adoption.ts'

describe('adopted tree close-out', () => {
  test('releases only after the owner and every sharer are terminal', () => {
    expect(
      adoptedTreeCloseOutDecision({
        ownership: 'attached',
        ownerAlive: false,
        sharerAlive: false,
      }),
    ).toBe('release-adopted')
    expect(
      adoptedTreeCloseOutDecision({
        ownership: 'attached',
        ownerAlive: true,
        sharerAlive: false,
      }),
    ).toBe('forgotten')
    expect(
      adoptedTreeCloseOutDecision({
        ownership: 'attached',
        ownerAlive: false,
        sharerAlive: true,
      }),
    ).toBe('forgotten')
  })
})
