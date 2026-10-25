import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import {
  fixtureProjectRecordId,
  migratedTestDatabase,
} from '../database/test-database.fixture.ts'
import { checkoutPathsOverlap, checkoutWatchSet } from '../git/checkout-identity.ts'
import { checkoutRemovalAttribution } from '../resources/resource-claims.ts'
import { callerWatch } from '../run/run-caller-watch.ts'
import {
  callerCheckoutWatch,
  classifyCheckoutChanges,
  classifyDivergence,
  classifyRemovedCallerCheckout,
  divergenceAttributionLabel,
  type FrozenCheckout,
  freezeAfterCheckouts,
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
  const failure = {
    project: 'fixture',
    path: '/projects/caller',
    caller: true,
    writeExcluded: true,
    error: 'missing',
    missing: true,
  }
  expect(classifyRemovedCallerCheckout(failure)).toBe('removed')
  expect(classifyRemovedCallerCheckout({ ...failure, writeExcluded: false })).toBe('unverified')
  expect(classifyRemovedCallerCheckout({ ...failure, writeExcluded: undefined })).toBe('unverified')
  expect(
    freezeCheckouts([{ project: 'fixture', path: process.cwd() }], {
      callerWatch: callerCheckoutWatch(process.cwd(), ['/usr']),
    }).snapshots[0],
  ).toMatchObject({ caller: true, writeExcluded: true })
})

test('physical overlap recognizes real temporary roots and symlink spellings', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-overlap-'))
  const temporaryCaller = mkdtempSync(join(tmpdir(), 'orch-overlap-caller-'))
  const checkout = join(root, 'checkout')
  const alias = join(root, 'alias')
  mkdirSync(checkout)
  symlinkSync(checkout, alias)
  try {
    expect(checkoutPathsOverlap(realpathSync(checkout), root)).toBe(true)
    expect(checkoutPathsOverlap(realpathSync(temporaryCaller), realpathSync(tmpdir()))).toBe(true)
    expect(checkoutPathsOverlap(checkout, alias)).toBe(true)
    expect(checkoutPathsOverlap(checkout, join(root, 'missing'))).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(temporaryCaller, { recursive: true, force: true })
  }
})

test('a present changed caller checkout is still classified as divergent', () => {
  const database = migratedTestDatabase()
  const before = frozen('/projects/caller')
  const after = { ...before, status: ' M changed.ts\0', indexTree: 'changed-tree' }
  const removal = {
    attribution: 'tree_removal' as const,
    removalSession: 'owner-session',
    removalRun: 'tree-run',
  }
  const divergence = classifyDivergence({
    before: [before],
    after: [after],
    ownDiffPaths: [],
    chainRoot: 'root',
    database,
    startedAt: '2026-10-22T00:00:00.000Z',
  })
  expect(
    classifyCheckoutChanges({
      before: [before],
      after: [after],
      removedCaller: frozen('/projects/removed-caller'),
      ownDiffPaths: [],
      chainRoot: 'root',
      database,
      startedAt: '2026-10-22T00:00:00.000Z',
      removal,
    }),
  ).toEqual(divergence)
  expect(divergence).toMatchObject({
    classification: 'non_overlapping',
    checkout: '/projects/caller',
  })
  expect(
    classifyCheckoutChanges({
      before: [before],
      after: [before],
      removedCaller: frozen('/projects/removed-caller'),
      ownDiffPaths: [],
      chainRoot: 'root',
      database,
      startedAt: '2026-10-22T00:00:00.000Z',
      removal,
    }),
  ).toMatchObject({
    classification: 'removed',
    checkout: '/projects/removed-caller',
    attribution: 'tree_removal',
    removalSession: 'owner-session',
    removalRun: 'tree-run',
  })
})

