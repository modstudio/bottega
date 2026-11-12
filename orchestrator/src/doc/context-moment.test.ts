import { describe, expect, test } from 'bun:test'
import { contextMomentEffect, pullRequestMergeContextMomentEffect } from './context-moment.ts'

describe('context moment effect', () => {
  test('workflow await writes its open question', () => {
    expect(
      contextMomentEffect({
        moment: 'workflow-await',
        taskKey: 'DEV-2267',
        questionId: 12,
        text: 'Which shape?',
      }),
    ).toEqual({
      writes: [{ kind: 'open-question', id: 'open-q12', source: 'q12', body: 'Which shape?' }],
      drops: [],
    })
  })

  test.each(['workflow-rule', 'question-answer'] as const)(
    '%s distinguishes operator rulings from positions and drops the question',
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
        drops: [{ kind: 'open-question', id: 'open-q12' }],
      })
      expect(effect(false).writes[0]).toMatchObject({ kind: 'position', id: 'position-q12' })
    },
  )

  test('workflow next writes its served step and self-ruling position', () => {
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
          kind: 'next-action',
          id: 'next',
          source: 'workflow-next',
          body: 'change cursor 4 at review: Review the change',
        },
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

  test('workflow next records a finished cursor', () => {
    expect(
      contextMomentEffect({
        moment: 'workflow-next',
        taskKey: 'DEV-2267',
        cursor: { workflow: 'change', number: 4, finished: true },
      }).writes[0]?.body,
    ).toBe('change cursor 4 finished')
  })

  test('a moment without a task key has no effect', () => {
    expect(
      contextMomentEffect({ moment: 'workflow-await', questionId: 12, text: 'Which shape?' }),
    ).toEqual({ writes: [], drops: [] })
  })
  test.each([0, 22])('a landed exit %i revises next and drops only open questions', (exitCode) => {
    expect(
      pullRequestMergeContextMomentEffect({
        exitCode,
        pullRequestNumber: 314,
        mergeCommit: '0123456789abcdef',
        items: [
          { id: 'open-q1', kind: 'open-question' },
          { id: 'ruling-q1', kind: 'ruling' },
          { id: 'position-q2', kind: 'position' },
          { id: 'open-q2', kind: 'open-question' },
        ],
      }),
    ).toEqual({
      writes: [
        {
          kind: 'next-action',
          id: 'next',
          source: 'pr-merge',
          body: 'PR 314 landed as 0123456789ab.',
        },
      ],
      drops: [
        { kind: 'open-question', id: 'open-q1' },
        { kind: 'open-question', id: 'open-q2' },
      ],
    })
  })

  test('a non-landed exit has no effect', () => {
    expect(
      pullRequestMergeContextMomentEffect({
        exitCode: 1,
        pullRequestNumber: 314,
        mergeCommit: '0123456789abcdef',
        items: [{ id: 'open-q1', kind: 'open-question' }],
      }),
    ).toEqual({ writes: [], drops: [] })
  })
})
