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
import { projectByName, upsertProject } from '../project/projects.ts'
import { continuationChainTree, prepareChainTreeAttachment } from './chain-tree-service.ts'
import { claimRun } from './run-claim.ts'
import { runProjectAttribution } from './run-project-attribution.ts'
import { resolveWritingRetryWorkspace } from './run-retry-workspace.ts'

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

test('an older tree on the branch wins over a newer dirty detached chain tree', () => {
  const repository = trackResidue(join(dir, `chain-tree-order-repo-${newRecordId()}`))
  const olderTree = trackResidue(join(dir, `chain-tree-order-older-${newRecordId()}`))
  const newerTree = trackResidue(join(dir, `chain-tree-order-newer-${newRecordId()}`))
  const branch = 'DEV-2644-chain-tree-order'
  mkdirSync(repository)
  git(['init', '-b', 'main'], repository)
  git(['config', 'user.email', 'fixture@example.test'], repository)
  git(['config', 'user.name', 'Fixture'], repository)
  writeFileSync(join(repository, 'tracked.txt'), 'base\n')
  git(['add', 'tracked.txt'], repository)
  git(['commit', '-qm', 'base'], repository)
  git(['branch', branch], repository)
  git(['worktree', 'add', '-q', olderTree, branch], repository)
  git(['worktree', 'add', '-q', '--detach', newerTree, branch], repository)
  writeFileSync(join(newerTree, 'dirty.txt'), 'uncommitted\n')
  const tip = git(['rev-parse', 'HEAD'], olderTree)
  const projectId = newRecordId()
  const projectName = `chain-tree-order-${newRecordId()}`
  upsertProject({ recordId: projectId, name: projectName, path: repository })
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    repo: projectName,
    projectRecordId: projectId,
  })
  const latest = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    parent: root,
    turn: 2,
    repo: projectName,
    projectRecordId: projectId,
  })
  db()
    .query(
      `UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=?,worktree_source='git' WHERE record_id=?`,
    )
    .run(olderTree, olderTree, branch, tip, root)
  db()
    .query(
      `UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=?,worktree_source='git' WHERE record_id=?`,
    )
    .run(newerTree, newerTree, branch, tip, latest)

  const prepared = prepareChainTreeAttachment({
    rootId: root,
    projectPath: repository,
    branch,
    branchTip: tip,
    retryCommand: `${PLATFORM_SLUG} run continue ${root}`,
  })

  expect(prepared).toMatchObject({ ownerRunId: root, worktree: { path: olderTree, branch } })
  expect(branchOf(olderTree)).toBe(branch)
  expect(branchOf(newerTree)).toBeNull()
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

test('retry refuses a live latest turn on its own recorded tree', () => {
  const repository = trackResidue(join(dir, `chain-tree-live-retry-repo-${newRecordId()}`))
  const tree = trackResidue(join(dir, `chain-tree-live-retry-held-${newRecordId()}`))
  const branch = 'DEV-2644-live-retry'
  mkdirSync(repository)
  git(['init', '-b', 'main'], repository)
  git(['config', 'user.email', 'fixture@example.test'], repository)
  git(['config', 'user.name', 'Fixture'], repository)
  writeFileSync(join(repository, 'tracked.txt'), 'base\n')
  git(['add', 'tracked.txt'], repository)
  git(['commit', '-qm', 'base'], repository)
  git(['branch', branch], repository)
  git(['worktree', 'add', '-q', tree, branch], repository)
  const tip = git(['rev-parse', 'HEAD'], tree)

  const projectId = newRecordId()
  const projectName = `chain-tree-live-retry-${newRecordId()}`
  upsertProject({ recordId: projectId, name: projectName, path: repository })
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'running',
    session: 'chain-tree-service-test',
    repo: projectName,
    projectRecordId: projectId,
  })
  db()
    .query(
      `UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=?,worktree_source='git',pid=?
        WHERE record_id=?`,
    )
    .run(tree, tree, branch, tip, process.pid, root)

  expect(() =>
    resolveWritingRetryWorkspace({
      id: root,
      rootId: root,
      job: 'implement',
      launchKey: 'DEV-2644',
      repo: projectName,
      projectId,
      branchKept: branch,
      branchKeptTip: tip,
      strandedRecordOnly: false,
    }),
  ).toThrow(
    `run ${root} still has a live owner on worktree ${tree}; ` +
      `wait for or stop it, then retry ${PLATFORM_SLUG} run retry ${root}`,
  )
})
test("retry records the live branch tip as an attached tree's base", () => {
  const repository = trackResidue(join(dir, `chain-tree-retry-base-repo-${newRecordId()}`))
  const tree = trackResidue(join(dir, `chain-tree-retry-base-held-${newRecordId()}`))
  const branch = 'DEV-2644-retry-base'
  mkdirSync(repository)
  git(['init', '-b', 'main'], repository)
  git(['config', 'user.email', 'fixture@example.test'], repository)
  git(['config', 'user.name', 'Fixture'], repository)
  writeFileSync(join(repository, 'tracked.txt'), 'base\n')
  git(['add', 'tracked.txt'], repository)
  git(['commit', '-qm', 'base'], repository)
  const recordedBase = git(['rev-parse', 'HEAD'], repository)
  git(['branch', branch], repository)
  git(['worktree', 'add', '-q', tree, branch], repository)
  writeFileSync(join(tree, 'tracked.txt'), 'advanced\n')
  git(['commit', '-qam', 'advance branch'], tree)
  const liveTip = git(['rev-parse', 'HEAD'], tree)

  const projectId = newRecordId()
  const projectName = `chain-tree-retry-base-${newRecordId()}`
  upsertProject({ recordId: projectId, name: projectName, path: repository })
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    session: 'chain-tree-service-test',
    repo: projectName,
    projectRecordId: projectId,
  })
  db()
    .query(
      `UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=?,worktree_source='git'
        WHERE record_id=?`,
    )
    .run(tree, tree, branch, recordedBase, root)

  const workspace = resolveWritingRetryWorkspace({
    id: root,
    rootId: root,
    job: 'implement',
    launchKey: 'DEV-2644',
    repo: projectName,
    projectId,
    branchKept: branch,
    branchKeptTip: recordedBase,
    strandedRecordOnly: false,
  })

  expect(workspace.worktree).toMatchObject({ path: tree, base: liveTip })
})

