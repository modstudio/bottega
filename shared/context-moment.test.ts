import { describe, expect, test } from 'bun:test'
import { CONTEXT_MOMENTS, contextMomentWrite, emitContextMoment } from './context-moment.ts'

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

test('emits moment prompts to trailing stdout for text and stderr for JSON', () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const output = {
    log: (line: string) => stdout.push(line),
    error: (line: string) => stderr.push(line),
  }
  const write = contextMomentWrite({ moment: 'run-start', taskKey: 'DEV-2225' })

  emitContextMoment(write, false, output)
  expect(stdout).toEqual([write!.line])
  expect(stderr).toEqual([])

  stdout.length = 0
  emitContextMoment(write, true, output)
  expect(stdout).toEqual([])
  expect(stderr).toEqual([write!.line])
})
