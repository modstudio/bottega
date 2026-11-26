import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { Project } from '../project/projects.ts'
import { verifiedReleaseCheckoutRestore } from './release-checkout.ts'
import { finishReleaseLedgerEntry, startReleaseLedgerEntry } from './release-ledger.ts'
import {
  newestSuccessfulProvenReleaseCommit,
  newestSuccessfulReleasedCommit,
  recordAlreadyLiveProof,
  releaseProject,
} from './release-service.ts'
import { machineUpdateRungRefusal } from './release-required.ts'

const PROJECT_RECORD_ID = '01990000-0000-7000-8000-000000002151'

test.each(['alephbeis', 'starship'])(
  '%s production release waits for CI and returns its live proof',
  (name) => {
    const project = {
      recordId: PROJECT_RECORD_ID,
      name,
      path: `/projects/${name}`,
      stack: 'bun',
      canon: false,
      retiredAt: null,
      settings: {
        trunk: 'master',
        release: {
          rungs: [
            {
              name: 'production',
              branch: 'master',
              live: 'read production commit',
              onDemand: false,
            },
          ],
          mergeMethod: 'squash',
          requiredChecks: [],
        },
      },
    } as Project
    const calls: string[] = []

    const result = releaseProject(name, 'production', undefined, undefined, undefined, {
      project: (requested) => (requested === name ? project : null),
      lockHolder: () => null,
      withLock: (_path, _identity, action) => {
        calls.push('lock')
        return action()
      },
      releaseCi: (target) => {
        calls.push(`ci:${target.selected.name}`)
        return {
          kind: 'deployed',
          id: 1,
          project: name,
          rung: 'production',
          branch: 'master',
          deployed: 'candidate',
          trunk: 'master',
          commitsBehindTrunk: 0,
          behindTrunkReason: null,
          liveBefore: 'previous',
          baseline: false,
          rollback: false,
          rollbackReason: null,
          exitCode: 0,
          outputTail: 'observed',
          liveAfter: 'candidate',
          liveMatchesCandidate: true,
          warning: null,
          alreadyLive: false,
          landingAhead: false,
        }
      },
      releaseCommand: () => {
        throw new Error('CI-deployed production must not run a deploy command')
      },
    })

    expect(calls).toEqual(['lock', 'ci:production'])
    expect(result).toMatchObject({
      kind: 'deployed',
      rung: 'production',
      liveAfter: 'candidate',
      liveMatchesCandidate: true,
    })
  },
)

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

test('an already-live release records one proof that clears the machine-update guard', () => {
  using database = migratedTestDatabase()
  database
    .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(PROJECT_RECORD_ID, 'fixture', '/fixture', '{}')
  const failed = startReleaseLedgerEntry(database, {
    project: 'fixture',
    rung: 'production',
    candidate: 'incoming',
    live: 'incoming',
    rollback: false,
    reason: null,
    trunk: 'main',
    trunkTip: 'incoming',
    commitsBehindTrunk: 0,
    behindTrunkReason: null,
  })
  finishReleaseLedgerEntry(
    database,
    failed.recordId,
    { exitCode: 1, output: 'probe failed' },
    'probe failed',
    null,
    false,
    null,
  )
  const proofInput = {
    project: 'fixture',
    rung: 'production',
    candidate: 'incoming',
    live: 'incoming',
    trunk: 'main',
    trunkTip: 'incoming',
    commitsBehindTrunk: 0,
    outputTail: 'rung production is already live at incoming; nothing deployed',
  }

  const first = recordAlreadyLiveProof(proofInput, database)
  const second = recordAlreadyLiveProof(proofInput, database)
  expect(second.record_id).toBe(first.record_id)
  expect(second.number).toBe(first.number)
  expect(
    database.query<{ count: number }, []>('SELECT count(*) AS count FROM release_ledger').get()!
      .count,
  ).toBe(2)
  expect(newestSuccessfulProvenReleaseCommit('fixture', 'production', database)).toBe('incoming')
  expect(
    machineUpdateRungRefusal({
      incomingCommit: 'incoming',
      requiredRungs: ['production'],
      provedCommits: new Map([['production', 'incoming']]),
      liveContainsIncoming: new Map([['production', true]]),
      liveIsAncestorOfIncoming: new Map([['production', true]]),
      requiredSinceLive: new Map([['production', true]]),
      project: 'fixture',
    }),
  ).toBeNull()
})

test('release checkout verification is skipped when no trunk restore occurred', () => {
  let calls = 0
  expect(verifiedReleaseCheckoutRestore('/project', 'main', null, false, () => calls++)).toEqual({
    restoreWarning: null,
    restoreBreach: null,
  })
  expect(calls).toBe(0)
})

test('release checkout verification is skipped when restore already warned', () => {
  let calls = 0
  expect(
    verifiedReleaseCheckoutRestore('/project', 'main', 'restore failed', true, () => calls++),
  ).toEqual({ restoreWarning: 'restore failed', restoreBreach: null })
  expect(calls).toBe(0)
})

test('release checkout verification reports a breach', () => {
  expect(
    verifiedReleaseCheckoutRestore('/project', 'main', null, true, () => {
      throw new Error('checkout has tracked modifications; restore it')
    }),
  ).toEqual({
    restoreWarning: null,
    restoreBreach:
      "registered main checkout could not be restored to landing branch main: checkout has tracked modifications; restore it; run git -C '/project' switch 'main'",
  })
})

test('release checkout verification accepts a clean restore', () => {
  expect(verifiedReleaseCheckoutRestore('/project', 'main', null, true, () => {})).toEqual({
    restoreWarning: null,
    restoreBreach: null,
  })
})
