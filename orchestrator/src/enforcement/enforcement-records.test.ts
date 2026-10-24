import { expect, test } from 'bun:test'
import {
  type CategoryExecutionRow,
  newestCategoryExecutions,
  refilledCategoryExecutions,
} from './enforcement-records.ts'

const row = (overrides: Partial<CategoryExecutionRow> = {}): CategoryExecutionRow => ({
  category: 'file-length',
  wallMs: 10,
  remaining: 4,
  finishedAt: '2026-10-12T10:00:00.000Z',
  gateRecordId: '1',
  gateExitCode: 0,
  headCommit: 'a'.repeat(40),
  cwd: '/work/project',
  ...overrides,
})

test('category records prefer the newest eligible passing project gate', () => {
  const selected = newestCategoryExecutions(
    [
      row(),
      row({ gateRecordId: '2', finishedAt: '2026-10-12T11:00:00.000Z', wallMs: 20 }),
      row({ gateRecordId: '3', finishedAt: '2026-10-12T12:00:00.000Z', gateExitCode: 1 }),
      row({ gateRecordId: '4', finishedAt: '2026-10-12T13:00:00.000Z', headCommit: null }),
      row({ gateRecordId: '5', finishedAt: '2026-10-12T14:00:00.000Z', cwd: '/work/other' }),
    ],
    '/work/project',
  )
  expect(selected.get('file-length')).toEqual({
    wallMs: 20,
    remaining: 4,
    finishedAt: '2026-10-12T11:00:00.000Z',
  })
})

test('category recency breaks a shared finish timestamp by gate UUID', () => {
  const selected = newestCategoryExecutions(
    [
      row({ gateRecordId: '01990000-0000-7000-8000-000000000010', wallMs: 10 }),
      row({ gateRecordId: '01990000-0000-7000-8000-000000000020', wallMs: 20 }),
    ],
    '/work/project',
  )
  expect(selected.get('file-length')?.wallMs).toBe(20)
})

test('zero followed by a positive count reports the refill', () => {
  expect(
    refilledCategoryExecutions(
      [row({ remaining: 0 }), row({ gateRecordId: '2', finishedAt: '2026-10-12T11:00:00.000Z' })],
      '/work/project',
    ),
  ).toEqual([
    {
      category: 'file-length',
      remaining: 4,
      finishedAt: '2026-10-12T11:00:00.000Z',
      lastZeroFinishedAt: '2026-10-12T10:00:00.000Z',
    },
  ])
})

test.each([
  {
    name: 'positive then zero then zero',
    rows: [
      row(),
      row({ gateRecordId: '2', finishedAt: '2026-10-12T11:00:00.000Z', remaining: 0 }),
      row({ gateRecordId: '3', finishedAt: '2026-10-12T12:00:00.000Z', remaining: 0 }),
    ],
  },
  {
    name: 'never zero',
    rows: [row(), row({ gateRecordId: '2', finishedAt: '2026-10-12T11:00:00.000Z' })],
  },
  {
    name: 'zero then positive then zero',
    rows: [
      row({ remaining: 0 }),
      row({ gateRecordId: '2', finishedAt: '2026-10-12T11:00:00.000Z' }),
      row({ gateRecordId: '3', finishedAt: '2026-10-12T12:00:00.000Z', remaining: 0 }),
    ],
  },
])('$name does not report a refill', ({ rows }) => {
  expect(refilledCategoryExecutions(rows, '/work/project')).toEqual([])
})

test('a failed positive gate after zero is ignored', () => {
  expect(
    refilledCategoryExecutions(
      [row({ remaining: 0 }), row({ gateRecordId: '2', gateExitCode: 1 })],
      '/work/project',
    ),
  ).toEqual([])
})

test('another project rows are ignored', () => {
  expect(
    refilledCategoryExecutions(
      [row({ remaining: 0 }), row({ gateRecordId: '2', cwd: '/work/other' })],
      '/work/project',
    ),
  ).toEqual([])
})

test('categories are judged independently', () => {
  const result = refilledCategoryExecutions(
    [
      row({ category: 'file-length', remaining: 0 }),
      row({ category: 'dead-code', remaining: 3 }),
      row({
        category: 'file-length',
        gateRecordId: '2',
        finishedAt: '2026-10-12T11:00:00.000Z',
      }),
      row({
        category: 'dead-code',
        gateRecordId: '2',
        finishedAt: '2026-10-12T11:00:00.000Z',
        remaining: 0,
      }),
    ],
    '/work/project',
  )
  expect(result.map(({ category }) => category)).toEqual(['file-length'])
})
