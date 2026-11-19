import { describe, expect, test } from 'bun:test'
import {
  exactHunksIdentity,
  type SameChangeDecision,
  type SameChangeFacts,
  sameChange,
  sameStoredChangeOrWitness,
  storedChangeFacts,
} from './same-change.ts'

test('exact hunks include context but ignore moved line coordinates', () => {
  const reviewed = '@@ -2,3 +2,3 @@\n context\n-old\n+new\n context\n'
  const moved = '@@ -20,3 +20,3 @@\n context\n-old\n+new\n context\n'
  const changedContext = '@@ -20,3 +20,3 @@\n other context\n-old\n+new\n context\n'
  expect(exactHunksIdentity(reviewed)).toBe(exactHunksIdentity(moved))
  expect(exactHunksIdentity(reviewed)).not.toBe(exactHunksIdentity(changedContext))
})

const change = (zero: string | null, paths: string[] | null = ['src/a.ts'], patch = 'legacy') => ({
  patchId: patch,
  zeroContextPatchId: zero,
  paths,
  message: 'message',
})

test('a stored change matches by exact identity or a positive replay witness', () => {
  const current = { patchId: 'current', zeroContextPatchId: 'current', pathSet: '["src/a.ts"]' }
  const other = { patchId: 'other', zeroContextPatchId: 'other', pathSet: '["src/a.ts"]' }
  expect(sameStoredChangeOrWitness(current, current)).toBe(true)
  expect(sameStoredChangeOrWitness({ ...other, replayMatchesCurrent: true }, current)).toBe(true)
  expect(sameStoredChangeOrWitness({ ...other, replayMatchesCurrent: false }, current)).toBe(false)
})

const cases: Array<{
  name: string
  facts: SameChangeFacts
  expected: {
    same: boolean
    basis: SameChangeDecision['basis']
    reason: string | null
    messageChanged?: boolean
  }
}> = [
  {
    name: 'matching zero-context identities',
    facts: {
      reviewed: change('same'),
      current: change('same', ['src/a.ts'], 'different'),
      replay: null,
    },
    expected: { same: true, basis: 'zero-context', reason: null },
  },
  {
    name: 'matching legacy identities when one zero-context identity is absent',
    facts: { reviewed: change(null), current: change('measured'), replay: null },
    expected: { same: true, basis: 'legacy', reason: null },
  },
  {
    name: 'replay with the same tree',
    facts: { reviewed: change('old'), current: change('new'), replay: { kind: 'same-tree' } },
    expected: { same: true, basis: 'replay', reason: null },
  },
  {
    name: 'conflicting replay',
    facts: { reviewed: change('old'), current: change('new'), replay: { kind: 'conflict' } },
    expected: { same: false, basis: 'different', reason: 'change replay conflicted' },
  },
  {
    name: 'different replay tree',
    facts: { reviewed: change('old'), current: change('new'), replay: { kind: 'different-tree' } },
    expected: { same: false, basis: 'different', reason: 'change identity differs' },
  },
  {
    name: 'unavailable replay',
    facts: {
      reviewed: change('old'),
      current: change('new'),
      replay: { kind: 'unavailable', reason: 'reviewed commit abc is missing' },
    },
    expected: { same: false, basis: 'different', reason: 'reviewed commit abc is missing' },
  },
  {
    name: 'different path sets',
    facts: { reviewed: change('same'), current: change('same', ['src/b.ts']), replay: null },
    expected: { same: false, basis: 'different', reason: 'path set differs' },
  },
  {
    name: 'message-only change',
    facts: {
      reviewed: change('same'),
      current: { ...change('same'), message: 'new message' },
      replay: null,
    },
    expected: { same: true, basis: 'zero-context', reason: null, messageChanged: true },
  },
  {
    name: 'unknown stored path set',
    facts: {
      reviewed: storedChangeFacts({
        patchId: 'legacy',
        zeroContextPatchId: 'same',
        pathSet: '{unparseable',
      }),
      current: { ...change('same'), message: null },
      replay: { kind: 'same-tree' },
    },
    expected: { same: false, basis: 'different', reason: 'path set unavailable' },
  },
]

describe('same change decision branches', () => {
  for (const { name, facts, expected } of cases) {
    test(name, () => {
      const decision = sameChange(facts)
      expect(decision.same).toBe(expected.same)
      expect(decision.basis).toBe(expected.basis)
      expect(decision.reason).toBe(expected.reason)
      expect(decision.messageChanged).toBe(expected.messageChanged ?? false)
    })
  }

  test('a null stored path set is also unknown', () => {
    expect(
      storedChangeFacts({ patchId: 'legacy', zeroContextPatchId: 'same', pathSet: null }).paths,
    ).toBeNull()
  })
})
