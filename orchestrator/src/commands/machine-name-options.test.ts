import { expect, test } from 'bun:test'
import { resolveRequestedMachineNames } from './machine-name-options.ts'

const storedNames = {
  shortName: 'studio',
  displayName: 'Studio Machine',
}

test('no name flags keep stored machine names without making a claim', () => {
  expect(
    resolveRequestedMachineNames(undefined, undefined, storedNames, 'router-host'),
  ).toBeUndefined()
})

test('no name flags use the hostname default when no names are stored', () => {
  expect(resolveRequestedMachineNames(undefined, undefined, null, 'router-host')).toEqual({
    shortName: 'router-host',
    displayName: 'router-host',
  })
})

test('a short-name flag keeps the stored display name', () => {
  expect(resolveRequestedMachineNames('workshop', undefined, storedNames, 'router-host')).toEqual({
    shortName: 'workshop',
    displayName: 'Studio Machine',
  })
})

test('a display-name flag keeps the stored short name', () => {
  expect(
    resolveRequestedMachineNames(undefined, 'Workshop Machine', storedNames, 'router-host'),
  ).toEqual({
    shortName: 'studio',
    displayName: 'Workshop Machine',
  })
})
