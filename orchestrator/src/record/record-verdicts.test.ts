import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { VOID_EXCLUSION_REASON } from '../verdict/verdict-rules.ts'
import { RecordVerdictError, supersedeRecordVoid } from './record-verdicts.ts'

test('hosted API unvoid refuses a void plus another exclusion without an update', async () => {
  const statements: string[] = []
  const tx = (async (parts: TemplateStringsArray) => {
    const source = parts.join('?')
    statements.push(source)
    if (source.includes('information_schema.columns')) {
      return [
        { column_name: 'superseded_at' },
        { column_name: 'superseded_by' },
        { column_name: 'supersede_note' },
      ]
    }
    if (source.includes('SELECT reason FROM run_exclusion')) {
      return [{ reason: VOID_EXCLUSION_REASON }]
    }
    if (source.includes('SELECT evidence_excluded FROM run')) {
      return [{ evidence_excluded: 'unjudged: owner gone' }]
    }
    return []
  }) as unknown as SQL

  try {
    await supersedeRecordVoid(tx, {
      id: '01990000-0000-7000-8000-000000000001',
      userId: '01990000-0000-7000-8000-000000000002',
      spaceId: '01990000-0000-7000-8000-000000000003',
      note: 'mistaken void',
    })
    throw new Error('expected hosted unvoid to refuse the mixed exclusion pair')
  } catch (error) {
    expect(error).toBeInstanceOf(RecordVerdictError)
    expect((error as RecordVerdictError).status).toBe(409)
    expect((error as Error).message).toContain(`active exclusion is '${VOID_EXCLUSION_REASON}'`)
    expect((error as Error).message).toContain("run evidence_excluded is 'unjudged: owner gone'")
  }
  expect(statements.some((statement) => statement.includes('UPDATE'))).toBe(false)
})
