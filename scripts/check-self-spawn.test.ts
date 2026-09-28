import { describe, expect, test } from 'bun:test'
import { acceptedSelfSpawnFixture, rejectedSelfSpawnFixtures } from './check-self-spawn.fixtures.ts'
import { selfSpawnViolationLines } from './check-self-spawn.ts'

describe('self-spawn enforcement fixtures', () => {
  for (const [name, fixture] of Object.entries(rejectedSelfSpawnFixtures)) {
    test(`rejects ${name}`, () => {
      expect(selfSpawnViolationLines(fixture)).toHaveLength(1)
    })
  }

  test('accepts a leading resolver spread through a local argv variable', () => {
    expect(selfSpawnViolationLines(acceptedSelfSpawnFixture)).toEqual([])
  })
})
