import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ESLint } from 'eslint'
import { RECORD_TIMESTAMP_FIELDS } from '../hub/src/push-contract.ts'
import {
  RECORD_TIMESTAMP_COMPARISON_REMEDY,
  RECORD_TIMESTAMP_GUARD_FIELDS,
  RECORD_TIMESTAMP_GUARD_SCOPE,
} from '../hub/src/record-timestamp-guard.ts'
import { selectRecordTimestampGuardFiles } from './check-record-timestamp-comparison.ts'

const ROOT = resolve(import.meta.dir, '..')

async function lintRecordTimestampSource(source: string) {
  const results = await new ESLint({ cwd: ROOT }).lintText(source, {
    filePath: resolve(ROOT, 'hub/src/hosted-push-eslint-fixture.ts'),
  })
  return results.flatMap((result) =>
    result.messages.filter(
      (message) =>
        message.ruleId === 'no-restricted-syntax' &&
        message.message === RECORD_TIMESTAMP_COMPARISON_REMEDY,
    ),
  )
}

test('record timestamp guard field roster matches the pushed-row contract', () => {
  expect([...RECORD_TIMESTAMP_GUARD_FIELDS].sort()).toEqual([...RECORD_TIMESTAMP_FIELDS].sort())
})

test('record timestamp guard refuses an empty file selection', () => {
  expect(() => selectRecordTimestampGuardFiles([])).toThrow(
    `No files matched record timestamp guard scope ${RECORD_TIMESTAMP_GUARD_SCOPE.files.join(', ')} excluding ${RECORD_TIMESTAMP_GUARD_SCOPE.ignores.join(', ')}`,
  )
})

test('record timestamp comparison guard refuses every raw form and permits unrelated equality', async () => {
  const refused = await lintRecordTimestampSource(
    [
      'const millis = value.getTime()',
      'const date = value instanceof Date',
      'const same = stored.updated_at === pushed.deleted_at',
    ].join('\n'),
  )
  expect(refused).toHaveLength(3)

  const permitted = await lintRecordTimestampSource(
    ['const absent = x.deleted_at === null', 'const same = stored.key === pushed.key'].join('\n'),
  )
  expect(permitted).toHaveLength(0)
})
