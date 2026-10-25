import { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, applyMigrationsBefore, migrationJournal } from './migrations.ts'

let migratedTemplate: Uint8Array | undefined
let boundaryTemplates: Map<string, Uint8Array> | undefined
function cloneDatabase(template: Uint8Array): Database {
  const database = Database.deserialize(template)
  database.exec('PRAGMA foreign_keys=ON')
  return database
}

function ensureMigrationTemplates(): void {
  if (migratedTemplate) return
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  applyMigrations(database)
  migratedTemplate = database.serialize()
  database.close()
}

/** Prepares immutable migration images outside an individual test's timed body. */
export function prepareMigrationTestDatabases(): void {
  ensureMigrationTemplates()
}

/** Returns an isolated clone of one immutable, fully migrated in-memory store. */
export function migratedTestDatabase(): Database {
  ensureMigrationTemplates()
  return cloneDatabase(migratedTemplate!)
}

/** Gives a run fixture a real project parent without inventing a task reference. */
export function fixtureProjectRecordId(database: Database): string {
  const existing = database.query('SELECT record_id FROM project ORDER BY name LIMIT 1').get() as {
    record_id: string
  } | null
  if (existing) return existing.record_id
  const recordId = newRecordId()
  database
    .query(
      `INSERT INTO project (record_id,name,path,canon,settings)
       VALUES (?,'run-fixture',?,0,'{"trunk":"main"}')`,
    )
    .run(recordId, resolve(import.meta.dir, '../../..'))
  return recordId
}

/** Writes an isolated file-backed clone for code that opens the store by path. */
export function writeMigratedTestDatabase(path: string): void {
  const database = migratedTestDatabase()
  try {
    writeFileSync(path, database.serialize())
  } finally {
    database.close()
  }
}

/** Returns an isolated store immediately before one named migration. */
export function migrationBoundaryTestDatabase(beforeMigration: string): Database {
  boundaryTemplates ??= new Map()
  let template = boundaryTemplates?.get(beforeMigration)
  if (!template) {
    const journal = migrationJournal()
    const targetIndex = journal.findIndex((entry) => entry.tag === beforeMigration)
    let sourceIndex = -1
    let source: Uint8Array | undefined
    for (const [boundary, image] of boundaryTemplates) {
      const boundaryIndex = journal.findIndex((entry) => entry.tag === boundary)
      if (boundaryIndex < targetIndex && boundaryIndex > sourceIndex) {
        sourceIndex = boundaryIndex
        source = image
      }
    }
    const database = source ? cloneDatabase(source) : new Database(':memory:')
    if (!source) database.exec('PRAGMA foreign_keys=ON')
    applyMigrationsBefore(database, beforeMigration)
    template = database.serialize()
    database.close()
    boundaryTemplates!.set(beforeMigration, template)
  }
  return cloneDatabase(template)
}

/** Builds an immutable fixture once and gives every test an isolated clone. */
export function testDatabaseFixture(setup: (database: Database) => void): () => Database {
  let template: Uint8Array | undefined
  return () => {
    if (!template) {
      const database = migratedTestDatabase()
      setup(database)
      template = database.serialize()
      database.close()
    }
    return cloneDatabase(template)
  }
}
