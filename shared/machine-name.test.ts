import { expect, test } from 'bun:test'
import {
  decideMachineNameClaim,
  defaultShortName,
  displayNameRefusal,
  shortNameRefusal,
} from './machine-name.ts'

test('validates machine names in both directions', () => {
  expect(shortNameRefusal('office-2')).toBeNull()
  expect(shortNameRefusal('2office')).toContain('starting with a letter')
  expect(shortNameRefusal('a')).not.toBeNull()
  expect(displayNameRefusal('Office Mac')).toBeNull()
  expect(displayNameRefusal('')).not.toBeNull()
  expect(displayNameRefusal('x'.repeat(61))).not.toBeNull()
})

test('normalizes hostnames and bounds their length', () => {
  expect(defaultShortName('Office Mac.local')).toBe('office-mac-local')
  expect(defaultShortName('123_box')).toBe('m-123-box')
  expect(defaultShortName('This-is-a-very-long-machine-hostname')).toBe('this-is-a-very-long')
})

test('decides every claim outcome, including retired and former claims', () => {
  const claims = [
    { machineId: 'mine', shortName: 'former', retired: false },
    { machineId: 'other', shortName: 'office', retired: false },
    { machineId: 'retired', shortName: 'old', retired: true },
  ]
  expect(decideMachineNameClaim(claims, 'mine', 'new-name')).toEqual({ status: 'claim' })
  expect(decideMachineNameClaim(claims, 'mine', 'former')).toEqual({ status: 'held-by-self' })
  expect(decideMachineNameClaim(claims, 'mine', 'Bad')).toEqual({
    status: 'refused',
    reason: expect.stringContaining('starting with a letter'),
  })
  expect(decideMachineNameClaim(claims, 'mine', 'office')).toEqual({
    status: 'refused',
    reason: expect.stringContaining('bottega machine rename'),
  })
  expect(decideMachineNameClaim(claims, 'mine', 'old')).toEqual({
    status: 'refused',
    reason: expect.stringContaining('(retired)'),
  })
})
