import { describe, expect, test } from 'bun:test'
import { renderTaskRulings, selectTaskRulings, type TaskRulingRow } from './task-rulings.ts'

const row = (overrides: Partial<TaskRulingRow> = {}): TaskRulingRow => ({
  question_id: 1,
  run_id: 10,
  project: 'bottega',
  launch_key: 'DEV-960',
  question: 'Which way?',
  answer: 'Use the settled way.',
  answered_at: '2026-09-20T12:00:00.000Z',
  answerer_kind: 'agent',
  overturned_at: null,
  replacement: null,
  ...overrides,
})

describe('task ruling carry', () => {
  test('selects newest first and excludes another task or project', () => {
    const selected = selectTaskRulings(
      [
        row({ question_id: 1, answered_at: '2026-09-20T12:00:00.000Z' }),
        row({ question_id: 2, answered_at: '2026-09-22T12:00:00.000Z' }),
        row({ question_id: 3, launch_key: 'DEV-OTHER' }),
        row({ question_id: 4, project: 'other' }),
      ],
      'bottega',
      'DEV-960',
    )
    expect(selected.rulings.map((ruling) => ruling.questionId)).toEqual([2, 1])
  })

  test('excludes overturned rulings and substitutes replacements', () => {
    const selected = selectTaskRulings(
      [
        row({ question_id: 1, overturned_at: '2026-09-23T12:00:00.000Z' }),
        row({
          question_id: 2,
          answerer_kind: 'operator',
          overturned_at: '2026-09-24T12:00:00.000Z',
          replacement: 'Use the replacement.',
        }),
      ],
      'bottega',
      'DEV-960',
    )
    expect(selected.rulings).toHaveLength(1)
    expect(renderTaskRulings(selected)).toContain(
      'Ruling (replaces an overturned ruling): Use the replacement.',
    )
    expect(renderTaskRulings(selected)).toContain('Ruled by: operator')
  })

  test('enforces the count cap and reports omitted oldest rulings', () => {
    const selected = selectTaskRulings(
      [
        row({ question_id: 1, answered_at: '2026-09-20T12:00:00.000Z' }),
        row({ question_id: 2, answered_at: '2026-09-21T12:00:00.000Z' }),
        row({ question_id: 3, answered_at: '2026-09-22T12:00:00.000Z' }),
      ],
      'bottega',
      'DEV-960',
      { count: 2 },
    )
    expect(selected.rulings.map((ruling) => ruling.questionId)).toEqual([3, 2])
    expect(renderTaskRulings(selected)).toContain('1 older rulings omitted')
  })

  test('enforces the byte cap by dropping the oldest', () => {
    const rows = [
      row({ question_id: 1, answered_at: '2026-09-20T12:00:00.000Z' }),
      row({ question_id: 2, answered_at: '2026-09-21T12:00:00.000Z' }),
    ]
    const one = selectTaskRulings(rows.slice(1), 'bottega', 'DEV-960')
    const bytes = Buffer.byteLength(renderTaskRulings(one), 'utf8') + 30
    const selected = selectTaskRulings(rows, 'bottega', 'DEV-960', { bytes })
    expect(selected.rulings.map((ruling) => ruling.questionId)).toEqual([2])
    expect(Buffer.byteLength(renderTaskRulings(selected), 'utf8')).toBeLessThanOrEqual(bytes)
    expect(selected.omitted).toBe(1)
  })

  test('renders no section when there are no rulings', () => {
    expect(renderTaskRulings(selectTaskRulings([], 'bottega', 'DEV-960'))).toBe('')
  })
})
