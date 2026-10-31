import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { crossMachineLabel } from '../../../shared/machine-label.ts'
import {
  decideMachineLabel,
  decideMachineNameClaim,
  defaultShortName,
  displayNameRefusal,
  shortNameRefusal,
} from './machine-name.ts'

test('decides current, former, foreign, absent, and malformed machine labels', () => {
  const names = { shortName: 'mine', formerShortNames: ['old-mine'] }
  expect(decideMachineLabel('mine/42', names)).toEqual({ kind: 'bare', remainder: '42' })
  expect(decideMachineLabel('old-mine/q7', names)).toEqual({ kind: 'bare', remainder: 'q7' })
  expect(decideMachineLabel('other/123', names)).toEqual({
    kind: 'refused',
    reason:
      "`other/123` names a row on machine `other`; this command acts only on this machine's (`mine`) rows",
  })
  expect(decideMachineLabel('mine/42', null)).toEqual({
    kind: 'refused',
    reason: expect.stringContaining('record space switch --short-name'),
  })
  expect(decideMachineLabel('Bad/42', names)).toEqual({ kind: 'not-label' })
})

test('a cross-machine run label parses back to the same name and number', () => {
  const machine = {
    id: '01a0ab05-0000-7000-8000-000000000001',
    shortName: 'starship',
  }
  const label = crossMachineLabel('run', 123, machine)
  expect(decideMachineLabel(label, { shortName: machine.shortName, formerShortNames: [] })).toEqual(
    {
      kind: 'bare',
      remainder: '123',
    },
  )
})

test('cross-machine labels for an unnamed machine are recognized and refused', () => {
  const machine = {
    id: '01a0ab05-0000-7000-8000-000000000001',
    shortName: null,
  }
  const names = { shortName: 'mine', formerShortNames: [] }
  for (const [kind, number, remainder] of [
    ['run', 123, '123'],
    ['question', 7, 'q7'],
  ] as const) {
    const label = crossMachineLabel(kind, number, machine)
    expect(label).toBe(`01a0ab05/${remainder}`)
    expect(decideMachineLabel(label, names)).toEqual({
      kind: 'refused',
      reason: `\`${label}\` names a row on an unnamed machine with id prefix \`01a0ab05\`; this command acts only on this machine's (\`mine\`) rows`,
    })
  }
})

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
    { machineId: 'mine', shortName: 'former', displayName: 'My machine', retired: false },
    { machineId: 'other', shortName: 'office', displayName: 'Office Mac', retired: false },
    { machineId: 'retired', shortName: 'old', displayName: 'Old laptop', retired: true },
  ]
  expect(decideMachineNameClaim(claims, 'mine', 'new-name')).toEqual({ status: 'claim' })
  expect(decideMachineNameClaim(claims, 'mine', 'former')).toEqual({ status: 'held-by-self' })
  expect(decideMachineNameClaim(claims, 'mine', 'Bad')).toEqual({
    status: 'refused',
    reason: expect.stringContaining('starting with a letter'),
  })
  expect(decideMachineNameClaim(claims, 'mine', 'office')).toEqual({
    status: 'refused',
    reason: `short name office is held by Office Mac (office); choose another with \`${PLATFORM_SLUG} machine rename --short-name <name>\``,
  })
  expect(decideMachineNameClaim(claims, 'mine', 'old')).toEqual({
    status: 'refused',
    reason: `short name old is held by Old laptop (old), retired; choose another with \`${PLATFORM_SLUG} machine rename --short-name <name>\``,
  })
})
