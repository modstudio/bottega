import { expect, test } from 'bun:test'
import { ORCHESTRATOR_DATABASE_ENV } from '../../../shared/state-directory.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { recordLocalCommand } from './record-local-command.ts'
import { readRecordLocalByDesign } from './record-local-mark.ts'

test('record local sets and clears the store mark', () => {
  const database = migratedTestDatabase()
  const output: string[] = []
  try {
    recordLocalCommand(true, { log: (value) => output.push(value) }, database)
    expect(readRecordLocalByDesign(database)).toBe(true)
    recordLocalCommand(false, { log: (value) => output.push(value) }, database)
    expect(readRecordLocalByDesign(database)).toBe(false)
    expect(output).toEqual([
      'this store is local by design',
      'this store is no longer local by design',
    ])
  } finally {
    database.close()
  }
})

test('record local refuses to mark a bound store and names an unbound store remedy', () => {
  const database = migratedTestDatabase()
  try {
    database
      .query(
        "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,'at','https://api.example.test')",
      )
      .run()
    expect(() => recordLocalCommand(true, { log: () => undefined }, database)).toThrow(
      `cleared by: point ${ORCHESTRATOR_DATABASE_ENV} at an unbound store, then rerun record local`,
    )
    expect(readRecordLocalByDesign(database)).toBe(false)
  } finally {
    database.close()
  }
})

test('record local --off clears a mark on a bound store', () => {
  const database = migratedTestDatabase()
  try {
    recordLocalCommand(true, { log: () => undefined }, database)
    database
      .query(
        "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,'at','https://api.example.test')",
      )
      .run()
    recordLocalCommand(false, { log: () => undefined }, database)
    expect(readRecordLocalByDesign(database)).toBe(false)
  } finally {
    database.close()
  }
})
