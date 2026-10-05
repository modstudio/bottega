import { expect, test } from 'bun:test'
import { readStoredShipTo, storedShipToLevel } from './ship-to.ts'

test('stored ship-to names and aliases map to the three levels', () => {
  expect(
    ['branch', 'trunk', 'production', 'push', 'land', 'promote', 'automatic'].map(
      storedShipToLevel,
    ),
  ).toEqual(['branch', 'trunk', 'production', 'branch', 'trunk', 'production', undefined])
})

test('the stored-key reader applies precedence, fallback, invalid reporting, and absence', () => {
  expect(readStoredShipTo('production', 'push', true, true)).toEqual({ level: 'production' })
  expect(readStoredShipTo('automatic', 'push', true, true)).toEqual({
    level: 'branch',
    invalid: 'automatic',
  })
  expect(readStoredShipTo('automatic', 'invalid', true, true)).toEqual({
    invalid: 'automatic',
  })
  expect(readStoredShipTo(undefined, undefined, false, false)).toEqual({})
})
