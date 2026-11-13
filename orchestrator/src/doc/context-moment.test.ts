import { describe, expect, test } from 'bun:test'
import { contextMomentEffect } from './context-moment.ts'

describe('context moment effect', () => {
  test('an operator-ruled answer writes a ruling', () => {
    expect(
      contextMomentEffect({
        taskKey: 'DEV-2267',
        questionId: 12,
        operatorRuled: true,
        text: 'Use the approved shape.',
      }),
    ).toEqual({
      writes: [
        {
          kind: 'ruling',
          id: 'ruling-q12',
          source: 'q12',
          body: 'Use the approved shape.',
        },
      ],
    })
  })

  test('an answer not ruled by the operator writes a position', () => {
    expect(
      contextMomentEffect({
        taskKey: 'DEV-2267',
        questionId: 13,
        text: 'The specification settles this.',
      }),
    ).toEqual({
      writes: [
        {
          kind: 'position',
          id: 'position-q13',
          source: 'q13',
          body: 'The specification settles this.',
        },
      ],
    })
  })

  test('no task key, question id or text writes nothing', () => {
    expect(contextMomentEffect({ questionId: 12, text: 'Which shape?' })).toEqual({ writes: [] })
    expect(contextMomentEffect({ taskKey: 'DEV-2267', text: 'Which shape?' })).toEqual({
      writes: [],
    })
    expect(contextMomentEffect({ taskKey: 'DEV-2267', questionId: 12 })).toEqual({ writes: [] })
  })
})
