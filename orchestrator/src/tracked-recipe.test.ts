import { describe, expect, test } from 'bun:test'
import { db, nowIso } from './db.ts'
import type { TrackedRecipe } from './recipe-schema.ts'
import type { Step, StepResult } from './recipe-step.ts'
import {
  type AllocationAttempt,
  executeTrackedCreateSteps,
  executeTrackedPreSteps,
  type RecipeSnapshot,
  recipeAllocationEnvironment,
  renderTrackedRecipeNotes,
  type TrackedAllocator,
  teardownTrackedRecipe,
  trackedAllocator,
} from './tracked-recipe.ts'

const command = { command: 'true', args: [] }
const step = (name: string): Step => ({ name, run: command, undo: command })
const result = (name: string, phase: StepResult['phase'], ok: boolean): StepResult => ({
  name,
  phase,
  status: ok ? 'ok' : 'failed',
  exitCode: ok ? 0 : 1,
  argv: ['true'],
  detail: ok ? '' : `${name} broke`,
  durationMs: 0,
})
const context = { treeRoot: '/tree', vars: {} }

describe('tracked recipe execution', () => {
  test('a pre failure releases only the claims inserted by this allocation attempt', () => {
    const attempt: AllocationAttempt = {
      allocations: { index: 2, ports: { web: 21001 }, databases: {}, strings: {} },
      insertedClaimIds: [12, 14],
    }
    const released: { attempt: AllocationAttempt; reason: string }[] = []
    const allocator: TrackedAllocator = {
      allocate: () => attempt,
      release: (releasedAttempt, reason) => released.push({ attempt: releasedAttempt, reason }),
    }
    const input: TrackedRecipe = { pre: [step('pre')], create: [] }

    expect(() =>
      executeTrackedPreSteps(input, context, attempt, allocator, (item) =>
        result(item.name, 'run', false),
      ),
    ).toThrow('worktree pre-check failed at "pre" (run): pre broke')
    expect(released).toEqual([
      {
        attempt,
        reason: 'worktree pre-check failed at "pre" (run): pre broke',
      },
    ])
    expect(released[0]!.attempt.insertedClaimIds).toEqual([12, 14])
  })

  test('a create failure compensates itself and every earlier step despite an undo failure', () => {
    const recipe: TrackedRecipe = { create: [step('zero'), step('one'), step('two')] }
    const undone: string[] = []
    const outcome = executeTrackedCreateSteps(
      recipe,
      context,
      (item) => result(item.name, 'run', item.name !== 'two'),
      (item) => {
        undone.push(item.name)
        return result(item.name, 'undo', item.name !== 'one')
      },
    )
    expect(outcome.failure?.name).toBe('two')
    expect(undone).toEqual(['two', 'one', 'zero'])
    expect(outcome.compensation.map((item) => item.status)).toEqual(['ok', 'failed', 'ok'])
  })

  test('a failed teardown undo retains the tree and names the step', () => {
    const recipe: TrackedRecipe = { create: [step('zero'), step('one')] }
    const snapshot: RecipeSnapshot = {
      source: { path: '.orch/worktree.jsonc', commit: 'abc' },
      recipe,
    }
    let removed = false
    const outcome = teardownTrackedRecipe(
      {
        runId: 1,
        worktree: {
          path: '/tree',
          branch: 'branch',
          base: 'abc',
          repoRoot: '/main',
          source: 'recipe',
          mintedBranch: 'branch',
        },
        stored: { snapshot, key: null, seed: null },
        treeExists: true,
        remove: () => {
          removed = true
          return { removed: true, detail: '/tree' }
        },
      },
      (item) => result(item.name, 'run', true),
      (item) => result(item.name, 'undo', item.name !== 'one'),
    )
    expect(outcome).toEqual({
      removed: false,
      detail: 'recipe teardown failed at "one" (undo): one broke',
    })
    expect(removed).toBeFalse()
  })

  test('reports serve commands with allocation references, main filled, and default first', () => {
    const recipe: TrackedRecipe = {
      allocate: { ports: ['hub'], strings: { token: 'tree-{index}' } },
      create: [],
      serve: {
        preview: [
          {
            name: 'preview web',
            run: { command: 'serve', args: ['{path}', '{ports.hub}'] },
            undo: { command: 'stop', args: ['{alloc.token}'] },
          },
        ],
        default: [
          {
            name: 'default web',
            run: { command: 'bun', args: ['{main}/app.ts', '{index}'] },
            undo: { command: 'kill', args: ['{branch}'] },
          },
        ],
      },
    }
    expect(renderTrackedRecipeNotes(recipe, '/main')).toBe(
      'serve mode default:\n' +
        '  bun /main/app.ts $ORCH_INDEX   default web\n' +
        '  stop: kill <branch>\n' +
        'serve mode preview:\n' +
        '  serve <path> $ORCH_PORTS_HUB   preview web\n' +
        '  stop: stop $ORCH_ALLOC_TOKEN\n' +
        'NEVER verify against a server you did not start for this worktree. Borrowing one\n' +
        'tests a different branch and PASSES, which is worse than failing.',
    )
  })

  test('builds the worker environment from recorded allocations', () => {
    expect(
      recipeAllocationEnvironment({
        index: 4,
        ports: { hub: 21003, 'api-v2': 21004 },
        databases: { app: 'app_4', audit: 'audit_4' },
        strings: { token: 'tree-4' },
      }),
    ).toEqual({
      ORCH_INDEX: '4',
      ORCH_PORTS_HUB: '21003',
      ORCH_PORTS_API_V2: '21004',
      ORCH_DB_APP: 'app_4',
      ORCH_DB_AUDIT: 'audit_4',
      ORCH_ALLOC_TOKEN: 'tree-4',
    })
  })

  test('claims every database before a pre step can run and exposes their filled names', () => {
    const database = db()
    const projectId = Number(
      database.query("INSERT INTO project(name,path,canon) VALUES ('tracked','/tracked',1)").run()
        .lastInsertRowid,
    )
    const runId = Number(
      database
        .query(
          `INSERT INTO run
           (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_id,turn)
           VALUES (?,'codex','implement','sha',1,'tracked databases','running',?,1)`,
        )
        .run(nowIso(), projectId).lastInsertRowid,
    )
    const recipe: TrackedRecipe = {
      allocate: {
        databases: {
          app: { engine: 'postgres', name: 'app_{index}' },
          audit: { engine: 'mysql', name: '{name}_audit_{index}' },
        },
      },
      pre: [step('pre')],
      create: [],
    }
    const attempt = trackedAllocator.allocate({
      runId,
      recipe,
      staticVars: { name: 'tree' },
    })
    const seen: unknown[] = []
    executeTrackedPreSteps(recipe, context, attempt, trackedAllocator, (item) => {
      seen.push(
        database
          .query(
            "SELECT kind,allocation_key,state FROM resource_claim WHERE root_run_id=? AND kind='database' ORDER BY allocation_key",
          )
          .all(runId),
      )
      return result(item.name, 'run', true)
    })
    expect(attempt.allocations.databases).toEqual({ app: 'app_1', audit: 'tree_audit_1' })
    expect(seen).toEqual([
      [
        { kind: 'database', allocation_key: 'mysql:tree_audit_1', state: 'claimed' },
        { kind: 'database', allocation_key: 'postgres:app_1', state: 'claimed' },
      ],
    ])
  })

  test('runs serve undos before destroy undos and keeps the tree after a serve failure', () => {
    const calls: string[] = []
    const serve = step('serve')
    const destroy = step('destroy')
    const recipe: TrackedRecipe = {
      create: [],
      serve: { default: [serve] },
      destroy: [destroy],
    }
    const snapshot: RecipeSnapshot = {
      source: { path: '.orch/worktree.jsonc', commit: 'abc' },
      recipe,
    }
    let removed = false
    const outcome = teardownTrackedRecipe(
      {
        runId: 1,
        worktree: {
          path: '/tree',
          branch: 'branch',
          base: 'abc',
          repoRoot: '/main',
          source: 'recipe',
          mintedBranch: 'branch',
        },
        stored: { snapshot, key: null, seed: null },
        treeExists: true,
        remove: () => {
          removed = true
          return { removed: true, detail: '/tree' }
        },
      },
      (item) => {
        calls.push(`run:${item.name}`)
        return result(item.name, 'run', true)
      },
      (item) => {
        calls.push(`undo:${item.name}`)
        return result(item.name, 'undo', false)
      },
    )
    expect(calls).toEqual(['undo:serve', 'run:destroy'])
    expect(outcome.detail).toContain('recipe teardown failed at "serve" (undo)')
    expect(removed).toBeFalse()
  })

  test('releases database claims only after every teardown result succeeds', () => {
    const database = db()
    const projectId = Number(
      database.query("INSERT INTO project(name,path,canon) VALUES ('teardown','/teardown',1)").run()
        .lastInsertRowid,
    )
    const insertRun = database.query(
      `INSERT INTO run
       (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_id,turn)
       VALUES (?,'codex','implement','sha',1,'database teardown','running',?,1)`,
    )
    const successfulRun = Number(insertRun.run(nowIso(), projectId).lastInsertRowid)
    const failedRun = Number(insertRun.run(nowIso(), projectId).lastInsertRowid)
    const insertClaim = database.query(
      `INSERT INTO resource_claim
       (root_run_id,run_id,project_id,kind,allocation_key,state,claimed_at)
       VALUES (?,?,?,'database',?,'claimed',?)`,
    )
    insertClaim.run(successfulRun, successfulRun, projectId, 'postgres:app_ok', nowIso())
    insertClaim.run(failedRun, failedRun, projectId, 'postgres:app_failed', nowIso())
    const snapshot: RecipeSnapshot = {
      source: { path: '.orch/worktree.jsonc', commit: 'abc' },
      recipe: { create: [step('database')] },
      allocations: { index: 1, ports: {}, databases: { app: 'app' }, strings: {} },
    }
    const teardown = (runId: number, undoOk: boolean) =>
      teardownTrackedRecipe(
        {
          runId,
          worktree: {
            path: '/tree',
            branch: 'branch',
            base: 'abc',
            repoRoot: '/main',
            source: 'recipe',
            mintedBranch: 'branch',
          },
          stored: { snapshot, key: null, seed: null },
          treeExists: true,
          remove: () => ({ removed: true, detail: '/tree' }),
        },
        (item) => result(item.name, 'run', true),
        (item) => result(item.name, 'undo', undoOk),
      )

    expect(teardown(successfulRun, true).removed).toBeTrue()
    expect(teardown(failedRun, false).removed).toBeFalse()
    expect(
      database
        .query(
          "SELECT root_run_id,state FROM resource_claim WHERE kind='database' ORDER BY root_run_id",
        )
        .all(),
    ).toEqual([
      { root_run_id: successfulRun, state: 'released' },
      { root_run_id: failedRun, state: 'claimed' },
    ])
  })
})

