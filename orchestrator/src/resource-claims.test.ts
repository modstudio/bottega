import { describe, expect, test } from 'bun:test'
import { db, nowIso, writeTransaction } from './db.ts'
import {
  claimCreationDecision,
  claimKindForCreation,
  claimRecipePort,
  createdWorktreeClaimKinds,
  lowestFreePort,
  recipePortAllocation,
  recipePortClaimForRun,
  sandboxDirectoryRelease,
  settledStateForCloseOut,
  settledStateForDatabaseTeardown,
  settledStateForWorktreeResource,
} from './resource-claims.ts'

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
    expect(claimCreationDecision(null, 41)).toBe('record')
    expect(claimCreationDecision(41, 41)).toBe('duplicate')
  })

  test('a port held by another conversation is a collision', () => {
    expect(claimCreationDecision(41, 42)).toBe('collision')
    expect(claimCreationDecision(42, 42)).toBe('duplicate')
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

  test('database allocation reserves the lowest port and reuses it on a later turn', () => {
    const database = db()
    const insertRun = database.query(
      `INSERT INTO run
       (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,parent_run_id,turn)
       VALUES (?,'codex','implement','sha',1,'port allocation','running',?,?)`,
    )
    const root = Number(insertRun.run(nowIso(), null, 1).lastInsertRowid)
    const turn = Number(insertRun.run(nowIso(), root, 2).lastInsertRowid)
    const anotherRoot = Number(insertRun.run(nowIso(), null, 1).lastInsertRowid)
    const allocate = (rootRunId: number, runId: number) =>
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
        "UPDATE resource_claim SET state='released',settled_at=? WHERE root_run_id=? AND kind='port'",
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
    const insertRun = database.query(
      `INSERT INTO run
       (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,turn)
       VALUES (?,'codex','implement','sha',1,'full port band','running',1)`,
    )
    const first = Number(insertRun.run(nowIso()).lastInsertRowid)
    const second = Number(insertRun.run(nowIso()).lastInsertRowid)
    const allocate = (rootRunId: number) =>
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
  })

  test('database and worktree-owned port settlement preserve their lifecycle distinction', () => {
    expect(settledStateForDatabaseTeardown(true)).toBe('released')
    expect(settledStateForDatabaseTeardown(false)).toBe('retained')
    expect(settledStateForWorktreeResource('released', 'port')).toBe('released')
    expect(settledStateForWorktreeResource('forgotten', 'port')).toBe('released')
    expect(settledStateForWorktreeResource('absent', 'port')).toBe('released')
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
