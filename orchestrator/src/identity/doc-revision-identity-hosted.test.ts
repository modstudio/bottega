import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolvedRecordOrigin } from '../../../shared/record-api-url.ts'
import { db } from '../database/db.ts'
import { setDoc } from '../doc/docs.ts'
import { resolveDocRevisionIdentifier } from './doc-revision-identity.ts'

test('a hosted numeric revision refuses with the revision-id listing remedy without using a local number', async () => {
  const local = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'numeric-hosted-revision',
    title: 'Local numeric revision',
    body: 'This local mapping must not be consulted in hosted mode.',
    delivery: 'demand',
    reason: 'seed stale local revision number',
  })
  const number = db()
    .query<{ number: number }, [string]>('SELECT number FROM doc_revision WHERE record_id=?')
    .get(local.revision!)!.number
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  try {
    await expect(resolveDocRevisionIdentifier(db(), number)).rejects.toThrow(
      new RegExp(`pass the revision id.*${PLATFORM_SLUG} doc history`),
    )
  } finally {
    delete process.env.BOTTEGA_RECORD_API_URL
  }
})

test('a bound install refuses a numeric revision without an explicit record API URL', async () => {
  const database = db()
  database.query('DELETE FROM record_install_binding').run()
  database
    .query(
      "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,'2026-11-22',?)",
    )
    .run(resolvedRecordOrigin())
  delete process.env.BOTTEGA_RECORD_API_URL
  try {
    await expect(resolveDocRevisionIdentifier(database, 1)).rejects.toThrow(
      new RegExp(`pass the revision id.*${PLATFORM_SLUG} doc history`),
    )
  } finally {
    database.query('DELETE FROM record_install_binding').run()
  }
})
