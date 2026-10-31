import { expect, test } from 'bun:test'
import { decideMachineLabel } from '../orchestrator/src/record/machine-name.ts'
import { crossMachineLabel } from './machine-label.ts'

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

test('a run label parses back to its machine name and number', () => {
  const label = crossMachineLabel('run', 123, machine)
  expect(decideMachineLabel(label, { shortName: machine.shortName, formerShortNames: [] })).toEqual(
    {
      kind: 'bare',
      remainder: '123',
    },
  )
})
