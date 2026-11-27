import { expect, test } from 'bun:test'
import { serializeNoteEvaluationRecordData } from './note-evaluation-record.ts'

test('record JSON escapes lint-sensitive text without changing its strings', () => {
  const data = {
    text: 'Use `hub/src/x.ts:12` and bun run missing-script.',
    nested: ['npm run another-missing-script', '```\n~~~'],
  }

  const serialized = serializeNoteEvaluationRecordData(data)

  expect(serialized).not.toContain('`')
  expect(serialized).not.toContain('bun run')
  expect(serialized).not.toContain('npm run')
  expect(serialized).toContain('\\u0060')
  expect(serialized).toContain('bun\\u0020run')
  expect(JSON.parse(serialized)).toEqual(data)
})
