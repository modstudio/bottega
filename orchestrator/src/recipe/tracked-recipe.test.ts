import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, nowIso } from '../database/db.ts'
import { git } from '../git/git-environment.ts'
import { recordCreatedWorktreeClaims } from '../resources/resource-claims.ts'
import type { TrackedRecipe } from './recipe-schema.ts'
import type { Step, StepResult } from './recipe-step.ts'
import { type EnvFileGitCheck, writeTrackedEnvFiles } from './tracked-env-files.ts'
import {
  type AllocationAttempt,
  createTrackedRecipe,
  executeTrackedCreateSteps,
  executeTrackedPreSteps,
  executeTrackedRefreshSteps,
  type RecipeSnapshot,
  recipeAllocationEnvironment,
  renderTrackedRecipeNotes,
  type TrackedAllocator,
  teardownTrackedRecipe,
  trackedAllocator,
  trackedRecipeEnvironment,
  trackedRecipeVars,
  trackedWorktreeAddArgv,
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
const directories: string[] = []

function temporaryTree(): { project: string; tree: string } {
  const project = mkdtempSync(join(tmpdir(), 'orch-env-project-'))
  const tree = join(project, 'tree-name')
  mkdirSync(tree)
  directories.push(project)
  return { project, tree }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const ignoredUntracked: EnvFileGitCheck = () => ({ tracked: false, ignored: true })

function writeEnv(recipe: TrackedRecipe, tree: string, project: string, vars = {}) {
  return writeTrackedEnvFiles(recipe, { treeRoot: tree, vars }, project, {}, ignoredUntracked)
}

describe('tracked recipe execution', () => {
  test('a missing required provision removes the partial tree and settles only its run claims', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'orch-required-provision-'))
    directories.push(repoRoot)
    git(['init', '--initial-branch=main'], repoRoot)
    mkdirSync(join(repoRoot, 'present'))
    writeFileSync(join(repoRoot, 'present', 'dependency'), 'ready')
    writeFileSync(
      join(repoRoot, `${PLATFORM_SLUG}.jsonc`),
      JSON.stringify({
        worktree: {
          provision: [
            { path: 'present', method: 'link' },
            { path: 'missing', method: 'link', required: true },
          ],
          create: [],
        },
      }),
    )
    git(['add', '.'], repoRoot)
    git(
      [
        '-c',
        'user.name=Orch Test',
        '-c',
        'user.email=orch@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
      repoRoot,
    )

    const database = db()
    const projectId = Number(
      database
        .query("INSERT INTO project(name,path,canon) VALUES ('required-provision',?,1)")
        .run(repoRoot).lastInsertRowid,
    )
    const insertRun = database.query(
      `INSERT INTO run
       (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_id,turn)
       VALUES (?,'codex','implement','sha',1,'required provision','running',?,1)`,
    )
    const runId = Number(insertRun.run(nowIso(), projectId).lastInsertRowid)
    const unrelatedRunId = Number(insertRun.run(nowIso(), projectId).lastInsertRowid)
    database
      .query(
        `INSERT INTO resource_claim
         (root_run_id,run_id,project_id,kind,allocation_key,state,claimed_at)
         VALUES (?,?,?,'worktree','/unrelated','claimed',?)`,
      )
      .run(unrelatedRunId, unrelatedRunId, projectId, nowIso())

    const path = join(repoRoot, '.claude', 'worktrees', `orch-${runId}`)
    const branch = `DEV-1039-orch-${runId}`
    let earlierProvisionObserved = false
    expect(() =>
      createTrackedRecipe({
        tool: { recipePath: `${PLATFORM_SLUG}.jsonc` },
        repoRoot,
        runId,
        branch,
        name: `orch-${runId}`,
        path,
        attribute(worktree) {
          database
            .query('UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=? WHERE id=?')
            .run(
              worktree.path,
              worktree.path,
              worktree.branch,
              worktree.mintedBranch ?? null,
              runId,
            )
          recordCreatedWorktreeClaims(database, {
            rootRunId: runId,
            runId,
            projectId,
            owned: true,
            path: worktree.path,
            head: worktree.base,
            mintedBranch: worktree.mintedBranch ?? null,
            label: String(runId),
            claimedAt: nowIso(),
          })
        },
        verify() {},
        remove(worktree) {
          earlierProvisionObserved = existsSync(join(worktree.path, 'present', 'dependency'))
          try {
            git(['worktree', 'remove', '--force', worktree.path], repoRoot)
            if (worktree.mintedBranch) git(['branch', '-D', worktree.mintedBranch], repoRoot)
            return { removed: true, detail: worktree.path }
          } catch (error) {
            return { removed: false, detail: String(error) }
          }
        },
        removeProvisioned: () => ({ removed: false, detail: 'unused' }),
      }),
    ).toThrow(`from tracked recipe "${PLATFORM_SLUG}.jsonc"`)

    expect(earlierProvisionObserved).toBeTrue()
    expect(existsSync(path)).toBeFalse()
    expect(database.query('SELECT worktree FROM run WHERE id=?').get(runId)).toEqual({
      worktree: null,
    })
    expect(
      database
        .query(
          'SELECT kind,state FROM resource_claim WHERE root_run_id=? ORDER BY kind,allocation_key',
        )
        .all(runId),
    ).toEqual([
      { kind: 'branch', state: 'released' },
      { kind: 'index', state: 'released' },
      { kind: 'worktree', state: 'released' },
    ])
    expect(
      database.query('SELECT state FROM resource_claim WHERE root_run_id=?').get(unrelatedRunId),
    ).toEqual({ state: 'claimed' })
  })

  test('builds every worktree-add form with optional relative git pointers', () => {
    const common = { branch: 'DEV-877-tree', path: '/trees/dev-877', base: 'main' }
    expect(
      trackedWorktreeAddArgv({
        ...common,
        detached: false,
        existingBranch: false,
        relativePaths: true,
      }),
    ).toEqual([
      'worktree',
      'add',
      '--relative-paths',
      '-b',
      'DEV-877-tree',
      '/trees/dev-877',
      'main',
    ])
    expect(
      trackedWorktreeAddArgv({
        ...common,
        detached: false,
        existingBranch: true,
        relativePaths: true,
      }),
    ).toEqual(['worktree', 'add', '--relative-paths', '/trees/dev-877', 'DEV-877-tree'])
    expect(
      trackedWorktreeAddArgv({
        ...common,
        detached: true,
        existingBranch: false,
        relativePaths: true,
      }),
    ).toEqual(['worktree', 'add', '--relative-paths', '--detach', '/trees/dev-877', 'main'])
    expect(trackedWorktreeAddArgv({ ...common, detached: false, existingBranch: false })).toEqual([
      'worktree',
      'add',
      '-b',
      'DEV-877-tree',
      '/trees/dev-877',
      'main',
    ])
  })

  test('runs the fixture recipe refresh list in order', () => {
    const recipe: TrackedRecipe = {
      create: [],
      refresh: [
        { name: 'dependencies', run: command },
        { name: 'generated', run: command },
      ],
    }
    const invoked: string[] = []
    const failure = executeTrackedRefreshSteps(recipe, context, (item) => {
      invoked.push(item.name)
      return result(item.name, 'run', true)
    })
    expect(failure).toBeNull()
    expect(invoked).toEqual(['dependencies', 'generated'])
  })

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
            run: { command: 'bun', args: ['{main}/app.ts', '{index}', '{tree_exists}'] },
            undo: { command: 'kill', args: ['{branch}'] },
          },
        ],
      },
    }
    expect(renderTrackedRecipeNotes(recipe, '/main')).toBe(
      'serve mode default:\n' +
        '  bun /main/app.ts $ORCH_INDEX true   default web\n' +
        '  stop: kill <branch>\n' +
        'serve mode preview:\n' +
        '  serve <path> $ORCH_PORTS_HUB   preview web\n' +
        '  stop: stop $ORCH_ALLOC_TOKEN\n' +
        'NEVER verify against a server you did not start for this worktree. Borrowing one\n' +
        'tests a different branch and PASSES, which is worse than failing.',
    )
  })

  test('reports every shared kind after serve modes and omits the section when absent', () => {
    const serve: TrackedRecipe['serve'] = {
      default: [
        {
          name: 'web',
          run: { command: 'serve', args: [] },
          undo: { command: 'stop', args: [] },
        },
      ],
    }
    const withoutShared = renderTrackedRecipeNotes({ create: [], serve }, '/main')
    expect(withoutShared).not.toContain('shared declarations:')
    const notes = renderTrackedRecipeNotes(
      {
        create: [],
        serve,
        shared: [
          { name: 'vendor', kind: 'path', from: 'main/vendor', at: 'vendor' },
          { name: 'modules', kind: 'volume', from: 'modules', at: 'node_modules' },
          { name: 'edge', kind: 'network', from: 'edge', at: 'edge' },
          { name: 'redis', kind: 'service', from: 'redis', at: 'redis' },
        ],
      },
      '/main',
    )
    expect(notes.indexOf('shared declarations:')).toBeGreaterThan(
      notes.indexOf('serve mode default:'),
    )
    expect(notes).toContain(
      'path vendor: main/vendor -> vendor (shared; not created or removed by this run)',
    )
    expect(notes).toContain(
      'volume modules: modules -> node_modules (shared; not created or removed by this run)',
    )
    expect(notes).toContain(
      'network edge: edge -> edge (shared; not created or removed by this run)',
    )
    expect(notes).toContain(
      'service redis: redis -> redis (shared; not created or removed by this run)',
    )
  })

  test('shared declarations add no claims to the recipe allocation set', () => {
    const database = db()
    const projectId = Number(
      database.query("INSERT INTO project(name,path,canon) VALUES ('shared','/shared',1)").run()
        .lastInsertRowid,
    )
    const runId = Number(
      database
        .query(
          `INSERT INTO run
           (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_id,turn)
           VALUES (?,'codex','implement','sha',1,'shared claims','running',?,1)`,
        )
        .run(nowIso(), projectId).lastInsertRowid,
    )
    const plain = trackedAllocator.allocate({ runId, recipe: { create: [] }, staticVars: {} })
    const shared = trackedAllocator.allocate({
      runId,
      recipe: {
        create: [],
        shared: [
          { name: 'vendor', kind: 'path', from: 'vendor', at: 'vendor' },
          { name: 'modules', kind: 'volume', from: 'modules', at: 'modules' },
          { name: 'edge', kind: 'network', from: 'edge', at: 'edge' },
          { name: 'redis', kind: 'service', from: 'redis', at: 'redis' },
        ],
      },
      staticVars: {},
    })
    expect(shared.allocations).toEqual(plain.allocations)
    expect(shared.insertedClaimIds).toEqual([])
  })

  test('builds the worker environment from recorded allocations and the root label', () => {
    expect(
      recipeAllocationEnvironment(
        {
          index: 4,
          ports: { hub: 21003, 'api-v2': 21004 },
          databases: { app: 'app_4', audit: 'audit_4' },
          strings: { token: 'tree-4' },
        },
        17,
      ),
    ).toEqual({
      ORCH_RUN_LABEL: 'orch.run=17',
      ORCH_INDEX: '4',
      ORCH_PORTS_HUB: '21003',
      ORCH_PORTS_API_V2: '21004',
      ORCH_DB_APP: 'app_4',
      ORCH_DB_AUDIT: 'audit_4',
      ORCH_ALLOC_TOKEN: 'tree-4',
    })
  })

  test('creation variables carry the conversation root label', () => {
    expect(
      trackedRecipeVars(
        { branch: 'DEV-596', path: '/tree' },
        { index: 6, ports: { hub: 21005 }, databases: {}, strings: {} },
        17,
      ),
    ).toMatchObject({
      branch: 'DEV-596',
      path: '/tree',
      index: '6',
      label: 'orch.run=17',
      'ports.hub': '21005',
    })
  })

  test('the worker environment uses the conversation root label for a resumed turn', () => {
    const database = db()
    const projectId = Number(
      database.query("INSERT INTO project(name,path,canon) VALUES ('resume','/resume',1)").run()
        .lastInsertRowid,
    )
    const rootId = Number(
      database
        .query(
          `INSERT INTO run
           (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_id,turn,recipe_snapshot)
           VALUES (?,'codex','implement','sha',1,'root','asking',?,1,?)`,
        )
        .run(
          nowIso(),
          projectId,
          JSON.stringify({
            source: { path: '.orch/worktree.jsonc', commit: 'abc' },
            recipe: { create: [] },
            allocations: { index: 6, ports: {}, databases: {}, strings: {} },
          }),
        ).lastInsertRowid,
    )
    const turnId = Number(
      database
        .query(
          `INSERT INTO run
           (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_id,turn,parent_run_id)
           VALUES (?,'codex','implement','sha',1,'resume','running',?,2,?)`,
        )
        .run(nowIso(), projectId, rootId).lastInsertRowid,
    )

    expect(trackedRecipeEnvironment(turnId)).toMatchObject({
      ORCH_RUN_LABEL: `orch.run=${rootId}`,
      ORCH_INDEX: '6',
    })
    expect(turnId).not.toBe(rootId)
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

  test('catches rendering tree_exists=false while teardown still runs in the present tree', () => {
    const seen: { treeRoot: string; treeExists: string | undefined }[] = []
    const snapshot: RecipeSnapshot = {
      source: { path: '.orch/worktree.jsonc', commit: 'abc' },
      recipe: { create: [], destroy: [step('destroy')] },
    }
    teardownTrackedRecipe(
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
        remove: () => ({ removed: true, detail: '/tree' }),
      },
      (_item, stepContext) => {
        seen.push({ treeRoot: stepContext.treeRoot, treeExists: stepContext.vars.tree_exists })
        return result('destroy', 'run', false)
      },
    )
    expect(seen).toEqual([{ treeRoot: '/tree', treeExists: 'true' }])
  })

  test('a missing-tree teardown uses a temporary cwd and keeps the recorded tree variables', () => {
    const seen: { treeRoot: string; treeExists: string | undefined }[] = []
    const snapshot: RecipeSnapshot = {
      source: { path: '.orch/worktree.jsonc', commit: 'abc' },
      recipe: { create: [], destroy: [step('destroy')] },
    }
    teardownTrackedRecipe(
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
        treeExists: false,
        remove: () => ({ removed: true, detail: '/tree' }),
      },
      (_item, stepContext) => {
        seen.push({ treeRoot: stepContext.treeRoot, treeExists: stepContext.vars.tree_exists })
        return result('destroy', 'run', false)
      },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]!.treeRoot).not.toBe('/main')
    expect(seen[0]!.treeRoot).not.toBe('/tree')
    expect(seen[0]!.treeExists).toBe('false')
    expect(existsSync(seen[0]!.treeRoot)).toBeFalse()
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

describe('tracked recipe env writes', () => {
  test('fills every allocation family and index', () => {
    const { project, tree } = temporaryTree()
    const recipe: TrackedRecipe = {
      create: [],
      env: [
        {
          path: '.env',
          mode: 'replace',
          contents: '{index}|{ports.web}|{db.app}|{alloc.cookie}',
        },
      ],
    }
    expect(
      writeEnv(recipe, tree, project, {
        index: '4',
        'ports.web': '21004',
        'db.app': 'app_4',
        'alloc.cookie': 'tree-4',
      }),
    ).toBeNull()
    expect(readFileSync(join(tree, '.env'), 'utf8')).toBe('4|21004|app_4|tree-4')
  })

  test('a missing placeholder refuses before touching the target', () => {
    const { project, tree } = temporaryTree()
    const target = join(tree, '.env')
    writeFileSync(target, 'old-secret')
    const failure = writeEnv(
      { create: [], env: [{ path: '.env', mode: 'replace', contents: '{ports.missing}' }] },
      tree,
      project,
    )
    expect(failure?.detail).toContain('unavailable placeholder {ports.missing}')
    expect(readFileSync(target, 'utf8')).toBe('old-secret')
  })

  test('preflights every placeholder before writing an earlier declared file', () => {
    const { project, tree } = temporaryTree()
    const failure = writeEnv(
      {
        create: [],
        env: [
          { path: '.first', mode: 'replace', contents: 'FIRST=yes' },
          { path: '.second', mode: 'replace', contents: '{db.missing}' },
        ],
      },
      tree,
      project,
    )
    expect(failure?.detail).toContain('unavailable placeholder {db.missing}')
    expect(() => statSync(join(tree, '.first'))).toThrow()
  })

  test('inherits from the project and omits selected assignments', () => {
    const { project, tree } = temporaryTree()
    writeFileSync(join(project, '.env.main'), 'KEEP=yes\nDROP=secret\n')
    expect(
      writeEnv(
        {
          create: [],
          env: [
            {
              path: '.env',
              inherit: '.env.main',
              omit: ['DROP'],
              mode: 'append',
              contents: 'TREE=yes\n',
            },
          ],
        },
        tree,
        project,
      ),
    ).toBeNull()
    expect(readFileSync(join(tree, '.env'), 'utf8')).toBe('KEEP=yes\nTREE=yes\n')
  })

  test('refuses a missing inherited file without creating the target', () => {
    const { project, tree } = temporaryTree()
    const failure = writeEnv(
      {
        create: [],
        env: [{ path: '.env', inherit: '.env.missing', contents: 'TREE=yes' }],
      },
      tree,
      project,
    )
    expect(failure?.detail).toContain('could not read inherited path ".env.missing"')
    expect(() => statSync(join(tree, '.env'))).toThrow()
  })

  test('creates a new file as 0600 and preserves an existing 0644 mode', () => {
    const { project, tree } = temporaryTree()
    const fresh = join(tree, '.fresh')
    const existing = join(tree, '.existing')
    writeFileSync(existing, 'old')
    chmodSync(existing, 0o644)
    expect(
      writeEnv(
        {
          create: [],
          env: [
            { path: '.fresh', mode: 'replace', contents: 'fresh' },
            { path: '.existing', mode: 'replace', contents: 'new' },
          ],
        },
        tree,
        project,
      ),
    ).toBeNull()
    expect(statSync(fresh).mode & 0o777).toBe(0o600)
    expect(statSync(existing).mode & 0o777).toBe(0o644)
  })

  test('a refusing plan leaves the existing target intact', () => {
    const { project, tree } = temporaryTree()
    const target = join(tree, '.env')
    const old = '# >>> orch-worktree tree-name\nold-secret'
    writeFileSync(target, old)
    const failure = writeEnv(
      { create: [], env: [{ path: '.env', contents: 'NEW=yes' }] },
      tree,
      project,
    )
    expect(failure?.detail).toContain('line 1')
    expect(failure?.detail).toContain('.env')
    expect(readFileSync(target, 'utf8')).toBe(old)
  })
})
