import { expect, test } from 'bun:test'
import { rulingPersonName } from './ruling-attribution.ts'

test('a person ruling uses the cached signed-in display name', () => {
  expect(rulingPersonName(true, 'Ada Lovelace', 'machine-user')).toBe('Ada Lovelace')
})

test('a person ruling falls back to the OS username and an agent ruling has no name', () => {
  expect(rulingPersonName(true, null, 'machine-user')).toBe('machine-user')
  expect(rulingPersonName(false, 'Ada Lovelace', 'machine-user')).toBeNull()
})
