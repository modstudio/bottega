import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ESLint } from 'eslint'

const ROOT = resolve(import.meta.dir, '..')
const REMEDY = 'Compare record timestamps with sameRecordInstant from shared/record-timestamp.ts.'

async function lintRecordTimestampSource(source: string) {
  const results = await new ESLint({ cwd: ROOT }).lintText(source, {
    filePath: resolve(ROOT, 'hub/src/hosted-push-eslint-fixture.ts'),
  })
  return results.flatMap((result) =>
    result.messages.filter(
      (message) => message.ruleId === 'no-restricted-syntax' && message.message === REMEDY,
    ),
  )
}

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
