import { expect, test } from 'bun:test'
import { type CategoryExecutionRow, newestCategoryExecutions } from './enforcement-records.ts'

const row = (overrides: Partial<CategoryExecutionRow> = {}): CategoryExecutionRow => ({
  category: 'file-length',
  wallMs: 10,
  remaining: 4,
  finishedAt: '2026-10-12T10:00:00.000Z',
  gateId: 1,
  gateExitCode: 0,
  headCommit: 'a'.repeat(40),
  cwd: '/work/project',
  ...overrides,
})

test('category records prefer the newest eligible passing project gate', () => {
  const selected = newestCategoryExecutions(
    [
      row(),
      row({ gateId: 2, finishedAt: '2026-10-12T11:00:00.000Z', wallMs: 20 }),
      row({ gateId: 3, finishedAt: '2026-10-12T12:00:00.000Z', gateExitCode: 1 }),
      row({ gateId: 4, finishedAt: '2026-10-12T13:00:00.000Z', headCommit: null }),
      row({ gateId: 5, finishedAt: '2026-10-12T14:00:00.000Z', cwd: '/work/other' }),
    ],
    '/work/project',
  )
  expect(selected.get('file-length')).toEqual({
    wallMs: 20,
    remaining: 4,
    finishedAt: '2026-10-12T11:00:00.000Z',
  })
})
