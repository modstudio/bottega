import { describe, expect, test } from 'bun:test'
import { REHEARSAL_NOTICE_LIMIT, renderRehearsalNoticeLines } from './migration-notices.ts'

describe('renderRehearsalNoticeLines', () => {
  test.each([
    ['no notices', '', []],
    ['non-notice lines ignored', 'migration output\nNOTICE ignored', []],
    [
      'exactly the limit without truncation',
      Array.from(
        { length: REHEARSAL_NOTICE_LIMIT },
        (_, index) => `MIGRATE NOTICE fixture_${index}: message`,
      ).join('\n'),
      Array.from(
        { length: REHEARSAL_NOTICE_LIMIT },
        (_, index) => `REHEARSAL NOTICE MIGRATE NOTICE fixture_${index}: message`,
      ),
    ],
    [
      'limit plus three with truncation',
      Array.from(
        { length: REHEARSAL_NOTICE_LIMIT + 3 },
        (_, index) => `MIGRATE NOTICE fixture_${index}: message`,
      ).join('\n'),
      [
        ...Array.from(
          { length: REHEARSAL_NOTICE_LIMIT },
          (_, index) => `REHEARSAL NOTICE MIGRATE NOTICE fixture_${index}: message`,
        ),
        'REHEARSAL NOTICE-TRUNCATED 3',
      ],
    ],
    [
      'order kept',
      'MIGRATE NOTICE third: c\nnoise\nMIGRATE NOTICE first: a\nMIGRATE NOTICE second: b',
      [
        'REHEARSAL NOTICE MIGRATE NOTICE third: c',
        'REHEARSAL NOTICE MIGRATE NOTICE first: a',
        'REHEARSAL NOTICE MIGRATE NOTICE second: b',
      ],
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(renderRehearsalNoticeLines(input)).toEqual(expected)
  })
})
