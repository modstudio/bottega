import { describe, expect, test } from 'bun:test'
import { contextMomentEffect } from './context-moment.ts'

describe('context moment effect', () => {
  test('workflow await stores no context item', () => {
    expect(
      contextMomentEffect({
        moment: 'workflow-await',
        taskKey: 'DEV-2267',
        questionId: 12,
        text: 'Which shape?',
      }),
    ).toEqual({ writes: [], drops: [] })
  })

  test.each(['workflow-rule', 'question-answer'] as const)(
    '%s distinguishes operator rulings from positions',
    (moment) => {
      const effect = (operatorRuled: boolean) =>
        contextMomentEffect({
          moment,
          taskKey: 'DEV-2267',
          questionId: 12,
          operatorRuled,
          text: 'Use the approved shape.',
        })
      expect(effect(true)).toEqual({
        writes: [
          { kind: 'ruling', id: 'ruling-q12', source: 'q12', body: 'Use the approved shape.' },
        ],
        drops: [],
      })
      expect(effect(false).writes[0]).toMatchObject({ kind: 'position', id: 'position-q12' })
    },
  )

  test('workflow next writes only its self-ruling position', () => {
    expect(
      contextMomentEffect({
        moment: 'workflow-next',
        taskKey: 'DEV-2267',
        questionId: 13,
        text: 'The specification settles this.',
        cursor: {
          workflow: 'change',
          number: 4,
          stepSlug: 'review',
          stepTitle: 'Review the change',
        },
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
      drops: [],
    })
  })

  test('workflow next without a self-ruling stores nothing', () => {
    expect(
      contextMomentEffect({
        moment: 'workflow-next',
        taskKey: 'DEV-2267',
        cursor: { workflow: 'change', number: 4, finished: true },
      }),
    ).toEqual({ writes: [], drops: [] })
  })

  test('a moment without a task key has no effect', () => {
    expect(
      contextMomentEffect({ moment: 'workflow-await', questionId: 12, text: 'Which shape?' }),
    ).toEqual({ writes: [], drops: [] })
  })
})
