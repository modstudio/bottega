import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
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
  test('allows the complete kind table on task, epic, and session profiles', () => {
    for (const profile of ['task', 'epic', 'session'] as const) {
      for (const kind of Object.keys(CONTEXT_ITEM_MAX_CHARS) as ContextItem['kind'][]) {
        expect(
          contextWriteRefusal(
            item({ kind, source: kind === 'ruling' ? 'q5282' : 'run:1' }),
            facts({ profile }),
          ),
        ).toBeNull()
      }
    }
  })
  test('refuses an empty source', () => {
    expect(contextWriteRefusal(item({ source: ' ' }), facts())).toContain(
      'requires a non-empty source',
    )
  })
  test('refuses each kind over its provisional character limit', () => {
    for (const [kind, limit] of Object.entries(CONTEXT_ITEM_MAX_CHARS)) {
      const ruling = kind === 'ruling' ? { source: 'q5282' } : {}
      expect(
        contextWriteRefusal(
          item({ ...ruling, kind: kind as ContextItem['kind'], body: 'x'.repeat(limit + 1) }),
          facts(),
        ),
      ).toContain(`${kind} limit is ${limit} characters`)
    }
  })
  test('allows a ruling sourced to a question, a board message or the chat, without an objection', () => {
    for (const source of [
      'q5282',
      'board:01a1be0a-4ad8-73d2-9632-307df24b83b6',
      'chat 2026-11-08',
    ]) {
      expect(contextWriteRefusal(item({ kind: 'ruling', source }), facts())).toBeNull()
    }
  })
  test('refuses a ruling whose source names no question, board message or chat date', () => {
    for (const source of ['run:1', 'operator', 'question 5282', 'chat']) {
      expect(contextWriteRefusal(item({ kind: 'ruling', source }), facts())).toContain(
        'write --source as q<number>, board:<id> or chat <YYYY-MM-DD>',
      )
    }
  })
  test('refuses a ruling without a body', () => {
    expect(
      contextWriteRefusal(item({ kind: 'ruling', source: 'q5282', body: ' ' }), facts()),
    ).toContain('requires a non-empty body')
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
      const ruling = kind === 'ruling' ? { source: 'q5282' } : {}
      expect(
        contextWriteRefusal(
          item({ ...ruling, holder: 'session:s', kind }),
          facts({ profile: 'session', claimedTask: 'DEV-1844' }),
        ),
      ).toContain(`${PLATFORM_SLUG} agent context set --task DEV-1844`)
    }
  })
  test('allows session rulings when there is no live task claim', () => {
    expect(
      contextWriteRefusal(
        item({ holder: 'session:s', kind: 'ruling', source: 'q5282' }),
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
    ).toContain('revise existing item task:DEV-1844/next')
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
  expect(missingContextKinds([], 'epic')).toEqual(['next-action'])
  expect(missingContextKinds([], 'session')).toEqual([])
  expect(contextWriteRefusal(item(), facts())).toBeNull()
  const next = item({ kind: 'next-action' })
  expect(contextDropRefusal(next, [next], 'task')).toContain('last required next-action')
})
