import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { readRecordLocalByDesign } from './install-binding.ts'
import { recordLocalCommand } from './record-local-command.ts'

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

test('record local refuses a bound store and names record use', () => {
  const database = migratedTestDatabase()
  try {
    database
      .query(
        "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,'at','https://api.example.test')",
      )
      .run()
    expect(() => recordLocalCommand(true, { log: () => undefined }, database)).toThrow(
      `cleared by: ${PLATFORM_SLUG} record use <address>`,
    )
    expect(readRecordLocalByDesign(database)).toBe(false)
  } finally {
    database.close()
  }
})
