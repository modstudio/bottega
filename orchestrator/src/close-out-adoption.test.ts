import { describe, expect, test } from 'bun:test'
import { adoptedTreeCloseOutDecision } from './close-out-adoption.ts'

describe('adopted tree close-out', () => {
  test('releases only after the owner and every sharer are terminal', () => {
    expect(
      adoptedTreeCloseOutDecision({
        ownership: 'attached',
        ownerAlive: false,
        sharerAlive: false,
        ownerHeld: false,
      }),
    ).toBe('release-adopted')
    expect(
      adoptedTreeCloseOutDecision({
        ownership: 'attached',
        ownerAlive: true,
        sharerAlive: false,
        ownerHeld: false,
      }),
    ).toBe('forgotten')
    expect(
      adoptedTreeCloseOutDecision({
        ownership: 'attached',
        ownerAlive: false,
        sharerAlive: true,
        ownerHeld: false,
      }),
    ).toBe('forgotten')
  })

  test('a terminal owner with a keep-tree hold is forgotten', () => {
    expect(
      adoptedTreeCloseOutDecision({
        ownership: 'attached',
        ownerAlive: false,
        sharerAlive: false,
        ownerHeld: true,
      }),
    ).toBe('forgotten')
  })
})