describe('a tree built before its project tracked a recipe', () => {
  const worktree = {
    path: '/tree',
    branch: 'branch',
    base: 'abc',
    repoRoot: '/main',
    source: 'recipe' as const,
    mintedBranch: 'branch',
  }
  const stored = { snapshot: null, key: null, seed: null }

  test('is removed as a plain tree when it holds no live database claim', () => {
    let removed = false
    const outcome = teardownTrackedRecipe({
      runId: 1,
      worktree,
      stored,
      liveDatabaseClaims: 0,
      remove: () => {
        removed = true
        return { removed: true, detail: '/tree' }
      },
    })
    expect(removed).toBeTrue()
    expect(outcome.removed).toBeTrue()
    expect(outcome.detail).toContain('no recorded recipe snapshot, removed as a plain tree')
  })

  test('is kept when a live database claim would be orphaned', () => {
    let removed = false
    const outcome = teardownTrackedRecipe({
      runId: 1,
      worktree,
      stored,
      liveDatabaseClaims: 2,
      remove: () => {
        removed = true
        return { removed: true, detail: '/tree' }
      },
    })
    expect(removed).toBeFalse()
    expect(outcome).toEqual({
      removed: false,
      detail:
        'tracked recipe tree has no recorded recipe snapshot and 2 live database claim(s); kept',
    })
  })
})
