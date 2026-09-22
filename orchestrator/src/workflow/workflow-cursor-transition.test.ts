import { describe, expect, test } from 'bun:test'
import { decideCursorTransition, type CursorValue } from './workflow-cursor-transition.ts'

const cursor = (ordinal: number, stepSlug: string, state: CursorValue['state'] = 'running') => ({
  ordinal,
  stepSlug,
  state,
})

describe('workflow cursor transition', () => {
  test('serves the current, next, and earlier steps without allowing a skip', () => {
    expect(decideCursorTransition(cursor(2, 'two'), { kind: 'serve', ordinal: 2, slug: 'two', expectedOrdinal: 2, expectedSlug: 'two' })).toMatchObject({ action: 'serve', move: false })
    expect(decideCursorTransition(cursor(2, 'two'), { kind: 'serve', ordinal: 3, slug: 'three', expectedOrdinal: 2, expectedSlug: 'two' })).toMatchObject({ action: 'serve', move: true, ordinal: 3 })
    expect(decideCursorTransition(cursor(2, 'two'), { kind: 'serve', ordinal: 1, slug: 'one', expectedOrdinal: 2, expectedSlug: 'two' })).toMatchObject({ action: 'serve', move: false })
    expect(decideCursorTransition(cursor(2, 'two'), { kind: 'serve', ordinal: 4, slug: 'four', expectedOrdinal: 2, expectedSlug: 'two' })).toEqual({ action: 'refuse', reason: 'ahead' })
  })

  test('requires compose before a later step but permits step one', () => {
    expect(decideCursorTransition(null, { kind: 'serve', ordinal: 1, slug: 'one', expectedOrdinal: 1, expectedSlug: 'one' }).action).toBe('serve')
    expect(decideCursorTransition(null, { kind: 'serve', ordinal: 2, slug: 'two', expectedOrdinal: 1, expectedSlug: 'one' })).toEqual({ action: 'refuse', reason: 'compose-first' })
  })

  test('finishes the last step, refuses done, and advances from awaiting-ruling', () => {
    expect(decideCursorTransition(cursor(3, 'three'), { kind: 'next', total: 3, nextSlug: null })).toEqual({ action: 'finish' })
    expect(decideCursorTransition(cursor(3, 'three', 'done'), { kind: 'next', total: 3, nextSlug: null })).toEqual({ action: 'refuse', reason: 'state' })
    expect(decideCursorTransition(cursor(2, 'two', 'awaiting-ruling'), { kind: 'next', total: 3, nextSlug: 'three' })).toMatchObject({ action: 'serve', ordinal: 3, slug: 'three' })
  })
})
