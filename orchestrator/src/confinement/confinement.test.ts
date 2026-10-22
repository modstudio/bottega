import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import {
  callerCheckoutWatch,
  classifyDivergence,
  classifyRemovedCallerCheckout,
  divergenceAttributionLabel,
  type FrozenCheckout,
  freezeCheckouts,
  lockHolderObservationIsUnknown,
  removedCallerCheckoutError,
  removedCheckoutEvent,
} from './confinement.ts'

const frozen = (path: string, status = ''): FrozenCheckout => ({
  project: 'fixture',
  path,
  status,
  head: 'main',
  expectedHead: null,
  indexTree: 'tree',
  untrackedHash: 'untracked',
  headOid: 'head',
  untrusted: false,
})

test('a timed out or signal-killed lock-holder observation is unknown', () => {
  expect(
    lockHolderObservationIsUnknown({
      exitCode: null,
      signalCode: 'SIGTERM',
      exitedDueToTimeout: true,
    }),
  ).toBe(true)
  expect(
    lockHolderObservationIsUnknown({
      exitCode: null,
      signalCode: 'SIGKILL',
      exitedDueToTimeout: false,
    }),
  ).toBe(true)
  expect(
    lockHolderObservationIsUnknown({
      exitCode: 1,
      signalCode: null,
      exitedDueToTimeout: false,
    }),
  ).toBe(false)
})

test('an incomplete lock-holder observation is recorded in unattributed detail', () => {
  expect(
    divergenceAttributionLabel({
      attribution: 'unattributed',
      lockHolderObservation: 'unknown',
      lockHolder: null,
      landingSession: null,
    }),
  ).toBe('unattributed (lock holder unknown)')
})

test('a missing caller checkout passes only when every writable root excludes it', () => {
  const checkout = {
    project: 'fixture',
    path: '/projects/caller',
  }
  const failure = {
    ...callerCheckoutWatch([checkout], ['/projects/run-tree', '/runs/scratch'])[0]!,
    error: 'missing',
    missing: true,
  }
  expect(classifyRemovedCallerCheckout(failure)).toBe('removed')
  expect(
    classifyRemovedCallerCheckout({
      ...failure,
      ...callerCheckoutWatch([checkout], ['/projects'])[0],
    }),
  ).toBe('unverified')
  expect(
    classifyRemovedCallerCheckout({
      ...failure,
      ...callerCheckoutWatch([checkout], ['/projects/caller/writable-subdirectory'])[0],
    }),
  ).toBe('unverified')
  expect(
    classifyRemovedCallerCheckout({ ...failure, ...callerCheckoutWatch([checkout], null)[0] }),
  ).toBe('unverified')
  expect(
    freezeCheckouts(callerCheckoutWatch([{ ...checkout, path: process.cwd() }], ['/elsewhere']))
      .snapshots[0],
  ).toMatchObject({ caller: true, writeExcluded: true })
})

test('a present changed caller checkout is still classified as divergent', () => {
  const database = new Database(':memory:')
  database.exec(
    'CREATE TABLE run (pid INTEGER, agent_pid INTEGER, session_id TEXT);' +
      'CREATE TABLE project (record_id TEXT, name TEXT);' +
      'CREATE TABLE landing (record_id TEXT, project_record_id TEXT, status TEXT, finished_at TEXT, started_at TEXT, session_id TEXT);',
  )
  const before = frozen('/projects/caller')
  const after = { ...before, status: ' M changed.ts\0', indexTree: 'changed-tree' }
  expect(
    classifyDivergence({
      before: [before],
      after: [after],
      ownDiffPaths: [],
      chainRoot: 'root',
      database,
      startedAt: '2026-10-22T00:00:00.000Z',
    }),
  ).toMatchObject({ classification: 'non_overlapping', checkout: '/projects/caller' })
})

test('an unsafe removed caller names the cause and recorded removal attribution', () => {
  expect(
    removedCallerCheckoutError('/projects/caller', {
      attribution: 'tree_removal',
      removalSession: 'owner-session',
      removalRun: 'tree-run',
    }),
  ).toBe(
    'caller checkout /projects/caller was removed during the run and this run could have written it; confinement cannot be verified; removal attributed to session owner-session (run tree-run)',
  )
})

test('a harmless removed caller records the owner tree-removal attribution', () => {
  const database = new Database(':memory:')
  database.exec(
    `CREATE TABLE run (record_id TEXT, session_id TEXT);
     CREATE TABLE resource_claim (
       id INTEGER PRIMARY KEY, root_run_record_id TEXT, kind TEXT, allocation_key TEXT,
       state TEXT, settled_at TEXT
     );
     INSERT INTO run VALUES ('tree-run', 'owner-session');
     INSERT INTO resource_claim VALUES (
       1, 'tree-run', 'worktree', '/projects/caller', 'released', '2026-10-22T01:00:00.000Z'
     );`,
  )
  expect(
    removedCheckoutEvent({
      database,
      checkout: frozen('/projects/caller'),
      freeze: [frozen('/projects/caller')],
      after: [],
      chainRoot: 'run-root',
      startedAt: '2026-10-22T00:00:00.000Z',
    }),
  ).toMatchObject({
    classification: 'removed',
    attribution: 'tree_removal',
    removalSession: 'owner-session',
    removalRun: 'tree-run',
  })
})
