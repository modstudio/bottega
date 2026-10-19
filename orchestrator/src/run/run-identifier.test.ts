import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { parseRunIdentifier, resolveRunIdentifier } from './run-identifier.ts'

describe('run identifier', () => {
  test('parses a number and a full UUID without accepting lookalikes', () => {
    const uuid = newRecordId()
    expect(parseRunIdentifier('42')).toEqual({ kind: 'number', number: 42 })
    expect(parseRunIdentifier(uuid)).toEqual({ kind: 'record-id', recordId: uuid })
    expect(parseRunIdentifier(uuid.toUpperCase())).toEqual({ kind: 'record-id', recordId: uuid })
    for (const invalid of ['', '-1', '42junk', uuid.slice(0, 12)]) {
      expect(() => parseRunIdentifier(invalid)).toThrow(String(invalid))
    }
  })

  test('resolves the UUID to the same row as its number and refuses an unknown UUID', () => {
    const recordId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    const { number } = db()
      .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
      .get(recordId)!
    expect(resolveRunIdentifier(db(), number)).toBe(recordId)
    expect(resolveRunIdentifier(db(), recordId.toUpperCase())).toBe(recordId)
    const unknown = newRecordId()
    expect(() => resolveRunIdentifier(db(), unknown)).toThrow(
      `no run matches ${JSON.stringify(unknown)}; pass a positive decimal run number or a full run UUID`,
    )
  })
})
