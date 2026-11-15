import { describe, expect, test } from 'bun:test'
import { type SameChangeFacts, sameChange } from './same-change.ts'

const change = (zero: string | null, paths = ['src/a.ts'], patch = 'legacy') => ({
  patchId: patch,
  zeroContextPatchId: zero,
  paths,
  message: 'message',
})

const cases: [number, string, SameChangeFacts, boolean][] = [
  [
    1,
    'unrelated trunk files',
    { reviewed: change('same'), current: change('same'), replay: null },
    true,
  ],
  [
    2,
    'nearby trunk edit',
    { reviewed: change('same'), current: change('same', ['src/a.ts'], 'different'), replay: null },
    true,
  ],
  [
    3,
    'moved hunk offsets',
    { reviewed: change('same'), current: change('same'), replay: null },
    true,
  ],
  [
    4,
    'trunk landed some lines',
    { reviewed: change('old'), current: change('shrunk'), replay: { kind: 'same-tree' } },
    true,
  ],
  [
    5,
    'trunk landed the whole change',
    { reviewed: change('old'), current: change('', []), replay: { kind: 'same-tree' } },
    true,
  ],
  [
    6,
    'conflict resolved without changing branch lines',
    { reviewed: change('same'), current: change('same'), replay: null },
    true,
  ],
  [
    7,
    'conflict resolution changed added lines',
    { reviewed: change('old'), current: change('new'), replay: { kind: 'conflict' } },
    false,
  ],
  [
    8,
    'conflict kept trunk hunk',
    { reviewed: change('old'), current: change('shrunk'), replay: { kind: 'conflict' } },
    false,
  ],
  [
    9,
    'commit message amendment',
    {
      reviewed: change('same'),
      current: { ...change('same'), message: 'new message' },
      replay: null,
    },
    true,
  ],
  [
    10,
    'squashed commits',
    { reviewed: change('same'), current: change('same'), replay: null },
    true,
  ],
  [
    11,
    'merge from trunk',
    { reviewed: change('same'), current: change('same'), replay: null },
    true,
  ],
  [
    12,
    'whitespace-only edit',
    { reviewed: change('old'), current: change('new'), replay: { kind: 'different-tree' } },
    false,
  ],
  [
    13,
    'trunk whitespace beside hunk',
    { reviewed: change('same'), current: change('same', ['src/a.ts'], 'different'), replay: null },
    true,
  ],
  [
    14,
    'change renames file',
    {
      reviewed: change('same', ['src/new.ts']),
      current: change('same', ['src/new.ts']),
      replay: null,
    },
    true,
  ],
  [
    15,
    'trunk rename conflicts',
    {
      reviewed: change('old'),
      current: change('new', ['src/new.ts']),
      replay: { kind: 'conflict' },
    },
    false,
  ],
  [
    16,
    'mode-only edit',
    { reviewed: change('old'), current: change('mode'), replay: { kind: 'different-tree' } },
    false,
  ],
  [
    17,
    'binary payload edit',
    {
      reviewed: change('old', ['asset.bin']),
      current: change('binary', ['asset.bin']),
      replay: { kind: 'different-tree' },
    },
    false,
  ],
  [
    18,
    'real post-review code edit',
    { reviewed: change('old'), current: change('new'), replay: { kind: 'different-tree' } },
    false,
  ],
  [
    19,
    'pre-cutover reachable row',
    {
      reviewed: change(null),
      current: change('recomputed', ['src/a.ts'], 'different'),
      replay: { kind: 'same-tree' },
    },
    true,
  ],
  [
    20,
    'pre-cutover missing commit',
    {
      reviewed: change(null),
      current: change('new', ['src/a.ts'], 'different'),
      replay: { kind: 'unavailable', reason: 'reviewed commit abc is missing' },
    },
    false,
  ],
  [
    21,
    'trunk moved unchanged added lines',
    { reviewed: change('same'), current: change('same'), replay: null },
    true,
  ],
  [
    22,
    'git prefix config differs',
    { reviewed: change('same'), current: change('same'), replay: null },
    true,
  ],
]

describe('DEV-2307 same-change matrix', () => {
  for (const [number, name, facts, expected] of cases) {
    test(`${number}. ${name}`, () => {
      const decision = sameChange(facts)
      expect(decision.same).toBe(expected)
      if (number === 9) expect(decision.messageChanged).toBe(true)
      if (number === 20) expect(decision.reason).toContain('reviewed commit abc is missing')
    })
  }
})
