import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  CONTEXT_ITEM_MAX_CHARS,
  type ContextItem,
  type ContextWriteFacts,
  contextWriteRefusal,
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
  test('refuses each kind over its character limit', () => {
    for (const [kind, limit] of Object.entries(CONTEXT_ITEM_MAX_CHARS)) {
      const ruling = kind === 'ruling' ? { source: 'q5282' } : {}
      const refusal = contextWriteRefusal(
        item({ ...ruling, kind: kind as ContextItem['kind'], body: 'x'.repeat(limit + 1) }),
        facts(),
      )
      expect(refusal).toContain(`${limit}`)
      if (kind === 'ruling') {
        expect(refusal).toContain('Shorten it and put detail in a task document.')
      } else {
        expect(refusal).toContain(`${kind} limit is ${limit} characters`)
      }
    }
  })
  test('applies declared line rules to matching agent context kinds', () => {
    expect(
      contextWriteRefusal(
        item({ kind: 'ruling', source: 'q5282', body: 'first\n\nsecond' }),
        facts(),
      ),
    ).toBe(
      'context item state refused: ruling must be one paragraph with no blank line. Shorten it and put detail in a task document.',
    )
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
    expect(contextWriteRefusal(item({ kind: 'ruling', source: 'q5282', body: ' ' }), facts())).toBe(
      'context item state refused: a ruling requires a non-empty body',
    )
  })
  test('refuses an unresolved or unsafe pointer with the adapter reason', () => {
    expect(
      contextWriteRefusal(
        item({ kind: 'pointer' }),
        facts({ pointerRefusal: 'scratch paths are not durable pointers' }),
      ),
    ).toContain('scratch paths are not durable pointers')
  })
  test('accepts a ref pointer resolved to its commit and refuses a target from another body', () => {
    const sha = '2d7cac9ac9d18264c6539f3405834f5a42da06f7'
    const pointer = (body: string, target: string) =>
      contextWriteRefusal(item({ kind: 'pointer', body, target }), facts())
    expect(pointer('origin/main', sha)).toBeNull()
    expect(pointer('2d7cac9', sha)).toBeNull()
    expect(pointer('#2005', '2005')).toBeNull()
    expect(pointer('origin/main', 'origin/other')).toContain('target does not match')
    expect(pointer('4044458d5', sha)).toContain('target does not match the resolved commit')
    expect(pointer('#2005', '2006')).toContain('target does not match')
  })
  test('refuses task-level rulings on a claimed session', () => {
    expect(
      contextWriteRefusal(
        item({ holder: 'session:s', kind: 'ruling', source: 'q5282' }),
        facts({ profile: 'session', claimedTask: 'DEV-1844' }),
      ),
    ).toContain(`${PLATFORM_SLUG} agent context set --task DEV-1844`)
  })
  test('allows session rulings when there is no live task claim', () => {
    expect(
      contextWriteRefusal(
        item({ holder: 'session:s', kind: 'ruling', source: 'q5282' }),
        facts({ profile: 'session' }),
      ),
    ).toBeNull()
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
