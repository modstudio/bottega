import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db, nowIso } from '../database/db.ts'
import { branchOf, git } from '../git/git-environment.ts'
import { upsertProject } from '../project/projects.ts'
import { prepareChainTreeAttachment, refuseMissingChainTreeDatabase } from './chain-tree-service.ts'
import { claimRun } from './run-claim.ts'
import { runProjectAttribution } from './run-project-attribution.ts'

const trackResidue = trackedTestResidue()
const priorEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  priorEnv.CLAUDE_CODE_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID
  priorEnv.BOTTEGA_DEPTH = process.env.BOTTEGA_DEPTH
  priorEnv.BOTTEGA_EXEC_PATH = process.env.BOTTEGA_EXEC_PATH
  process.env.CLAUDE_CODE_SESSION_ID = 'chain-tree-service-test'
  delete process.env.BOTTEGA_DEPTH
  process.env.BOTTEGA_EXEC_PATH = '/usr/bin/true'
})

afterEach(() => {
  for (const [name, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('continue attaches an earlier detached chain tree and records it on the new turn', async () => {
  const repository = trackResidue(join(dir, `chain-tree-repo-${newRecordId()}`))
  const earlierTree = trackResidue(join(dir, `chain-tree-held-${newRecordId()}`))
  const missingLatestTree = join(dir, `chain-tree-gone-${newRecordId()}`)
  const branch = 'DEV-2644-chain-tree'
  mkdirSync(repository)
  git(['init', '-b', 'main'], repository)
  git(['config', 'user.email', 'fixture@example.test'], repository)
  git(['config', 'user.name', 'Fixture'], repository)
  writeFileSync(join(repository, 'tracked.txt'), 'base\n')
  git(['add', 'tracked.txt'], repository)
  git(['commit', '-qm', 'base'], repository)
  git(['branch', branch], repository)
  git(['worktree', 'add', '-q', earlierTree, branch], repository)
  const tip = git(['rev-parse', 'HEAD'], earlierTree)
  git(['switch', '--detach'], earlierTree)

  const projectId = newRecordId()
  upsertProject({ recordId: projectId, name: 'chain-tree-fixture', path: repository })
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    session: 'chain-tree-service-test',
    repo: 'chain-tree-fixture',
    projectRecordId: projectId,
  })
  const latest = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    parent: root,
    turn: 2,
    session: 'chain-tree-service-test',
    repo: 'chain-tree-fixture',
    projectRecordId: projectId,
  })
  db()
    .query(
      `UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=?,worktree_source='git'
        WHERE record_id=?`,
    )
    .run(earlierTree, earlierTree, branch, tip, root)
  db()
    .query(
      `UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=?,worktree_source='git'
        WHERE record_id=?`,
    )
    .run(missingLatestTree, missingLatestTree, branch, tip, latest)

  const prepared = prepareChainTreeAttachment({
    rootId: root,
    projectPath: repository,
    branch,
    branchTip: tip,
    retryCommand: `${PLATFORM_SLUG} run continue ${root}`,
  })!
  const reserved = addRun({
    agent: '(pending)',
    job: 'implement',
    status: 'running',
    session: 'chain-tree-service-test',
    repo: 'chain-tree-fixture',
    projectRecordId: projectId,
  })
  const prompt = 'continue in the retained tree'
  const claimed = await claimRun({
    opts: {
      job: 'implement',
      reserveId: reserved,
      transport: 'cli',
      resume: {
        kind: 'continue',
        parent: root,
        agent: 'codex',
        turn: 3,
        sessionId: null,
        worktree: prepared.worktree,
        recordedWorktreeOwnerRunId: prepared.ownerRunId,
      },
    },
    runsDir: dir,
    stamp: `chain-tree-claim-${reserved}`,
    name: 'codex',
    generatedSchema: null,
    originalPrompt: prompt,
    prompt,
    callerCwd: earlierTree,
    seed: undefined,
    writesJob: true,
    repoJob: true,
    runProjectName: 'chain-tree-fixture',
    ...runProjectAttribution('chain-tree-fixture'),
    reason: 'test',
    vendorSession: 'vendor-session',
    pack: null,
    mcpRequest: undefined,
    transportName: 'cli',
    a: AGENTS.codex!,
    mcpConnection: null,
    mcpMode: null,
    declaredDeliverables: [],
    timeoutMinutes: undefined,
    timeoutMs: 60_000,
    forbidsRepo: false,
    reviewTarget: null,
    implicitReview: { branch: null, findings: false },
    coverageBase: null,
    readOnlyBase: null,
    deferredCwdMcpPlan: [],
    usingMcp: false,
    startedByUserId: null,
    replySchemaName: 'WORKER_SCHEMA',
    carriedContext: { questionIds: [], attachmentWarnings: [] },
    endpointKeySource: 'project',
    assertDispatchAllowed: () => {},
  })
  const child = db()
    .query('SELECT cwd,worktree,branch,base_commit FROM run WHERE record_id=?')
    .get(claimed.claim.id)
  trackResidue(join(dir, claimed.claim.id))

  expect(branchOf(earlierTree)).toBe(branch)
  expect(child).toMatchObject({
    cwd: earlierTree,
    worktree: earlierTree,
    branch,
    base_commit: tip,
  })
})

