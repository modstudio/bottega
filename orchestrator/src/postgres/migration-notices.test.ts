import { describe, expect, test } from 'bun:test'
import {
  migrateFailureText,
  REHEARSAL_NOTICE_LIMIT,
  renderRehearsalNoticeLines,
} from './migration-notices.ts'

describe('migrateFailureText', () => {
  test.each([
    [
      'removes notices before the error',
      'MIGRATE NOTICE -: schema "drizzle" already exists, skipping\nMIGRATE NOTICE fixture: moved rows\n\nmigration fixture statement 2: permission denied\n',
      'migration fixture statement 2: permission denied',
    ],
    [
      'removes notices interleaved with the error and preserves the error text',
      '\nerror first line\nMIGRATE NOTICE fixture: guarded branch refused\nerror second line\n\n',
      'error first line\nerror second line',
    ],
  ])('%s', (_name, input, expected) => {
    expect(migrateFailureText(input)).toBe(expected)
  })
})

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
    expect(renderRehearsalNoticeLines(input)).toEqual([...expected])
  })
})
