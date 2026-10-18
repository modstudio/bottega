import { describe, expect, test } from 'bun:test'
import { overlayPortItems } from './port-overlay.ts'

type Item = { key: string; value: string }
const overlay = (local: Item[], hosted: Item[]) =>
  overlayPortItems(local, hosted, (item) => item.key)

describe('port item overlay', () => {
  test('an empty hosted space returns local items', () => {
    expect(overlay([{ key: 'one', value: 'local' }], [])).toEqual([{ key: 'one', value: 'local' }])
  })

  test('a hosted item wins on the same natural key', () => {
    expect(overlay([{ key: 'one', value: 'local' }], [{ key: 'one', value: 'hosted' }])).toEqual([
      { key: 'one', value: 'hosted' },
    ])
  })

  test('a list merges hosted items with unmatched local items', () => {
    expect(
      overlay(
        [
          { key: 'one', value: 'local-one' },
          { key: 'two', value: 'local-two' },
        ],
        [
          { key: 'one', value: 'hosted-one' },
          { key: 'three', value: 'hosted-three' },
        ],
      ),
    ).toEqual([
      { key: 'one', value: 'hosted-one' },
      { key: 'three', value: 'hosted-three' },
      { key: 'two', value: 'local-two' },
    ])
  })
})
