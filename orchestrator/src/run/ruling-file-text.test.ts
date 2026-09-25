import { describe, expect, test } from 'bun:test'
import { lintProse } from '../canon/prose-lint.ts'
import {
  filedDocRef,
  operatorAttributedRuling,
  parseFiledNoteId,
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
  answererKind: 'operator',
  runId: 42,
  taskKey: 'DEV-963',
  date: '2026-09-25T12:00:00.000Z',
  questionId: 7,
})

describe('filed ruling text', () => {
  test('renders the question and ruling as YAML literal blocks with a lint-clean body', () => {
    expect(filed).toBe(
      [
        '---',
        'question_id: 7',
        'run: 42',
        'task: DEV-963',
        'date: 2026-09-25T12:00:00.000Z',
        'answerer: operator',
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
    expect(rulingFileHint(7)).toBe('File this ruling: orch ruling file 7 --as doc|canon')
    expect(
      rulingFileOfferLines({ questionIds: [7, 8], operatorAttributed: true, json: false }),
    ).toEqual([
      'File this ruling: orch ruling file 7 --as doc|canon',
      'File this ruling: orch ruling file 8 --as doc|canon',
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

describe('filed refs', () => {
  test('joins a doc id and revision, and parses a hub note id', () => {
    expect(filedDocRef(12, 'rev-1')).toBe('12@rev-1')
    expect(filedDocRef(12, null)).toBe('12')
    expect(parseFiledNoteId('near 3 score 0.900  other\nnote 44 filed; 1 sighting\n')).toBe(44)
    expect(() => parseFiledNoteId('possible duplicate notes')).toThrow('did not report a note id')
  })
})
