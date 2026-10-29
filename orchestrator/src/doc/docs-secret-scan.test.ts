import { afterEach, expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import type { SecretScanner } from '../secret-scan/secret-scan.ts'
import { DOC_SECRET_SCANNER_KEY } from './doc-secret-scan.ts'
import { setDoc } from './docs.ts'

const scannerHolder = globalThis as typeof globalThis & {
  [DOC_SECRET_SCANNER_KEY]?: SecretScanner
}
const cleanScanner: SecretScanner = () => ({ status: 'clean' })

afterEach(() => {
  scannerHolder[DOC_SECRET_SCANNER_KEY] = cleanScanner
})

const docCount = () =>
  db().query<{ count: number }, []>('SELECT COUNT(*) AS count FROM doc').get()!.count
const outboxCount = () =>
  db().query<{ count: number }, []>('SELECT COUNT(*) AS count FROM outbox').get()!.count

test('setDoc refuses findings before storing a document or revision', async () => {
  const beforeDocs = docCount()
  const beforeOutbox = outboxCount()
  const beforeRevisions = db()
    .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM doc_revision')
    .get()!.count
  const found: SecretScanner = () => ({
    status: 'found',
    findings: [
      { ruleId: 'github-pat', line: 2 },
      { ruleId: 'generic-api-key', line: 5 },
    ],
  })
  scannerHolder[DOC_SECRET_SCANNER_KEY] = found

  await expect(
    setDoc({
      scope: 'global',
      subject: null,
      slug: 'secret-bearing',
      title: 'Secret bearing',
      body: 'body',
      delivery: 'demand',
      reason: 'exercise secret refusal',
    }),
  ).rejects.toThrow(
    'secret scan refused global/_/secret-bearing: github-pat at line 2, generic-api-key at line 5',
  )
  expect(docCount()).toBe(beforeDocs)
  expect(outboxCount()).toBe(beforeOutbox)
  expect(
    db().query<{ count: number }, []>('SELECT COUNT(*) AS count FROM doc_revision').get()!.count,
  ).toBe(beforeRevisions)
})

test('setDoc writes once and returns one warning when the scan is unavailable', async () => {
  const unavailable: SecretScanner = () => ({
    status: 'unavailable',
    reason: 'gitleaks timed out',
  })
  scannerHolder[DOC_SECRET_SCANNER_KEY] = unavailable

  const written = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'unchecked-write',
    title: 'Unchecked write',
    body: 'body',
    delivery: 'demand',
    reason: 'exercise fail-open warning',
  })

  expect(written.writeWarnings).toEqual([
    'secret scan could not run for global/_/unchecked-write: gitleaks timed out; write allowed unchecked',
  ])
  expect(db().query('SELECT body FROM doc WHERE slug=?').get('unchecked-write')).toEqual({
    body: 'body',
  })
})
