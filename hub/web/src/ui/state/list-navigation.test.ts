import { describe, expect, test } from 'bun:test'
import { moveIndex, typeaheadIndex } from './list-navigation'

describe('moveIndex', () => {
  const none = [false, false, false, false]
  test('wraps at both ends when looping', () => {
    expect(moveIndex('ArrowDown', 3, none)).toBe(0)
    expect(moveIndex('ArrowUp', 0, none)).toBe(3)
  })
  test('stays at the edge when not looping', () => {
    expect(moveIndex('ArrowDown', 3, none, false)).toBe(3)
    expect(moveIndex('ArrowUp', 0, none, false)).toBe(0)
  })
  test('skips disabled items, including at Home and End', () => {
    const disabled = [true, false, true, false]
    expect(moveIndex('ArrowDown', 1, disabled)).toBe(3)
    expect(moveIndex('Home', 3, disabled)).toBe(1)
    expect(moveIndex('End', 1, [false, false, false, true])).toBe(2)
  })
  test('enters an unfocused list from either end', () => {
    expect(moveIndex('ArrowDown', -1, none)).toBe(0)
    expect(moveIndex('ArrowUp', -1, none)).toBe(3)
  })
})

describe('typeaheadIndex', () => {
  const labels = ['Apple', 'Banana', 'Blueberry', 'Cherry']
  const none = [false, false, false, false]
  test('a repeated letter cycles through its matches', () => {
    expect(typeaheadIndex('b', labels, 1, none)).toBe(2)
    expect(typeaheadIndex('bb', labels, 2, none)).toBe(1)
  })
  test('a longer prefix keeps the current item when it still matches', () => {
    expect(typeaheadIndex('blu', labels, 2, none)).toBe(2)
    expect(typeaheadIndex('ban', labels, 2, none)).toBe(1)
  })
  test('skips disabled items and keeps the current item when nothing matches', () => {
    expect(typeaheadIndex('b', labels, 0, [false, true, false, false])).toBe(2)
    expect(typeaheadIndex('z', labels, 3, none)).toBe(3)
  })
})