test("the latest turn's dirty tree on the branch remains attachable", () => {
  const repository = trackResidue(join(dir, `chain-tree-dirty-repo-${newRecordId()}`))
  const tree = trackResidue(join(dir, `chain-tree-dirty-held-${newRecordId()}`))
  const branch = 'DEV-2644-dirty-tree'
  mkdirSync(repository)
  git(['init', '-b', 'main'], repository)
  git(['config', 'user.email', 'fixture@example.test'], repository)
  git(['config', 'user.name', 'Fixture'], repository)
  writeFileSync(join(repository, 'tracked.txt'), 'base\n')
  git(['add', 'tracked.txt'], repository)
  git(['commit', '-qm', 'base'], repository)
  git(['branch', branch], repository)
  git(['worktree', 'add', '-q', tree, branch], repository)
  writeFileSync(join(tree, 'dirty.txt'), 'uncommitted\n')
  const tip = git(['rev-parse', 'HEAD'], tree)
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  db()
    .query(
      `UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=?,worktree_source='git'
        WHERE record_id=?`,
    )
    .run(tree, tree, branch, tip, root)

  const prepared = prepareChainTreeAttachment({
    rootId: root,
    projectPath: repository,
    branch,
    branchTip: tip,
    retryCommand: `${PLATFORM_SLUG} run continue ${root}`,
  })

  expect(prepared).toMatchObject({ ownerRunId: root, worktree: { path: tree, branch } })
})

test('recreate refuses a held database as leaked state without prescribing cleanup', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const owner = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    parent: root,
    turn: 2,
  })
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
       VALUES (?,?,?,'database','postgres:stopal_orch_3','retained',?)`,
    )
    .run(newRecordId(), root, owner, nowIso())

  expect(() => refuseMissingChainTreeDatabase(root)).toThrow(
    `stopal_orch_3 (owning turn ${owner}, resource_claim state retained)`,
  )
  try {
    refuseMissingChainTreeDatabase(root)
  } catch (error) {
    const message = (error as Error).message
    expect(message).toContain('report to the architect')
    expect(message).not.toMatch(/run (?:discard|close-out)|machine sweep/)
  }
})

test('a dirty detached chain tree with a held database gets the dirty remedy', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const owner = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    parent: root,
    turn: 2,
  })
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
       VALUES (?,?,?,'database','postgres:stopal_orch_3','retained',?)`,
    )
    .run(newRecordId(), root, owner, nowIso())

  expect(() =>
    refuseMissingChainTreeDatabase(root, {
      dirtyTreePath: '/trees/dirty-detached',
      retryCommand: `${PLATFORM_SLUG} run continue ${root}`,
    }),
  ).toThrow(
    `stopal_orch_3 (owning turn ${owner}, resource_claim state retained); ` +
      `commit or discard the uncommitted changes in /trees/dirty-detached`,
  )
})

test('a dirty detached chain tree without a held database does not refuse recreation', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  expect(() =>
    refuseMissingChainTreeDatabase(root, { dirtyTreePath: '/trees/dirty-detached' }),
  ).not.toThrow()
})

test('database collision pre-check is skipped for a recipe that declares reuse', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  db()
    .query('UPDATE run SET recipe_snapshot=? WHERE record_id=?')
    .run(
      JSON.stringify({
        source: { path: `.${PLATFORM_SLUG}/worktree.jsonc`, commit: 'a'.repeat(40) },
        recipe: {
          create: [],
          allocate: {
            databases: {
              app: {
                engine: 'postgres',
                name: 'stopal_orch_3',
                provision: {
                  from: 'stopal_base',
                  connection: { key: 'DATABASE_URL' },
                  reuse: true,
                },
              },
            },
          },
        },
      }),
      root,
    )
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
       VALUES (?,?,?,'database','postgres:stopal_orch_3','retained',?)`,
    )
    .run(newRecordId(), root, root, nowIso())

  expect(() => refuseMissingChainTreeDatabase(root)).not.toThrow()
})
