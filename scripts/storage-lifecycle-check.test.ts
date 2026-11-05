import { expect, test } from 'bun:test'
import type { TableLifecycle } from '../shared/storage-lifecycle.ts'
import { storageLifecycleRefusals } from './storage-lifecycle-check.ts'

const declaration: TableLifecycle = {
  store: 'hub',
  table: 'task',
  class: 'cache',
  keep: 'Kept for the read window.',
  remover: null,
  slice: 'working-set',
}
const tables = {
  orchestrator: [],
  hub: [{ name: 'task', columns: ['body'] }],
  hosted: [],
} as const
const resolves = (path: string, symbol: string) =>
  path === 'hub/src/task.ts' && symbol === 'removeTask'

test('an undeclared table is refused', async () => {
  expect(await storageLifecycleRefusals(tables, [], resolves)).toContain(
    'hub.task: lifecycle declaration is missing',
  )
})

test('a stale declaration is refused', async () => {
  expect(await storageLifecycleRefusals({ ...tables, hub: [] }, [declaration], resolves)).toContain(
    'hub.task: lifecycle declaration is stale',
  )
})

test('kept is refused outside record, bounded machine rows, and telemetry rollups', async () => {
  expect(
    await storageLifecycleRefusals(tables, [{ ...declaration, remover: 'kept' }], resolves),
  ).toContain(
    'hub.task: kept lifecycle marker is valid only for record, bounded machine rows, or telemetry rollups',
  )
})

test('a kept telemetry rollup must replace the raw telemetry keep rule', async () => {
  expect(
    await storageLifecycleRefusals(
      tables,
      [
        {
          ...declaration,
          class: 'telemetry',
          keep: 'Raw samples stay for the telemetry window, followed by daily rollups.',
          remover: 'kept',
        },
      ],
      resolves,
    ),
  ).toContain('hub.task: kept telemetry rollup must declare its own keep rule')
})

test('a kept telemetry rollup with an explicit growth rule is accepted', async () => {
  expect(
    await storageLifecycleRefusals(
      tables,
      [
        {
          ...declaration,
          class: 'telemetry',
          keep: 'The daily rollup is kept indefinitely and grows by one row per day.',
          remover: 'kept',
        },
      ],
      resolves,
    ),
  ).toEqual([])
})

test('a duplicated declaration is refused', async () => {
  expect(await storageLifecycleRefusals(tables, [declaration, declaration], resolves)).toContain(
    'hub.task: lifecycle declaration is duplicated',
  )
})

test('an empty keep rule is refused', async () => {
  expect(
    await storageLifecycleRefusals(tables, [{ ...declaration, keep: ' ' }], resolves),
  ).toContain('hub.task: lifecycle keep rule is empty')
})

test('a payload column absent from its table is refused', async () => {
  expect(
    await storageLifecycleRefusals(
      tables,
      [{ ...declaration, payloadColumns: [{ column: 'missing', keep: 'hot window' }] }],
      resolves,
    ),
  ).toContain('hub.task.missing: lifecycle payload column does not exist')
})

test('an unresolved remover is refused', async () => {
  expect(
    await storageLifecycleRefusals(
      tables,
      [{ ...declaration, remover: 'hub/src/task.ts#missing', slice: undefined }],
      resolves,
    ),
  ).toContain('hub.task: lifecycle remover hub/src/task.ts#missing does not resolve')
})

test('a null remover without a slice is refused', async () => {
  expect(
    await storageLifecycleRefusals(tables, [{ ...declaration, slice: undefined }], resolves),
  ).toContain('hub.task: null lifecycle remover must name its owing slice')
})