test('a non-writing continuation does not switch a detached chain tree', () => {
  const repository = trackResidue(join(dir, `chain-tree-reader-repo-${newRecordId()}`))
  const tree = trackResidue(join(dir, `chain-tree-reader-held-${newRecordId()}`))
  const branch = 'DEV-2644-reader'
  mkdirSync(repository)
  git(['init', '-b', 'main'], repository)
  git(['config', 'user.email', 'fixture@example.test'], repository)
  git(['config', 'user.name', 'Fixture'], repository)
  writeFileSync(join(repository, 'tracked.txt'), 'base\n')
  git(['add', 'tracked.txt'], repository)
  git(['commit', '-qm', 'base'], repository)
  git(['branch', branch], repository)
  git(['worktree', 'add', '-q', tree, branch], repository)
  const tip = git(['rev-parse', 'HEAD'], tree)
  git(['switch', '--detach'], tree)

  const projectId = newRecordId()
  const projectName = `chain-tree-reader-${newRecordId()}`
  upsertProject({ recordId: projectId, name: projectName, path: repository })
  const root = addRun({
    agent: 'codex',
    job: 'file-question',
    status: 'failed',
    session: 'chain-tree-service-test',
    repo: projectName,
    projectRecordId: projectId,
  })
  db()
    .query('UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=? WHERE record_id=?')
    .run(tree, tree, branch, tip, root)

  const result = continuationChainTree({
    rootId: root,
    rootBranch: branch,
    rootBranchTip: tip,
    latest: { record_id: root, branch },
    project: projectByName(projectName),
    writesRepo: false,
  })

  expect(result.attachedTree).toBeNull()
  expect(branchOf(tree)).toBeNull()
})

test('a writing continuation refuses leaked database state before recreating a missing tree', () => {
  const repository = trackResidue(join(dir, `chain-tree-missing-repo-${newRecordId()}`))
  const missingTree = join(dir, `chain-tree-missing-${newRecordId()}`)
  const branch = 'DEV-2644-missing-tree'
  mkdirSync(repository)
  git(['init', '-b', 'main'], repository)
  git(['config', 'user.email', 'fixture@example.test'], repository)
  git(['config', 'user.name', 'Fixture'], repository)
  writeFileSync(join(repository, 'tracked.txt'), 'base\n')
  git(['add', 'tracked.txt'], repository)
  git(['commit', '-qm', 'base'], repository)
  git(['branch', branch], repository)
  const tip = git(['rev-parse', branch], repository)
  const projectId = newRecordId()
  const projectName = `chain-tree-missing-${newRecordId()}`
  upsertProject({ recordId: projectId, name: projectName, path: repository })
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    repo: projectName,
    projectRecordId: projectId,
  })
  db()
    .query(
      `UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=?,worktree_source='git' WHERE record_id=?`,
    )
    .run(missingTree, missingTree, branch, tip, root)
  db()
    .query(
      `INSERT INTO resource_claim
     (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
     VALUES (?,?,?,'database','postgres:stopal_orch_3','retained',?)`,
    )
    .run(newRecordId(), root, root, nowIso())

  expect(() =>
    continuationChainTree({
      rootId: root,
      rootBranch: branch,
      rootBranchTip: tip,
      latest: { record_id: root, branch },
      project: projectByName(projectName),
      writesRepo: true,
    }),
  ).toThrow(
    `cannot recreate its missing tree because it still holds database stopal_orch_3 ` +
      `(owning turn ${root}, resource_claim state retained)`,
  )
})
