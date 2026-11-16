import { describe, expect, test } from 'bun:test'
import { SELF_RULING_MAX_CHARS } from '../../../shared/record-shape.ts'
import { contextMomentEffect } from './context-moment.ts'
import { contextItemShapeRefusal } from './doc-context-write.ts'

describe('context moment effect', () => {
  test('a position obeys the self-ruling record shape', () => {
    expect(
      contextItemShapeRefusal({
        holder: 'task:DEV-2345',
        id: 'position-q12',
        kind: 'position',
        source: 'q12',
        body: 'first paragraph\n\nsecond paragraph',
      }),
    ).toBe(
      'context item position-q12 refused: self-ruling must be one paragraph with no blank line. Shorten it and put detail in a task document.',
    )

    expect(
      contextItemShapeRefusal({
        holder: 'task:DEV-2345',
        id: 'position-q12',
        kind: 'position',
        source: 'q12',
        body: 'x'.repeat(SELF_RULING_MAX_CHARS),
      }),
    ).toBeNull()
  })

  test('an operator-ruled answer writes a ruling', () => {
    expect(
      contextMomentEffect({
        holder: { kind: 'task', value: 'DEV-2267' },
        questionId: 12,
        operatorRuled: true,
        text: 'Use the approved shape.',
      }),
    ).toEqual({
      writes: [
        expect.objectContaining({
          holder: { kind: 'task', value: 'DEV-2267' },
          kind: 'ruling',
          id: 'ruling-q12',
          source: 'q12',
          body: 'Use the approved shape.',
        }),
      ],
      reports: [],
    })
  })

  test('an answer not ruled by the operator writes a position', () => {
    expect(
      contextMomentEffect({
        holder: { kind: 'task', value: 'DEV-2267' },
        questionId: 13,
        text: 'The specification settles this.',
      }),
    ).toEqual({
      writes: [
        expect.objectContaining({
          holder: { kind: 'task', value: 'DEV-2267' },
          kind: 'position',
          id: 'position-q13',
          source: 'q13',
          body: 'The specification settles this.',
        }),
      ],
      reports: [],
    })
  })

  test('a missing holder reports the question while missing content does nothing', () => {
    expect(contextMomentEffect({ holder: null, questionId: 12, text: 'Which shape?' })).toEqual({
      writes: [],
      reports: ['context: did not write q12: no task or cursor context holder'],
    })
    expect(
      contextMomentEffect({ holder: { kind: 'task', value: 'DEV-2267' }, text: 'Which shape?' }),
    ).toEqual({ writes: [], reports: [] })
    expect(
      contextMomentEffect({ holder: { kind: 'task', value: 'DEV-2267' }, questionId: 12 }),
    ).toEqual({ writes: [], reports: [] })
  })
})
