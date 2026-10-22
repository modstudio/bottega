import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { writableDb } from '../database/db.ts'
import { writeProjectRegisterRow } from '../database/project-register-store.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { checkoutWatchSet } from '../git/checkout-identity.ts'
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
  const database = migratedTestDatabase()
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
  const attributed = removedCallerCheckoutError('/projects/caller', {
    attribution: 'tree_removal',
    removalSession: 'owner-session',
    removalRun: 'tree-run',
  })
  expect(attributed).toContain('was removed during the run and this run could have written it')
  expect(attributed).toContain('removal attributed to session owner-session (run tree-run)')
  expect(
    removedCallerCheckoutError('/projects/caller', {
      attribution: 'unattributed',
      removalSession: null,
      removalRun: null,
    }),
  ).toContain('confinement cannot be verified')
})

test('a harmless removed caller records the owner tree-removal attribution', () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id)
       VALUES ('tree-run',1,'2026-10-22T00:00:00.000Z','codex','implement','fixture',7,'fixture','ok','owner-session')`,
    )
    .run()
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

test('the composed caller watch preserves a registered main marking through removal and divergence', () => {
  const caller = gitFixture('orch-caller-watch-')
  const changed = gitFixture('orch-changed-watch-')
  try {
    const canonicalCaller = realpathSync(caller)
    const canonicalChanged = realpathSync(changed)
    writeProjectRegisterRow(writableDb(), {
      recordId: newRecordId(),
      name: 'caller-fixture',
      path: caller,
    })
    writeProjectRegisterRow(writableDb(), {
      recordId: newRecordId(),
      name: 'changed-fixture',
      path: changed,
    })
    const callerProject = { name: 'caller-fixture' }
    const watched = checkoutWatchSet(
      callerCheckoutWatch(callerWatch(caller, null, callerProject), [changed]),
      undefined,
      null,
    ).watched
    expect(watched.find(({ path }) => path === canonicalCaller)).toMatchObject({
      caller: true,
      writeExcluded: true,
    })

    writableDb()
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id)
         VALUES ('removal-run',(SELECT COALESCE(MAX(number),0)+1 FROM run),
                 '2026-10-22T00:00:00.000Z','codex','implement','fixture',7,'fixture','ok',
                 'removal-owner')`,
      )
      .run()
    writableDb()
      .query(
        `INSERT INTO resource_claim
         (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at,settled_at)
         VALUES (?, 'removal-run', 'removal-run', 'worktree', ?, 'released',
                 '2026-10-22T00:30:00.000Z', '2026-10-22T01:00:00.000Z')`,
      )
      .run(newRecordId(), canonicalCaller)
    const before = freezeCheckouts(watched).snapshots
    rmSync(caller, { recursive: true, force: true })
    const removedAfter = freezeAfterCheckouts({
      watched,
      before,
      database: writableDb(),
      startedAt: '2026-10-22T00:00:00.000Z',
    })
    expect(
      classifyCheckoutChanges({
        before,
        after: removedAfter.snapshots,
        removedCaller: removedAfter.removedCaller,
        ownDiffPaths: [],
        chainRoot: 'root',
        database: writableDb(),
        startedAt: '2026-10-22T00:00:00.000Z',
      }),
    ).toMatchObject({
      classification: 'removed',
      checkout: canonicalCaller,
      attribution: 'tree_removal',
      removalSession: 'removal-owner',
      removalRun: 'removal-run',
    })

    writeFileSync(join(changed, 'tracked.txt'), 'after\n')
    const changedAfter = freezeAfterCheckouts({
      watched: watched.filter(({ path }) => path === canonicalChanged),
      before,
      database: writableDb(),
      startedAt: '2026-10-22T00:00:00.000Z',
    })
    expect(
      classifyCheckoutChanges({
        before,
        after: changedAfter.snapshots,
        removedCaller: null,
        ownDiffPaths: [],
        chainRoot: 'root',
        database: writableDb(),
        startedAt: '2026-10-22T00:00:00.000Z',
      }),
    ).toMatchObject({ classification: 'non_overlapping', checkout: canonicalChanged })
  } finally {
    rmSync(caller, { recursive: true, force: true })
    rmSync(changed, { recursive: true, force: true })
  }
})
