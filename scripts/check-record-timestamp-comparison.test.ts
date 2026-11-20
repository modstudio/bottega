import { expect, test } from 'bun:test'
import { lintRecordTimestampSource } from './check-record-timestamp-comparison.ts'

test('record timestamp comparison guard refuses every raw form and permits unrelated equality', async () => {
  const refused = await lintRecordTimestampSource(
    [
      'const millis = value.getTime()',
      'const date = value instanceof Date',
      'const same = stored.updated_at === pushed.deleted_at',
    ].join('\n'),
    'hosted-push-eslint-fixture.ts',
  )
  expect(refused).toHaveLength(3)

  const permitted = await lintRecordTimestampSource(
    ['const absent = x.deleted_at === null', 'const same = stored.key === pushed.key'].join('\n'),
    'hosted-push-eslint-fixture.ts',
  )
  expect(permitted).toHaveLength(0)
})
