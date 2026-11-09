import { describe, expect, test } from 'bun:test'
import { CONTEXT_MOMENTS, contextMomentWrite } from './context-moment.ts'

describe('context moment write', () => {
  const expected = {
    'workflow-next': 'next-action',
    'workflow-rule': 'ruling',
    'workflow-await': 'open-question',
    'question-answer': 'ruling',
    'run-start': 'next-action',
    'pr-merge': 'next-action',
    'task-close': 'next-action',
  } as const

  for (const moment of CONTEXT_MOMENTS) {
    test(`${moment} maps to its task holder and kind`, () => {
      const write = contextMomentWrite({ moment, taskKey: 'DEV-2225', questionId: 5288 })
      expect(write).toMatchObject({ holder: 'DEV-2225', kind: expected[moment] })
      expect(write?.line).toEndWith(`(${write?.command})`)
    })
  }

  test('a moment without a task key has no prompt', () => {
    expect(contextMomentWrite({ moment: 'run-start' })).toBeNull()
  })

  test('question moments carry the durable question source', () => {
    expect(
      contextMomentWrite({ moment: 'workflow-await', taskKey: 'DEV-2225', questionId: 5288 })
        ?.command,
    ).toContain("--source 'q5288'")
  })
})
