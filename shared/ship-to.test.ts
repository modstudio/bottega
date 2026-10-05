import { expect, test } from 'bun:test'
import { storedShipToLevel } from './ship-to.ts'

test('stored ship-to names and aliases map to the three levels', () => {
  expect(
    ['branch', 'trunk', 'production', 'push', 'land', 'promote', 'automatic'].map(
      storedShipToLevel,
    ),
  ).toEqual(['branch', 'trunk', 'production', 'branch', 'trunk', 'production', undefined])
})
