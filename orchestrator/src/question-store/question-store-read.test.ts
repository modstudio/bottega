import { expect, test } from 'bun:test'
import { questionByNumber, questionRulingsPaged } from './question-store-read.ts'
import type { QuestionStore } from './question-store-types.ts'

test('a question number repeated across record spaces refuses instead of picking one', () => {
  const personal = { record_id: 'personal', number: 12 }
  const project = { record_id: 'project', number: 12 }
  const other = { record_id: 'other', number: 13 }
  expect(() => questionByNumber([personal, project, other], 12)).toThrow(
    'names 2 questions on this cursor in different record spaces',
  )
  expect(questionByNumber([personal, other], 12)).toBe(personal)
  expect(questionByNumber([other], 12)).toBeNull()
  const withdrawn = { ...personal, closed_at: '2026-11-17T05:00:00Z', answered_at: null }
  expect(questionByNumber([withdrawn, project], 12)).toBe(project)
})

test('paged rulings keep the last row seen for each question id', async () => {
  const pages = [
    {
      items: [{ record_id: 'question-1', answer: 'first' }],
      cursor: 'page-2',
      more: true,
    },
    {
      items: [
        { record_id: 'question-1', answer: 'last' },
        { record_id: 'question-2', answer: 'only' },
      ],
      cursor: 'done',
      more: false,
    },
  ]
  const store = {
    read: async () => pages.shift()!,
  } as unknown as QuestionStore

  expect(await questionRulingsPaged(store, 'all')).toEqual([
    { record_id: 'question-1', answer: 'last' },
    { record_id: 'question-2', answer: 'only' },
  ])
})
