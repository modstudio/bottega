import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { parseRunIdentifier, resolveRunIdentifier } from './run-identifier.ts'
import { parseRunIdentifier as parseGrammar } from './run-identifier-grammar.ts'

describe('run identifier', () => {
  test('parses current and former machine labels and refuses foreign labels before lookup', () => {
    const names = { shortName: 'mine', formerShortNames: ['old-mine'] }
    expect(parseGrammar('mine/42', names)).toEqual(parseGrammar('42', names))
    expect(parseGrammar('old-mine/42', names)).toEqual({ kind: 'number', number: 42 })
    expect(() => parseGrammar('other/123', names)).toThrow(
      "`other/123` names a row on machine `other`; this command acts only on this machine's (`mine`) rows",
    )
    expect(() => parseGrammar('mine/42', null)).toThrow(
      'has no short name because it has not joined a space',
    )
    expect(() => parseGrammar('Bad/42', names)).toThrow('invalid run identifier')
  })
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
      `no run matches ${JSON.stringify(unknown)}; pass a positive decimal run number, name/number, or a full run UUID`,
    )
  })
})
