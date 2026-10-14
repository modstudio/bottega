import { expect, test } from 'bun:test'
import { evidenceReferences } from './record-sync-service.ts'

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('a triage snapshot refers only to rows it names by record id', () => {
  const references = evidenceReferences('landing_triage_snapshot', {
    reviewIds: [3996, 3997, 3998],
    readId: '01a137bd-3447-7295-8669-6eddf1dbf3f2',
    overrideId: null,
  })
  expect(references.map((reference) => reference.table)).toEqual(['review_read'])
  for (const reference of references) expect(reference.id).toMatch(RECORD_ID)
})
