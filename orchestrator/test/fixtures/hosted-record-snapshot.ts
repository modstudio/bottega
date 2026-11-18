// Superseded keys are left for the OS temporary-directory purge: deleting one can
// race a sibling worktree that is reading it.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
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
const drizzlePackage = join(
  dirname(fileURLToPath(import.meta.resolve('drizzle-orm/migrator'))),
  'package.json',
)
const RECORD_SNAPSHOT_SETUP_SQL = `
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
    `

interface SnapshotKeyFile {
  name: string
  contents: Uint8Array
}

export function hostedRecordSnapshotKey(
  migrationFiles: readonly SnapshotKeyFile[],
  pgliteVersion: string,
  drizzleVersion: string,
  setupSql: string,
  sessionStatements: readonly string[],
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
  for (const input of [pgliteVersion, drizzleVersion, setupSql, sessionStatements.join('\n')]) {
    hash.update(`${input.length}:`)
    hash.update(input)
  }
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
    await database.exec(RECORD_SNAPSHOT_SETUP_SQL)
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

function packageVersion(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
}

function snapshotPath(): string {
  const key = hostedRecordSnapshotKey(
    migrationFiles(migrationsFolder),
    packageVersion(pglitePackage),
    packageVersion(drizzlePackage),
    RECORD_SNAPSHOT_SETUP_SQL,
    migrationSessionStatements(),
  )
  const snapshotDirectory = join(tmpdir(), `${PLATFORM_SLUG}-record-snapshot`)
  return join(snapshotDirectory, `${key}.tar`)
}

async function ensureSnapshotFile(): Promise<string> {
  const finalPath = snapshotPath()
  if (existsSync(finalPath)) return finalPath

  const snapshot = await buildSnapshot()
  const snapshotDirectory = dirname(finalPath)
  await mkdir(snapshotDirectory, { recursive: true })
  const temporaryPath = join(
    snapshotDirectory,
    `${basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(temporaryPath, new Uint8Array(await snapshot.arrayBuffer()), { flag: 'wx' })
    if (!existsSync(finalPath)) await rename(temporaryPath, finalPath)
    return finalPath
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

export async function warmHostedRecordSnapshot(): Promise<void> {
  await ensureSnapshotFile()
}

let snapshotBlob: Promise<Blob> | undefined

export async function loadHostedRecordSnapshot(): Promise<PGlite> {
  snapshotBlob ??= ensureSnapshotFile().then(async (path) => new Blob([await readFile(path)]))
  return new PGlite({ loadDataDir: await snapshotBlob })
}
