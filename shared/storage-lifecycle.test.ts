import { expect, test } from 'bun:test'
import type { TableLifecycle } from './storage-lifecycle.ts'
import { joinStorageMeasurements } from './storage-lifecycle.ts'

const declarations: TableLifecycle[] = [
  {
    store: 'hub',
    table: 'task',
    class: 'cache',
    keep: 'window',
    remover: null,
    slice: 'working-set',
  },
  { store: 'hosted', table: 'run', class: 'record', keep: 'forever', remover: 'kept' },
]

test('joins measurements to declarations and groups owed removers by slice', () => {
  const report = joinStorageMeasurements(declarations, [
    { store: 'hub', table: 'task', bytes: 12, rows: 2 },
    { store: 'hosted', table: 'run', bytes: 30, rows: 1 },
  ])
  expect(report.tables.find((table) => table.table === 'task')).toMatchObject({
    table: 'task',
    class: 'cache',
    slice: 'working-set',
  })
  expect(report.findings).toEqual([
    { slice: 'working-set', tables: [{ store: 'hub', table: 'task', bytes: 12 }] },
  ])
  expect(report.kept).toEqual([{ store: 'hosted', table: 'run', bytes: 30 }])
})

test('a measurement without a declaration is carried as undeclared', () => {
  expect(
    joinStorageMeasurements([], [{ store: 'hub', table: 'missing', bytes: 1, rows: 1 }]).undeclared,
  ).toEqual([{ store: 'hub', table: 'missing', bytes: 1 }])
})

test('a missing hosted section carries its reason instead of becoming an empty list', () => {
  expect(
    joinStorageMeasurements([], [], [{ store: 'hosted', reason: 'unreachable' }]).missing,
  ).toEqual([{ store: 'hosted', reason: 'unreachable' }])
})
