import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../shared/embedded-assets.ts'
import { expectedSchemaHash, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

test('embedded migrations produce the disk journal and schema hash', () => {
  const diskJournal = migrationJournal()
  const diskHash = expectedSchemaHash()
  const assets: Record<string, string> = {
    'hub/migrations/meta/_journal.json': readFileSync(
      join(MIGRATIONS_FOLDER, 'meta', '_journal.json'),
      'utf8',
    ),
  }
  for (const entry of diskJournal) {
    assets[`hub/migrations/${entry.tag}.sql`] = readFileSync(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      'utf8',
    )
  }
  registerEmbeddedAssets({
    assets,
    files: {},
    manifest: {
      name: PLATFORM_NAME,
      version: '1.2.3',
      built: '2026-09-18T12:34:56.000Z',
      commit: 'abcdef1234567890',
    },
  })
  try {
    expect(migrationJournal()).toEqual(diskJournal)
    expect(expectedSchemaHash()).toBe(diskHash)
  } finally {
    registerEmbeddedAssets(null)
  }
})
