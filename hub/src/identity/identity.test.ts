import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { NOTE_REFERENCE_FORMS } from '../../../shared/reference-refusal.ts'
import { resolveNoteIdentity } from './identity.ts'

test('note references share one project-scoped identity lookup', () => {
  const database = new Database(':memory:')
  database.run('CREATE TABLE note(record_id TEXT PRIMARY KEY, project TEXT, number INTEGER)')
  const recordId = newRecordId()
  database.run('INSERT INTO note VALUES (?,?,?)', [recordId, 'workshop', 41])
  for (const reference of ['41', 'n41', 'workshop#41', 'workshop#n41', recordId])
    expect(resolveNoteIdentity(database, reference, 'workshop')).toBe(recordId)
  expect(() => resolveNoteIdentity(database, '42', 'workshop')).toThrow(
    'not visible in project workshop; pass the UUID or a <project>#<number> label',
  )
  for (const reference of ['r5', 'x'])
    expect(() => resolveNoteIdentity(database, reference, 'workshop')).toThrow(
      `reference ${JSON.stringify(reference)} is malformed; pass ${NOTE_REFERENCE_FORMS}`,
    )
  const bottegaId = newRecordId()
  database.run('INSERT INTO note VALUES (?,?,?)', [bottegaId, 'bottega', 3])
  for (const reference of ['bottega#3', 'bottega#n3'])
    expect(resolveNoteIdentity(database, reference, 'workshop', () => true)).toBe(bottegaId)
  database.close()
})