test('an unsafe removed caller names the cause and recorded removal attribution', () => {
  const attributed = removedCallerCheckoutError('/projects/caller', {
    attribution: 'tree_removal',
    removalSession: 'owner-session',
    removalRun: 'tree-run',
  })
  expect(attributed).toContain('was removed during the run and this run could have written it')
  expect(attributed).toContain('attribution: tree removal session owner-session')
  expect(
    removedCallerCheckoutError('/projects/caller', {
      attribution: 'unattributed',
      removalSession: null,
      removalRun: null,
    }),
  ).toContain('attribution: unattributed')
})

test('a harmless removed caller records the owner tree-removal attribution', () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id,project_record_id)
       VALUES ('tree-run',1,'2026-10-22T00:00:00.000Z','codex','implement','fixture',7,'fixture','ok','owner-session',?)`,
    )
    .run(fixtureProjectRecordId(database))
  database
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at,settled_at)
       VALUES (?, 'tree-run', 'tree-run', 'worktree', '/projects/caller', 'released',
               '2026-10-22T00:30:00.000Z', '2026-10-22T01:00:00.000Z')`,
    )
    .run(newRecordId())
  expect(
    removedCheckoutEvent({
      checkout: frozen('/projects/caller'),
      freeze: [frozen('/projects/caller')],
      after: [],
      chainRoot: 'run-root',
      removal: checkoutRemovalAttribution(database, '/projects/caller', '2026-10-22T00:00:00.000Z'),
    }),
  ).toMatchObject({
    classification: 'removed',
    attribution: 'tree_removal',
    removalSession: 'owner-session',
    removalRun: 'tree-run',
  })
  expect(
    divergenceAttributionLabel({
      attribution: 'tree_removal',
      lockHolderObservation: 'complete',
      lockHolder: null,
      landingSession: null,
      removalSession: 'owner-session',
    }),
  ).toBe('tree removal session owner-session')
  database
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at,settled_at)
       VALUES (?, 'tree-run', 'tree-run', 'worktree', '/projects/observed-absent', 'absent',
               '2026-10-22T00:30:00.000Z', '2026-10-22T01:00:00.000Z')`,
    )
    .run(newRecordId())
  expect(
    checkoutRemovalAttribution(database, '/projects/observed-absent', '2026-10-22T00:00:00.000Z'),
  ).toEqual({ attribution: 'unattributed', removalSession: null, removalRun: null })
})

function gitFixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  spawnFixtureGitSync(['init', '-b', 'main', root])
  writeFileSync(join(root, 'tracked.txt'), 'before\n')
  spawnFixtureGitSync(['-C', root, 'add', 'tracked.txt'])
  spawnFixtureGitSync([
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'fixture',
  ])
  return root
}

test('a missing excluded caller is classified as removed after the checkout disappears', () => {
  const caller = gitFixture('orch-removed-caller-')
  const watched = [{ project: 'fixture', path: realpathSync(caller) }]
  const before = freezeCheckouts(watched, {
    callerWatch: callerCheckoutWatch(caller, ['/usr']),
  }).snapshots
  rmSync(caller, { recursive: true, force: true })
  const after = freezeAfterCheckouts({
    watched,
    before,
    removal: { attribution: 'unattributed', removalSession: null, removalRun: null },
  })
  expect(after.failures).toEqual([])
  expect(after.removedCaller).toMatchObject({ caller: true, writeExcluded: true })
})

test('a caller that is also a registered main checkout is stamped once', () => {
  const caller = gitFixture('orch-caller-watch-')
  try {
    const canonicalCaller = realpathSync(caller)
    const callerProject = { name: 'caller-fixture' }
    const watched = checkoutWatchSet(
      [{ project: 'caller-fixture', path: caller }, ...callerWatch(caller, null, callerProject)],
      undefined,
      'unregistered-fixture',
    ).watched
    const before = freezeCheckouts(watched, {
      callerWatch: callerCheckoutWatch(caller, ['/usr']),
    }).snapshots
    expect(before.filter(({ caller }) => caller)).toHaveLength(1)
    expect(before.find(({ path }) => path === canonicalCaller)).toMatchObject({
      caller: true,
      writeExcluded: true,
    })
  } finally {
    rmSync(caller, { recursive: true, force: true })
  }
})
