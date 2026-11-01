import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { setMachineValue, writeMachineNames } from '../../../shared/machine-config.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { parseRunIdentifier, resolveRunIdentifier } from './run-identifier.ts'
import { classifyRunIdentifier as classifyGrammar } from './run-identifier-grammar.ts'

let configRoot: string
let previousConfigRoot: string | undefined

beforeEach(() => {
  previousConfigRoot = process.env[CONFIG_HOME_ENV]
  configRoot = mkdtempSync(join(tmpdir(), 'run-identifier-machine-'))
  process.env[CONFIG_HOME_ENV] = configRoot
})

afterEach(() => {
  if (previousConfigRoot === undefined) delete process.env[CONFIG_HOME_ENV]
  else process.env[CONFIG_HOME_ENV] = previousConfigRoot
  rmSync(configRoot, { recursive: true, force: true })
})

describe('run identifier', () => {
  test('a slash-named branch is not classified as this machine run identifier', () => {
    expect(
      classifyGrammar('release/1.2', { shortName: 'mine', formerShortNames: ['old-mine'] }),
    ).toBeNull()
  })

  test('a foreign label refuses in the resolver before any database query', () => {
    writeMachineNames({ shortName: 'mine', displayName: 'Mine' })
    let queries = 0
    const database = {
      query() {
        queries += 1
        throw new Error('query must not run')
      },
    } as unknown as Database
    expect(() => resolveRunIdentifier(database, 'other/123')).toThrow(
      "acts only on this machine's (`mine`) rows",
    )
    expect(queries).toBe(0)
  })

  test('a label for a machine with only a short name parses as a local number', () => {
    setMachineValue('machine.short_name', 'mine')
    expect(parseRunIdentifier('mine/42')).toEqual({ kind: 'number', number: 42 })
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
