import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  resolveBoardClaimIdentifier,
  resolveBoardMessageIdentifier,
} from './board-message-identifier.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'

const configured = { BOTTEGA_RECORD_API_URL: 'https://record.example.test' }

function adoptedDatabase(): Database {
  const database = new Database(':memory:')
  database.run('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  database.run(
    'CREATE TABLE board_message (record_id TEXT PRIMARY KEY, number INTEGER NOT NULL, audience TEXT)',
  )
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_HOSTED_ADOPTED_KEY, '1')
  return database
}

function localDatabase(messageId: string, claimId: string): Database {
  const database = new Database(':memory:')
  database.run('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  database.run(
    'CREATE TABLE board_message (record_id TEXT PRIMARY KEY, number INTEGER NOT NULL, audience TEXT)',
  )
  database.run('CREATE TABLE board_claim (record_id TEXT PRIMARY KEY)')
  database.run(
    'CREATE TABLE board_hosted_adoption_ledger (source_record_id TEXT, local_kind TEXT, state TEXT)',
  )
  database.query('INSERT INTO board_message(record_id,number) VALUES (?,1)').run(messageId)
  database.query('INSERT INTO board_claim(record_id) VALUES (?)').run(claimId)
  return database
}

test('adopted board identifiers resolve only through hosted records', () => {
  const database = adoptedDatabase()
  const messageId = newRecordId()
  const claimId = newRecordId()

  expect(() => resolveBoardMessageIdentifier(database, 1, configured)).toThrow(
    new RegExp(`record id \\(UUID\\).*${PLATFORM_SLUG} board thread`),
  )
  expect(resolveBoardMessageIdentifier(database, messageId, configured)).toEqual({
    source: 'hosted',
    recordId: messageId,
  })
  expect(resolveBoardClaimIdentifier(database, claimId, configured)).toEqual({
    source: 'hosted',
    recordId: claimId,
  })
})

test('adopted UUID resolution may skip hosted configuration validation', () => {
  const database = adoptedDatabase()
  const messageId = newRecordId()
  expect(resolveBoardMessageIdentifier(database, messageId, {}, false)).toEqual({
    source: 'hosted',
    recordId: messageId,
  })
})

test('not-adopted board identifiers still resolve local rows', () => {
  const messageId = newRecordId()
  const claimId = newRecordId()
  const database = localDatabase(messageId, claimId)

  expect(resolveBoardMessageIdentifier(database, 1, configured)).toEqual({
    source: 'local',
    recordId: messageId,
  })
  expect(resolveBoardMessageIdentifier(database, messageId, configured)).toEqual({
    source: 'local',
    recordId: messageId,
  })
  expect(resolveBoardClaimIdentifier(database, claimId, configured)).toEqual({
    source: 'local',
    recordId: claimId,
  })
})
