import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { migrationSessionStatements } from '../../../shared/record/migration-session.ts'

const migrationsFolder = join(
  fileURLToPath(new URL('../../../shared/record/migrations', import.meta.url)),
)
const pglitePackage = join(
  dirname(fileURLToPath(import.meta.resolve('@electric-sql/pglite'))),
  '..',
  'package.json',
)

interface SnapshotKeyFile {
  name: string
  contents: Uint8Array
}

export function hostedRecordSnapshotKey(
  migrationFiles: readonly SnapshotKeyFile[],
  pgliteVersion: string,
): string {
  const hash = createHash('sha256')
  for (const file of migrationFiles.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    hash.update(`${file.name.length}:`)
    hash.update(file.name)
    hash.update(`${file.contents.byteLength}:`)
    hash.update(file.contents)
  }
  hash.update(`${pgliteVersion.length}:`)
  hash.update(pgliteVersion)
  return hash.digest('hex')
}

function migrationFiles(folder: string): SnapshotKeyFile[] {
  const files: SnapshotKeyFile[] = []
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) files.push(...migrationFiles(path))
    else if (entry.isFile())
      files.push({ name: relative(migrationsFolder, path), contents: readFileSync(path) })
  }
  return files
}

async function applyMigration(transaction: Transaction, migration: MigrationMeta) {
  for (const statement of migration.sql) await transaction.exec(statement)
  await transaction.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash,created_at,name) VALUES ($1,$2,$3)',
    [migration.hash, migration.folderMillis, migration.name],
  )
}

async function buildSnapshot(): Promise<Blob> {
  const database = new PGlite()
  try {
    await database.exec(`
      CREATE ROLE record_owner LOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE record_actor LOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE record_auth LOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE record_public NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE record_reader LOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT record_public TO record_actor WITH INHERIT FALSE, SET TRUE;
      GRANT CREATE ON DATABASE postgres TO record_owner;
      ALTER SCHEMA public OWNER TO record_owner;
      SET ROLE record_owner;
      CREATE SCHEMA drizzle;
      CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY, hash text NOT NULL, created_at bigint, name text
      );
    `)
    await database.transaction(async (transaction) => {
      for (const statement of migrationSessionStatements()) await transaction.exec(statement)
      for (const migration of readMigrationFiles({ migrationsFolder }))
        await applyMigration(transaction, migration)
    })
    await database.exec('RESET ROLE')
    return await database.dumpDataDir('none')
  } finally {
    await database.close()
  }
}

async function readOrBuildSnapshot(): Promise<Blob> {
  const manifest = JSON.parse(readFileSync(pglitePackage, 'utf8')) as { version: string }
  const key = hostedRecordSnapshotKey(migrationFiles(migrationsFolder), manifest.version)
  const snapshotDirectory = join(tmpdir(), `${PLATFORM_SLUG}-record-snapshot`)
  const snapshotPath = join(snapshotDirectory, `${key}.tar`)
  if (existsSync(snapshotPath)) return new Blob([await readFile(snapshotPath)])

  const snapshot = await buildSnapshot()
  await mkdir(snapshotDirectory, { recursive: true })
  const temporaryPath = join(snapshotDirectory, `${key}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, new Uint8Array(await snapshot.arrayBuffer()), { flag: 'wx' })
    if (existsSync(snapshotPath)) return new Blob([await readFile(snapshotPath)])
    await rename(temporaryPath, snapshotPath)
    return snapshot
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

let snapshotBlob: Promise<Blob> | undefined

export async function loadHostedRecordSnapshot(): Promise<PGlite> {
  snapshotBlob ??= readOrBuildSnapshot()
  return new PGlite({ loadDataDir: await snapshotBlob })
}
