import { describe, expect, test } from 'bun:test'
import {
  CONTEXT_ITEM_MAX_CHARS,
  type ContextItem,
  type ContextWriteFacts,
  contextDropRefusal,
  contextWriteRefusal,
  missingContextKinds,
} from './doc-context-write.ts'

const item = (overrides: Partial<ContextItem> = {}): ContextItem => ({
  holder: 'task:DEV-1844',
  id: 'state',
  kind: 'position',
  source: 'run:1',
  body: 'Current state',
  ...overrides,
})
const facts = (overrides: Partial<ContextWriteFacts> = {}): ContextWriteFacts => ({
  profile: 'task',
  siblings: [],
  related: [],
  pointerRefusal: null,
  claimedTask: null,
  ...overrides,
})

describe('context write refusal', () => {
  test('refuses a kind outside the holder profile', () => {
    expect(contextWriteRefusal(item({ kind: 'position' }), facts({ profile: 'epic' }))).toContain(
      'epic profile does not allow kind position',
    )
  })
  test('refuses an empty source', () => {
    expect(contextWriteRefusal(item({ source: ' ' }), facts())).toContain(
      'requires a non-empty source',
    )
  })
  test('refuses each kind over its provisional character limit', () => {
    for (const [kind, limit] of Object.entries(CONTEXT_ITEM_MAX_CHARS)) {
      const ruling = kind === 'ruling' ? { source: 'agent', objection: 'counterpoint' } : {}
      expect(
        contextWriteRefusal(
          item({ ...ruling, kind: kind as ContextItem['kind'], body: 'x'.repeat(limit + 1) }),
          facts(),
        ),
      ).toContain(`${kind} limit is ${limit} characters`)
    }
  })
  test('refuses a ruling without objection', () => {
    expect(contextWriteRefusal(item({ kind: 'ruling', source: 'operator' }), facts())).toContain(
      'requires a non-empty objection',
    )
  })
  test('refuses a ruling with a non-authoritative source', () => {
    expect(
      contextWriteRefusal(
        item({ kind: 'ruling', source: 'run:1', objection: 'counterpoint' }),
        facts(),
      ),
    ).toContain('source must be operator or agent')
  })
  test('refuses an unresolved or unsafe pointer with the adapter reason', () => {
    expect(
      contextWriteRefusal(
        item({ kind: 'pointer' }),
        facts({ pointerRefusal: 'scratch paths are not durable pointers' }),
      ),
    ).toContain('scratch paths are not durable pointers')
  })
  test('refuses task-level rulings and questions on a claimed session', () => {
    for (const kind of ['ruling', 'open-question'] as const) {
      const ruling = kind === 'ruling' ? { source: 'agent', objection: 'counterpoint' } : {}
      expect(
        contextWriteRefusal(
          item({ ...ruling, holder: 'session:s', kind }),
          facts({ profile: 'session', claimedTask: 'DEV-1844' }),
        ),
      ).toContain('write it to task:DEV-1844')
    }
  })
  test('allows session rulings when there is no live task claim', () => {
    expect(
      contextWriteRefusal(
        item({ holder: 'session:s', kind: 'ruling', source: 'agent', objection: 'counterpoint' }),
        facts({ profile: 'session' }),
      ),
    ).toBeNull()
  })
  test('refuses a second next action', () => {
    expect(
      contextWriteRefusal(
        item({ kind: 'next-action' }),
        facts({ siblings: [item({ id: 'next', kind: 'next-action' })] }),
      ),
    ).toContain('at most one next-action')
  })
  test('refuses normalized equality and long contained restatements', () => {
    expect(
      contextWriteRefusal(
        item({ body: ' SAME   WORDS ' }),
        facts({ related: [item({ holder: 'task:DEV-1', id: 'other', body: 'same words' })] }),
      ),
    ).toContain('task:DEV-1/other')
    const body = 'a'.repeat(80)
    expect(
      contextWriteRefusal(
        item({ body }),
        facts({
          related: [item({ holder: 'task:DEV-1', id: 'long', body: `prefix ${body} suffix` })],
        }),
      ),
    ).toContain('task:DEV-1/long')
  })
})

test('required next action is warned on read and protected on drop, not required on set', () => {
  expect(missingContextKinds([], 'task')).toEqual(['next-action'])
  expect(contextWriteRefusal(item(), facts())).toBeNull()
  const next = item({ kind: 'next-action' })
  expect(contextDropRefusal(next, [next], 'task')).toContain('last required next-action')
})
