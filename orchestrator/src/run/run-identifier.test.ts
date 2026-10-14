import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { parseRunIdentifier, resolveRunIdentifier } from './run-identifier.ts'

describe('run identifier', () => {
  test('parses a number and a full UUID without accepting lookalikes', () => {
    const uuid = newRecordId()
    expect(parseRunIdentifier('42')).toEqual({ kind: 'number', id: 42 })
    expect(parseRunIdentifier(uuid)).toEqual({ kind: 'record-id', recordId: uuid })
    expect(parseRunIdentifier(uuid.toUpperCase())).toEqual({ kind: 'record-id', recordId: uuid })
    for (const invalid of ['', '-1', '42junk', uuid.slice(0, 12)]) {
      expect(() => parseRunIdentifier(invalid)).toThrow(String(invalid))
    }
  })

  test('resolves the UUID to the same row as its number and refuses an unknown UUID', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    const { record_id: recordId } = db()
      .query<{ record_id: string }, [number]>('SELECT record_id FROM run WHERE id=?')
      .get(id)!
    expect(resolveRunIdentifier(db(), id)).toBe(id)
    expect(resolveRunIdentifier(db(), recordId.toUpperCase())).toBe(id)
    const unknown = newRecordId()
    expect(() => resolveRunIdentifier(db(), unknown)).toThrow(
      `no run has UUID ${JSON.stringify(unknown)}; pass a positive decimal run number or a full run UUID`,
    )
  })
})
