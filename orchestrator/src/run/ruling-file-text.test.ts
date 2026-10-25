import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { lintProse } from '../canon/prose-lint.ts'
import {
  operatorAttributedRuling,
  renderCanonProposalNote,
  renderRulingFileText,
  rulingDocSlug,
  rulingFileHint,
  rulingFileOfferLines,
  shortRulingTitle,
} from './ruling-file-text.ts'

const filed = renderRulingFileText({
  question: 'Which shape should DEV-963 take?',
  ruling: 'Keep the existing 2 variants.',
  answerer: 'operator via owner-session',
  answererName: 'Ada Lovelace',
  runId: '42',
  runRecordId: '42000000-0000-4000-8000-000000000000',
  taskKey: 'DEV-963',
  date: '2026-09-25T12:00:00.000Z',
  questionId: 7,
  questionRecordId: '70000000-0000-4000-8000-000000000000',
})

describe('filed ruling text', () => {
  test('renders the question and ruling as YAML literal blocks with a lint-clean body', () => {
    expect(filed).toBe(
      [
        '---',
        'question_id: 70000000-0000-4000-8000-000000000000',
        'question_number: 7',
        'run: 42000000-0000-4000-8000-000000000000',
        'run_number: 42',
        'task: DEV-963',
        'date: 2026-09-25T12:00:00.000Z',
        'answerer: operator via owner-session',
        'answerer_name: Ada Lovelace',
        'question: |',
        '  Which shape should DEV-963 take?',
        'ruling: |',
        '  Keep the existing 2 variants.',
        '---',
        '',
        'The recorded ruling is filed for demand delivery.',
      ].join('\n'),
    )
    expect(lintProse(filed)).toEqual([])
  })

  test('renders a self-ruling basis beside the ruling', () => {
    expect(
      renderRulingFileText({
        question: 'Which shape?',
        ruling: 'Keep it.',
        basis: 'specification line 4',
        answerer: 'agent-session',
        answererName: null,
        runId: null,
        runRecordId: null,
        workflow: { slug: 'flow', mode: 'default', cursorId: 3 },
        taskKey: 'DEV-1294',
        date: '2026-10-13T12:00:00.000Z',
        questionId: 8,
        questionRecordId: '80000000-0000-4000-8000-000000000000',
      }),
    ).toContain('ruling: |\n  Keep it.\nbasis: |\n  specification line 4')
  })

  test('prefixes a canon proposal and collapses it to one line', () => {
    expect(renderCanonProposalNote('Question: Which?\nRuling: This.')).toBe(
      'Canon proposal: Question: Which? / Ruling: This.',
    )
  })

  test('shortens a title from the first line of the question', () => {
    expect(shortRulingTitle('Which shape?\nMore context.')).toBe('Which shape?')
    expect(shortRulingTitle(` ${'a'.repeat(90)} `).endsWith('...')).toBe(true)
    expect(shortRulingTitle('   ')).toBe('Ruling')
  })

  test('builds a unique lowercase slug that stays within the doc slug budget', () => {
    expect(rulingDocSlug('Which shape?', 7)).toBe('which-shape-q7')
    expect(rulingDocSlug('???', 7)).toBe('ruling-q7')
    expect(rulingDocSlug('A'.repeat(80), 99).length).toBeLessThanOrEqual(64)
  })
})

describe('operator file-offer hint', () => {
  test('names the file verb for operator-attributed rulings only', () => {
    expect(rulingFileHint(7)).toBe(
      `File this ruling: ${PLATFORM_SLUG} question ruling file 7 --as doc|canon`,
    )
    expect(
      rulingFileOfferLines({ questionIds: [7, 8], operatorAttributed: true, json: false }),
    ).toEqual([
      `File this ruling: ${PLATFORM_SLUG} question ruling file 7 --as doc|canon`,
      `File this ruling: ${PLATFORM_SLUG} question ruling file 8 --as doc|canon`,
    ])
    expect(
      rulingFileOfferLines({ questionIds: [7], operatorAttributed: false, json: false }),
    ).toEqual([])
    expect(
      rulingFileOfferLines({ questionIds: [7], operatorAttributed: true, json: true }),
    ).toEqual([])
  })

  test('treats --from-operator or the ui channel as operator attribution', () => {
    expect(operatorAttributedRuling({ fromOperator: true })).toBe(true)
    expect(operatorAttributedRuling({ fromOperator: false, channel: 'ui' })).toBe(true)
    expect(operatorAttributedRuling({ fromOperator: false, channel: 'cli' })).toBe(false)
    expect(operatorAttributedRuling({ fromOperator: false, channel: 'mcp' })).toBe(false)
  })
})
