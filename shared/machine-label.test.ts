import { expect, test } from 'bun:test'
import { crossMachineLabel, resolveMachineDisplayName } from './machine-label.ts'

const machine = {
  id: '01a0ab05-0000-7000-8000-000000000001',
  shortName: 'starship',
}

test('labels cross-machine run and question numbers with the short name', () => {
  expect(crossMachineLabel('run', 123, machine)).toBe('starship/123')
  expect(crossMachineLabel('question', 9, machine)).toBe('starship/q9')
})

test('labels a machine without a short name with its id prefix', () => {
  expect(crossMachineLabel('run', 123, { ...machine, shortName: null })).toBe('01a0ab05/123')
})

test('resolves the display name before the short name', () => {
  expect(resolveMachineDisplayName({ shortName: 'machine-a', displayName: 'Machine A' })).toBe(
    'Machine A',
  )
  expect(resolveMachineDisplayName({ shortName: 'machine-a', displayName: null })).toBe('machine-a')
  expect(resolveMachineDisplayName({ shortName: null, displayName: null })).toBeNull()
})
