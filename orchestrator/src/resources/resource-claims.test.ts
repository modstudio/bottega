import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import {
  claimCreationDecision,
  claimDatabaseName,
  claimIndex,
  claimKindForCreation,
  claimRecipePort,
  claimString,
  createdWorktreeClaimKinds,
  fillStringAllocationTemplate,
  indexAllocation,
  lowestFreePort,
  recipePortAllocation,
  recipePortClaimForRun,
  releaseRecipeAllocationClaims,
  sandboxDirectoryRelease,
  settleClaims,
  settledStateForCloseOut,
  settledStateForDatabaseTeardown,
  settledStateForWorktreeResource,
  stringClaimDecision,
} from './resource-claims.ts'

function resourceRun(projectRecordId: string | null = null, parent?: string): string {
  const recordId = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'running',
    ...(parent === undefined ? {} : { parent, turn: 2 }),
  })
  if (projectRecordId !== null) {
    db()
      .query('UPDATE run SET project_record_id=? WHERE record_id=?')
      .run(projectRecordId, recordId)
  }
  return recordId
}

describe('resource claim decisions', () => {
  const releasableSandbox = {
    terminal: true,
    liveTurn: false,
    liveProcess: false,
    worktreeState: 'released' as const,
    keepTree: false,
    directoryExists: true,
  }

  test('sandbox release keeps every live or explicitly held conversation resource', () => {
    expect(sandboxDirectoryRelease({ ...releasableSandbox, terminal: false })).toBe(
      'keep:conversation is not terminal',
    )
    expect(sandboxDirectoryRelease({ ...releasableSandbox, liveTurn: true })).toBe(
      'keep:conversation has a live turn',
    )
    expect(sandboxDirectoryRelease({ ...releasableSandbox, liveProcess: true })).toBe(
      'keep:conversation has a live process',
    )
    expect(sandboxDirectoryRelease({ ...releasableSandbox, keepTree: true })).toBe(
      'keep:held by explicit --keep-tree',
    )
    expect(sandboxDirectoryRelease({ ...releasableSandbox, worktreeState: 'claimed' })).toBe(
      'keep:worktree is still held',
    )
  })

  test('sandbox release accepts a released tree or no tree and reports an absent directory', () => {
    expect(sandboxDirectoryRelease(releasableSandbox)).toBe('release')
    expect(sandboxDirectoryRelease({ ...releasableSandbox, worktreeState: 'no-tree' })).toBe(
      'release',
    )
    expect(sandboxDirectoryRelease({ ...releasableSandbox, directoryExists: false })).toBe('absent')
  })

  test('creation records exactly the resources that were created', () => {
    expect(claimKindForCreation('sandbox_directory')).toBe('sandbox_dir')
    expect(claimKindForCreation('trust_heading')).toBe('trust_entry')
    expect(claimKindForCreation('serve_port')).toBe('port')
    expect(claimKindForCreation('database')).toBe('database')
  })

  test('a sandbox directory is recorded once per conversation root', () => {
    expect(claimCreationDecision(null, '41')).toBe('record')
    expect(claimCreationDecision('41', '41')).toBe('duplicate')
  })

  test('a port held by another conversation is a collision', () => {
    expect(claimCreationDecision('41', '42')).toBe('collision')
    expect(claimCreationDecision('42', '42')).toBe('duplicate')
  })

  test('the lowest free port selects the band start when the band is empty', () => {
    expect(lowestFreePort({ start: 21000, end: 21003 }, [])).toBe(21000)
  })

  test('the lowest free port fills the first gap without considering ports outside the band', () => {
    expect(lowestFreePort({ start: 21000, end: 21004 }, [19999, 21000, 21002, 25000])).toBe(21001)
  })

  test('the lowest free port reports a full band', () => {
    expect(lowestFreePort({ start: 21000, end: 21003 }, [21000, 21001, 21002])).toBeNull()
  })

  test('an existing claimed port is reused for its conversation root', () => {
    expect(recipePortAllocation({ start: 21000, end: 21003 }, [21000, 21001], 21001)).toEqual({
      action: 'reuse',
      port: 21001,
    })
  })

  test('index allocation chooses the lowest free value and reuses the root value', () => {
    expect(indexAllocation([], null)).toEqual({ action: 'claim', index: 1 })
    expect(indexAllocation([1, 3], null)).toEqual({ action: 'claim', index: 2 })
    expect(indexAllocation([1, 2], 2)).toEqual({ action: 'reuse', index: 2 })
  })

  test('string allocation filling refuses a missing value instead of filling empty text', () => {
    expect(
      fillStringAllocationTemplate('cookie', '{name}-{index}', { name: 'tree', index: '2' }),
    ).toBe('tree-2')
    expect(() =>
      fillStringAllocationTemplate('cookie', '{name}-{index}', { name: 'tree' }),
    ).toThrow('unavailable placeholder {index} in string allocation "cookie"')
    expect(stringClaimDecision('held', '2', '1')).toBe('reuse')
    expect(stringClaimDecision(null, '1', '1')).toBe('reuse')
    expect(stringClaimDecision(null, '2', '1')).toBe('collision')
    expect(stringClaimDecision(null, null, '1')).toBe('claim')
  })

  test('database allocation reserves the lowest port and reuses it on a later turn', () => {
    const database = db()
    const root = resourceRun()
    const turn = resourceRun(null, root)
    const anotherRoot = resourceRun()
    const allocate = (rootRunId: string, runId: string) =>
      writeTransaction(
        () =>
          claimRecipePort(database, {
            rootRunId,
            runId,
            projectId: null,
            claimedAt: nowIso(),
            band: { start: 23000, end: 23003 },
          }),
        database,
      )

    expect(allocate(root, root)).toBe(23000)
    expect(allocate(root, turn)).toBe(23000)
    expect(allocate(anotherRoot, anotherRoot)).toBe(23001)
    expect(recipePortClaimForRun(database, turn)).toBe(23000)
    database
      .query(
        "UPDATE resource_claim SET state='released',settled_at=? WHERE root_run_record_id=? AND kind='port'",
      )
      .run(nowIso(), root)
    expect(recipePortClaimForRun(database, turn)).toBe(23000)
    expect(
      database
        .query("SELECT COUNT(*) count FROM resource_claim WHERE kind='port' AND state='claimed'")
        .get(),
    ).toEqual({ count: 1 })
  })

  test('database allocation reports a full band and its live claim count', () => {
    const database = db()
    const first = resourceRun()
    const second = resourceRun()
    const allocate = (rootRunId: string) =>
      writeTransaction(
        () =>
          claimRecipePort(database, {
            rootRunId,
            runId: rootRunId,
            projectId: null,
            claimedAt: nowIso(),
            band: { start: 24000, end: 24001 },
          }),
        database,
      )

    expect(allocate(first)).toBe(24000)
    expect(() => allocate(second)).toThrow('recipe port band [24000, 24001) is full: 1 live claims')
    expect(
      database
        .query<{ record_id: string }, []>(
          "SELECT record_id FROM resource_claim WHERE kind='port' AND state='claimed'",
        )
        .get()?.record_id,
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  test('named and anonymous recipe ports reuse only the matching identity', () => {
    const database = db()
    const root = resourceRun()
    const claim = (name?: string) =>
      writeTransaction(
        () =>
          claimRecipePort(database, {
            rootRunId: root,
            runId: root,
            projectId: null,
            claimedAt: nowIso(),
            band: { start: 24100, end: 24110 },
            ...(name === undefined ? {} : { name }),
          }),
        database,
      )

    expect(claim()).toBe(24100)
    expect(claim('web')).toBe(24101)
    expect(claim('api')).toBe(24102)
    expect(claim('web')).toBe(24101)
    expect(claim()).toBe(24100)
  })

  test('project indexes are stable per root and reusable after release', () => {
    const database = db()
    const insertProject = database.query<{ record_id: string }, [string, string]>(
      'INSERT INTO project(record_id,name,path,canon) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,1) RETURNING record_id',
    )
    const projectOne = insertProject.get('one', '/one')!.record_id
    const projectTwo = insertProject.get('two', '/two')!.record_id
    const first = resourceRun(projectOne)
    const second = resourceRun(projectOne)
    const otherProject = resourceRun(projectTwo)
    const third = resourceRun(projectOne)
    const claim = (rootRunId: string, projectId: string) =>
      writeTransaction(
        () =>
          claimIndex(database, {
            rootRunId,
            runId: rootRunId,
            projectId,
            claimedAt: nowIso(),
          }),
        database,
      )

    expect(claim(first, projectOne)).toBe(1)
    expect(claim(first, projectOne)).toBe(1)
    expect(claim(second, projectOne)).toBe(2)
    expect(claim(otherProject, projectTwo)).toBe(1)
    database
      .query(
        "UPDATE resource_claim SET state='released' WHERE root_run_record_id=? AND kind='index'",
      )
      .run(first)
    expect(claim(third, projectOne)).toBe(1)
  })

  test('string claims reuse by root and name and refuse another root holding the value', () => {
    const database = db()
    const projectId = database
      .query<{ record_id: string }, []>(
        "INSERT INTO project(record_id,name,path,canon) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'strings','/strings',1) RETURNING record_id",
      )
      .get()!.record_id
    const first = resourceRun(projectId)
    const second = resourceRun(projectId)
    const claim = (rootRunId: string, value: string) =>
      writeTransaction(
        () =>
          claimString(database, {
            rootRunId,
            runId: rootRunId,
            projectId,
            name: 'cookie',
            value,
            claimedAt: nowIso(),
          }),
        database,
      )

    expect(claim(first, 'cookie-1')).toBe('cookie-1')
    expect(claim(first, 'changed-template')).toBe('cookie-1')
    expect(() => claim(second, 'cookie-1')).toThrow(
      `string allocation "cookie" value "cookie-1" is held by run ${first}; include {index} in its template`,
    )
  })

  test('database claims reuse by root and name and collide only within an engine', () => {
    const database = db()
    const projectId = database
      .query<{ record_id: string }, []>(
        "INSERT INTO project(record_id,name,path,canon) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'databases','/databases',1) RETURNING record_id",
      )
      .get()!.record_id
    const first = resourceRun(projectId)
    const second = resourceRun(projectId)
    const claim = (rootRunId: string, engine: string, value: string) =>
      writeTransaction(
        () =>
          claimDatabaseName(database, {
            rootRunId,
            runId: rootRunId,
            projectId,
            name: 'app',
            engine,
            value,
            claimedAt: nowIso(),
          }),
        database,
      )

    expect(claim(first, 'postgres', 'app_1')).toBe('app_1')
    expect(claim(first, 'postgres', 'changed_template')).toBe('app_1')
    expect(() => claim(second, 'postgres', 'app_1')).toThrow(
      `database allocation "app" value "app_1" is held by run ${first}; include {index} in its template`,
    )
    expect(claim(second, 'mysql', 'app_1')).toBe('app_1')
  })

  test('worktree settlement releases index and string claims unless the tree is retained', () => {
    const database = db()
    const root = resourceRun()
    const insertClaim = database.query(
      `INSERT INTO resource_claim
       (record_id, root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
       VALUES (?, ?,? ,?,?,'claimed',?)`,
    )
    insertClaim.run(newRecordId(), root, root, 'worktree', '/tree', nowIso())
    insertClaim.run(newRecordId(), root, root, 'index', 'index:1:1', nowIso())
    insertClaim.run(newRecordId(), root, root, 'string', 'string:1:value', nowIso())
    settleClaims(database, {
      rootRunId: root,
      kind: 'worktree',
      state: 'retained',
      settledAt: nowIso(),
      detail: 'held',
    })
    expect(
      database.query("SELECT COUNT(*) count FROM resource_claim WHERE state='claimed'").get(),
    ).toEqual({ count: 2 })
    database.query("UPDATE resource_claim SET state='claimed' WHERE kind='worktree'").run()
    settleClaims(database, {
      rootRunId: root,
      kind: 'worktree',
      state: 'released',
      settledAt: nowIso(),
      detail: 'removed',
    })
    expect(
      database.query("SELECT COUNT(*) count FROM resource_claim WHERE state='claimed'").get(),
    ).toEqual({ count: 0 })
  })

  test('failed creation releases only claim ids inserted by that attempt', () => {
    const database = db()
    const root = resourceRun()
    const insert = database.query(
      `INSERT INTO resource_claim
       (record_id, root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
       VALUES (?, ?,?,?,?, 'claimed',?)`,
    )
    const previousId = newRecordId()
    insert.run(previousId, root, root, 'database', 'postgres:existing', nowIso())
    const attemptId = newRecordId()
    insert.run(attemptId, root, root, 'index', 'index:1:2', nowIso())
    const databaseId = newRecordId()
    database
      .query(
        `INSERT INTO resource_claim
         (record_id, root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
         VALUES (?, ?,?,'database','postgres:app_1','claimed',?)`,
      )
      .run(databaseId, root, root, nowIso())
    releaseRecipeAllocationClaims(database, {
      claimIds: [attemptId, databaseId],
      settledAt: nowIso(),
      reason: 'pre failed',
    })
    expect(
      database
        .query('SELECT record_id,state FROM resource_claim ORDER BY claimed_at,record_id')
        .all(),
    ).toEqual([
      { record_id: previousId, state: 'claimed' },
      { record_id: attemptId, state: 'released' },
      { record_id: databaseId, state: 'released' },
    ])
  })

  test('database and worktree-owned port settlement preserve their lifecycle distinction', () => {
    expect(settledStateForDatabaseTeardown(true)).toBe('released')
    expect(settledStateForDatabaseTeardown(false)).toBe('retained')
    expect(settledStateForWorktreeResource('released', 'port')).toBe('released')
    expect(settledStateForWorktreeResource('forgotten', 'port')).toBe('released')
    expect(settledStateForWorktreeResource('absent', 'port')).toBe('released')
    expect(settledStateForWorktreeResource('released', 'index')).toBe('released')
    expect(settledStateForWorktreeResource('released', 'string')).toBe('released')
    expect(settledStateForWorktreeResource('released', 'database')).toBeNull()
  })

  test('only orch-owned creation records worktree and minted branch claims', () => {
    expect(createdWorktreeClaimKinds({ owned: false, mintedBranch: 'DEV-1' })).toEqual([])
    expect(createdWorktreeClaimKinds({ owned: true, mintedBranch: null })).toEqual(['worktree'])
    expect(createdWorktreeClaimKinds({ owned: true, mintedBranch: 'DEV-1' })).toEqual([
      'worktree',
      'branch',
    ])
  })

  test('close-out settles only the states established by its outcome', () => {
    expect(settledStateForCloseOut('released', 'worktree')).toBe('released')
    expect(settledStateForCloseOut('forgotten', 'worktree')).toBe('forgotten')
    expect(settledStateForCloseOut('absent', 'worktree')).toBe('absent')
    expect(settledStateForCloseOut('released', 'branch')).toBe('retained')
    for (const outcome of ['held', 'live', 'failed'] as const) {
      expect(settledStateForCloseOut(outcome, 'worktree')).toBeNull()
    }
    expect(settledStateForCloseOut('released', 'retained_ref')).toBeNull()
  })
})
