import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { resolveNoteIdentity } from './identity.ts'

test('note references share one project-scoped identity lookup', () => {
  const database = new Database(':memory:')
  database.run('CREATE TABLE note(record_id TEXT PRIMARY KEY, project TEXT, number INTEGER)')
  const recordId = newRecordId()
  database.run('INSERT INTO note VALUES (?,?,?)', [recordId, 'workshop', 41])
  for (const reference of ['41', 'n41', 'workshop#41', recordId])
    expect(resolveNoteIdentity(database, reference, 'workshop')).toBe(recordId)
  expect(() => resolveNoteIdentity(database, '42', 'workshop')).toThrow(
    'not visible in project workshop; pass the UUID or a <project>#<number> label',
  )
  database.close()
})
