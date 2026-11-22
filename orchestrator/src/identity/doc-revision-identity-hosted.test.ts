import { expect, test } from 'bun:test'
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
    expect(() => resolveDocRevisionIdentifier(db(), number)).toThrow(
      /pass the revision id.*bottega doc history/,
    )
  } finally {
    delete process.env.BOTTEGA_RECORD_API_URL
  }
})
