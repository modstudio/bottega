import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { finishReleaseLedgerEntry, startReleaseLedgerEntry } from './release-ledger.ts'
import {
  newestSuccessfulProvenReleaseCommit,
  newestSuccessfulReleasedCommit,
} from './release-service.ts'

const PROJECT_RECORD_ID = '01990000-0000-7000-8000-000000002151'

test('release baselines use only a live-proved successful row', () => {
  using database = migratedTestDatabase()
  database
    .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(PROJECT_RECORD_ID, 'fixture', '/fixture', '{}')

  const unproved = startReleaseLedgerEntry(database, {
    project: 'fixture',
    rung: 'production',
    candidate: 'unproved-candidate',
    live: 'old-live',
    rollback: false,
    reason: null,
    trunk: 'main',
    trunkTip: 'unproved-candidate',
    commitsBehindTrunk: 0,
    behindTrunkReason: null,
  })
  finishReleaseLedgerEntry(
    database,
    unproved.recordId,
    { exitCode: 0, output: 'dispatched' },
    'dispatched',
    null,
    null,
    null,
  )

  expect(newestSuccessfulProvenReleaseCommit('fixture', 'production', database)).toBeNull()
  expect(newestSuccessfulReleasedCommit('fixture', 'production', database)).toBeNull()

  const proved = startReleaseLedgerEntry(database, {
    project: 'fixture',
    rung: 'production',
    candidate: 'proved-candidate',
    live: 'old-live',
    rollback: false,
    reason: null,
    trunk: 'main',
    trunkTip: 'proved-candidate',
    commitsBehindTrunk: 0,
    behindTrunkReason: null,
  })
  finishReleaseLedgerEntry(
    database,
    proved.recordId,
    { exitCode: 0, output: 'observed' },
    'observed',
    'proved-live',
    true,
    null,
  )

  expect(newestSuccessfulProvenReleaseCommit('fixture', 'production', database)).toBe(
    'proved-candidate',
  )
  expect(newestSuccessfulReleasedCommit('fixture', 'production', database)).toBe('proved-live')
})
