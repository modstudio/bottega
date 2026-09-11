import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { appendFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, createWorktree, db, dir, fakeDocker, hermeticGitEnv, nowIso, prepareSharedRefGuard, upsertProject, worktreeDescribeFixture } from '../test/fixture.ts'
import { discardRun, resourcesForConversation } from './cleanup.ts'

const presentation = {
  log: () => {}, error: () => {}, setExitCode: () => {},
  keptBranchLine: (branch: string) => `kept branch ${branch}`,
}
const { git, scratchRepo, markScratchRepoOwner } = worktreeDescribeFixture()
let priorSession: string | undefined
beforeEach(() => { priorSession = process.env.CLAUDE_CODE_SESSION_ID; process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session' })
afterEach(() => {
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
})
async function discard(id: number, force = true, containers: string[] = []) {
  const logs: string[] = []; const errors: string[] = []; let exitCode = 0
  const docker = fakeDocker(containers, []); const priorPath = process.env.PATH
  const priorContainers = process.env.FAKE_DOCKER_CONTAINERS; const priorVolumes = process.env.FAKE_DOCKER_VOLUMES
  Object.assign(process.env, docker.env)
  const originalSpawn = Bun.spawnSync
  const spawned = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[], options: any) =>
    cmd[0] === 'docker' ? originalSpawn([join(docker.dir, 'docker'), ...cmd.slice(1)], { ...options, env: { ...process.env, ...docker.env } }) : originalSpawn(cmd, options)) as typeof Bun.spawnSync)
  try {
    await discardRun(id, { force, auditReason: null, presentation: {
      log: (...values) => logs.push(values.join(' ')), error: (...values) => errors.push(values.join(' ')),
      setExitCode: (code) => { exitCode = code }, keptBranchLine: (branch) => `kept branch ${branch}`,
    } })
    return { ok: exitCode === 0, logs, errors, error: null as Error | null }
  } catch (error) { return { ok: false, logs, errors, error: error as Error } }
  finally {
    spawned.mockRestore()
    process.env.PATH = priorPath
    if (priorContainers === undefined) delete process.env.FAKE_DOCKER_CONTAINERS; else process.env.FAKE_DOCKER_CONTAINERS = priorContainers
    if (priorVolumes === undefined) delete process.env.FAKE_DOCKER_VOLUMES; else process.env.FAKE_DOCKER_VOLUMES = priorVolumes
    rmSync(docker.dir, { recursive: true, force: true })
  }
}

test('discard resolves a child to its root owner before filesystem mutation', async () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'other-session' })
  const child = addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: root, turn: 2 })
  const path = `${dir}/foreign-owned-worktree`
  db().query('UPDATE run SET worktree=? WHERE id=?').run(path, child)
  await expect(discardRun(child, { force: true, auditReason: null, presentation }))
    .rejects.toThrow(`run ${child} is owned by session other-session`)
  expect(db().query('SELECT worktree FROM run WHERE id=?').get(child)).toEqual({ worktree: path })
  expect(db().query('SELECT COUNT(*) n FROM run_mutation_audit').get()).toEqual({ n: 0 })
})

test('discarding a child cleans the root-owned worktree and every chain pointer', async () => {
  const { repo, tree } = scratchRepo(); const root = addRun({ agent: 'codex', job: 'implement', session: 'orch-test-session' })
  const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2, session: 'other-turn' })
  appendFileSync(join(repo, '.git', 'info', 'exclude'), '.orch-run\n')
  writeFileSync(join(tree, '.orch-run'), `${root}\n${repo}\nsource: git\n`)
  const guard = prepareSharedRefGuard(tree, 'refs/heads/AB-2581')
  db().query('UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=? WHERE id IN (?,?)').run(repo, tree, 'AB-2581', git(repo, 'rev-parse', 'main'), root, child)
  try {
    const result = await discard(child); expect(result.ok, result.error?.message).toBe(true); expect(existsSync(tree)).toBe(false)
    expect(existsSync(guard.GIT_CONFIG_VALUE_0)).toBe(false)
    expect(db().query('SELECT id,worktree FROM run WHERE id IN (?,?) ORDER BY id').all(root, child)).toEqual([{ id: root, worktree: null }, { id: child, worktree: null }])
    expect(db().query('SELECT run_id,root_id,action FROM run_mutation_audit').get()).toEqual({ run_id: child, root_id: root, action: 'discard' })
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('a sibling pointer blocks destructive discard regardless of terminal or score state', async () => {
  const { repo, tree } = scratchRepo(); const root = addRun({ agent: 'codex', job: 'implement' })
  const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
  const sibling = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const base = git(repo, 'rev-parse', 'main')
  db().query('UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=? WHERE id IN (?,?)').run(repo, tree, 'AB-2581', base, root, child)
  db().query('UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=? WHERE id=?').run(repo, `${tree}/`, 'AB-2581', base, sibling)
  try {
    const result = await discard(child); expect(result.ok).toBe(false); expect(result.error?.message).toContain(`run ${sibling} is failed and unscored`)
    expect(existsSync(tree)).toBe(true)
    expect(db().query('SELECT id,worktree FROM run WHERE id IN (?,?,?) ORDER BY id').all(root, child, sibling)).toEqual([{ id: root, worktree: null }, { id: child, worktree: null }, { id: sibling, worktree: `${tree}/` }])
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('discard uses a registered project remove template', async () => {
  const { repo } = scratchRepo(); const tree = createWorktree(repo, 880)
  const argvFile = join(repo, 'remove-argv.txt'); const script = join(repo, 'fake-remove.sh')
  writeFileSync(script, `printf '%s\n' "$@" > ${JSON.stringify(argvFile)}\ngit worktree remove --force "$1"\ngit branch -D "$2"\n`)
  upsertProject({ name: 'remove-tool', path: realpathSync(repo), settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } } })
  const id = addRun({ agent: 'codex', job: 'implement' }); db().query('UPDATE run SET worktree=?,branch=?,minted_branch=? WHERE id=?').run(tree.path, tree.branch, tree.branch, id)
  try {
    expect((await discard(id)).ok).toBe(true)
    expect(readFileSync(argvFile, 'utf8').trim().split('\n')).toEqual([tree.path, tree.branch])
    expect(existsSync(tree.path)).toBe(false)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('discard surfaces a registered project remove refusal', async () => {
  const { repo } = scratchRepo(); const tree = createWorktree(repo, 881)
  upsertProject({ name: 'refusing-tool', path: realpathSync(repo), settings: { trunk: 'main', worktree: { remove: "echo 'protected work' >&2; exit 7" } } })
  const id = addRun({ agent: 'codex', job: 'implement' }); db().query('UPDATE run SET worktree=?,branch=?,minted_branch=? WHERE id=?').run(tree.path, tree.branch, tree.branch, id)
  try {
    const result = await discard(id, false); expect(result.ok).toBe(false); expect(result.error?.message).toContain('protected work')
    expect(result.error?.message).toContain("--force will not override a project tool's refusal")
    expect(existsSync(tree.path)).toBe(true)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('discard treats a no-verdict void as a shared pointer until it is cleared', async () => {
  const { repo } = scratchRepo(); const target = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const voided = addRun({ agent: 'codex', job: 'understand', status: 'ok' }); const tree = createWorktree(repo, target)
  db().query('UPDATE run SET cwd=?,worktree=?,branch=? WHERE id=?').run(repo, tree.path, tree.branch, target)
  db().query('UPDATE run SET cwd=?,worktree=?,branch=?,evidence_excluded=? WHERE id=?').run(repo, tree.path, tree.branch, 'voided', voided)
  try {
    const result = await discard(target); expect(result.ok).toBe(false); expect(result.error?.message).toContain(`run ${voided} is ok`)
    expect(existsSync(tree.path)).toBe(true)
    expect(db().query('SELECT id,worktree FROM run WHERE id IN (?,?) ORDER BY id').all(target, voided)).toEqual([{ id: target, worktree: null }, { id: voided, worktree: tree.path }])
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('discard reclaims one scored multi-turn conversation', async () => {
  const { repo } = scratchRepo(); upsertProject({ name: 'conversation', path: realpathSync(repo), settings: { trunk: 'main' } })
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: 'conversation' }); const child = addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: root, turn: 2, repo: 'conversation' })
  const tree = createWorktree(repo, root); db().query("INSERT INTO score(run_id,delivery,quality,fidelity,scored_at) VALUES (?,'full','right','faithful',?)").run(root, nowIso())
  for (const id of [root, child]) db().query("UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=?,worktree_source='git' WHERE id=?").run(tree.path, tree.path, tree.branch, tree.branch, tree.base, id)
  try { expect((await discard(root)).ok).toBe(true); expect(existsSync(tree.path)).toBe(false); expect(db().query('SELECT worktree FROM run WHERE id IN (?,?)').all(root, child)).toEqual([{ worktree: null }, { worktree: null }]) }
  finally { rmSync(repo, { recursive: true, force: true }) }
})

test('discard through a child reports Docker resources named for its conversation root', async () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok' }); const child = addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: root, turn: 2 }); const container = `orch-${root}-postgres-1`; const docker = fakeDocker([container], [])
  const original = Bun.spawnSync; const prior = { path: process.env.PATH, containers: process.env.FAKE_DOCKER_CONTAINERS, volumes: process.env.FAKE_DOCKER_VOLUMES }; Object.assign(process.env, docker.env)
  const spawned = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[], options: any) => cmd[0] === 'docker' ? original([join(docker.dir, 'docker'), ...cmd.slice(1)], { ...options, env: { ...process.env, ...docker.env } }) : original(cmd, options)) as typeof Bun.spawnSync)
  try { expect(resourcesForConversation(child)).toEqual({ ascertainable: true, resources: [{ kind: 'container', name: container, runId: root }] }) }
  finally { spawned.mockRestore(); process.env.PATH = prior.path; if (prior.containers === undefined) delete process.env.FAKE_DOCKER_CONTAINERS; else process.env.FAKE_DOCKER_CONTAINERS = prior.containers; if (prior.volumes === undefined) delete process.env.FAKE_DOCKER_VOLUMES; else process.env.FAKE_DOCKER_VOLUMES = prior.volumes; rmSync(docker.dir, { recursive: true, force: true }) }
})

test('a successful project tool deletes an unchanged disposable branch for an already-gone tree', async () => {
  const { repo } = scratchRepo(); const project = `branch-postcondition-${Date.now()}`; const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: project })
  const tree = createWorktree(repo, id); git(repo, 'worktree', 'remove', '--force', tree.path)
  upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main', worktree: { remove: 'true' } } })
  db().query('UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=? WHERE id=?').run(repo, tree.path, tree.branch, tree.branch, tree.base, id)
  try { expect((await discard(id, false)).ok).toBe(true); expect(git(repo, 'branch', '--list', tree.branch)).toBe(''); expect(db().query('SELECT worktree FROM run WHERE id=?').get(id)).toEqual({ worktree: null }) }
  finally { rmSync(repo, { recursive: true, force: true }) }
})

test('a successful project tool retains and reports a uniquely-committed branch', async () => {
  const { repo } = scratchRepo(); const project = `unique-postcondition-${Date.now()}`; const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: project })
  const tree = createWorktree(repo, id); writeFileSync(join(tree.path, 'unique.txt'), 'keep\n'); git(tree.path, 'add', '.'); git(tree.path, 'commit', '-m', 'unique'); const tip = git(tree.path, 'rev-parse', 'HEAD'); git(repo, 'worktree', 'remove', '--force', tree.path)
  upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main', worktree: { remove: 'true' } } }); db().query('UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=? WHERE id=?').run(repo, tree.path, tree.branch, tree.branch, tree.base, id)
  try { const result = await discard(id, false); expect(result.ok).toBe(true); expect(git(repo, 'rev-parse', tree.branch)).toBe(tip); expect(result.logs.join('\n')).toContain(`kept branch ${tree.branch}`); expect(db().query('SELECT worktree,branch_kept FROM run WHERE id=?').get(id)).toEqual({ worktree: null, branch_kept: tree.branch }) }
  finally { rmSync(repo, { recursive: true, force: true }) }
})

test('a successful project tool refuses an unprotected branch moved during teardown', async () => {
  const { repo } = scratchRepo(); const project = `moved-postcondition-${Date.now()}`; const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: project })
  const tree = createWorktree(repo, id); git(repo, 'worktree', 'remove', '--force', tree.path); git(repo, 'checkout', '-b', 'later'); writeFileSync(join(repo, 'later'), 'later\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'later'); const later = git(repo, 'rev-parse', 'HEAD'); git(repo, 'checkout', 'main')
  const script = join(repo, 'move.sh'); writeFileSync(script, `git update-ref "refs/heads/$1" "${later}"\n`)
  upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main', worktree: { remove: `sh "${script}" {branch}` } } }); db().query('UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=? WHERE id=?').run(repo, tree.path, tree.branch, tree.branch, tree.base, id)
  try { const result = await discard(id, false); expect(result.ok).toBe(false); expect(result.error?.message).toContain(`moved unprotected branch ${tree.branch}`); expect(result.error?.message).toContain(later); expect(git(repo, 'rev-parse', tree.branch)).toBe(later) }
  finally { rmSync(repo, { recursive: true, force: true }) }
})

test('discarding an attacher releases its pointer before the scored owner may remove the tree', async () => {
  const { repo, tree } = scratchRepo(); const project = `attacher-${Date.now()}`; const remove = join(repo, 'remove.sh')
  writeFileSync(remove, '#!/bin/sh\ngit worktree remove --force "$1"\ngit branch -D "$2"\n')
  upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main', worktree: { remove: `sh "${remove}" {path} {branch}` } } })
  const owner = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project }); const attacher = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project }); markScratchRepoOwner(repo, tree, owner)
  db().query("INSERT INTO score(run_id,delivery,quality,fidelity,scored_at) VALUES (?,'full','right','faithful',?)").run(owner, nowIso()); const base = git(repo, 'rev-parse', 'main')
  db().query("UPDATE run SET cwd=?,worktree=?,branch='AB-2581',minted_branch='AB-2581',base_commit=?,worktree_source='recipe' WHERE id=?").run(tree, tree, base, owner)
  db().query("UPDATE run SET cwd=?,worktree=?,branch='AB-2581',minted_branch=NULL,base_commit=?,worktree_source='recipe' WHERE id=?").run(tree, tree, base, attacher)
  try {
    const released = await discard(attacher); expect(released.ok).toBe(false); expect(released.error?.message).toContain(`run ${owner}`)
    expect(db().query('SELECT id,worktree FROM run WHERE id IN (?,?) ORDER BY id').all(owner, attacher)).toEqual([{ id: owner, worktree: tree }, { id: attacher, worktree: null }])
    expect((await discard(owner)).ok).toBe(true); expect(existsSync(tree)).toBe(false); expect(git(repo, 'branch', '--list', 'AB-2581')).toBe('')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('discarding an attacher never transfers the marker owner minted branch', async () => {
  const { repo, tree } = scratchRepo(); const project = `marker-attacher-${Date.now()}`
  const remove = join(repo, 'remove-marker.sh'); writeFileSync(remove, '#!/bin/sh\ngit worktree remove --force "$1"\ngit branch -D "$2"\n')
  upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main', worktree: { remove: `sh "${remove}" {path} {branch}` } } })
  const owner = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project }); const attacher = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project }); const base = git(repo, 'rev-parse', 'main')
  db().query("UPDATE run SET cwd=?,worktree=NULL,branch='AB-2581',minted_branch='AB-2581',base_commit=?,worktree_source='recipe' WHERE id=?").run(tree, base, owner)
  db().query("UPDATE run SET cwd=?,worktree=?,branch='AB-2581',minted_branch=NULL,base_commit=?,worktree_source='recipe' WHERE id=?").run(tree, tree, base, attacher); markScratchRepoOwner(repo, tree, owner)
  try { const result = await discard(attacher); expect(result.ok).toBe(false); expect(git(repo, 'branch', '--list', 'AB-2581')).toBe('AB-2581'); expect(result.error?.message).toContain("branch '' not found") }
  finally { rmSync(repo, { recursive: true, force: true }) }
})

test('discard accepts branch deletion after every prior owner releases it', async () => {
  const { repo } = scratchRepo(); const project = `released-ref-${Date.now()}`; const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project }); const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project }); const tree = createWorktree(repo, target)
  const release = join(repo, 'release.ts'); writeFileSync(release, `import { Database } from 'bun:sqlite'\nconst d=new Database(process.env.ORCH_DB!)\nd.query("UPDATE run SET status='ok' WHERE id=?").run(${owner})\nd.query("INSERT INTO score(run_id,delivery,quality,fidelity,scored_at) VALUES (?,'full','right','faithful',?)").run(${owner},new Date().toISOString())\n`)
  const script = join(repo, 'release-remove.sh'); writeFileSync(script, `"${process.execPath}" "${release}"\ngit worktree remove --force "$1"\ngit branch -D "$2"\n`)
  upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } } }); db().query('UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=? WHERE id=?').run(repo, tree.path, tree.branch, tree.branch, target); db().query('UPDATE run SET cwd=?,branch=? WHERE id=?').run(repo, tree.branch, owner)
  try { expect((await discard(target, false)).ok).toBe(true); expect(git(repo, 'branch', '--list', tree.branch)).toBe(''); expect(db().query('SELECT worktree,branch_kept FROM run WHERE id=?').get(target)).toEqual({ worktree: null, branch_kept: null }); expect(db().query('SELECT status FROM run WHERE id=?').get(owner)).toEqual({ status: 'ok' }) }
  finally { rmSync(repo, { recursive: true, force: true }) }
})

test('discard leaves a concurrent shared-branch advance at its new tip', async () => {
  const { repo } = scratchRepo(); const project = `advanced-ref-${Date.now()}`; const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project }); const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project }); const branch = `orch/${target}`; const tree = join(repo, '.claude', 'worktrees', `orch-${target}`); const before = git(repo, 'rev-parse', 'main')
  git(repo, 'checkout', '-b', 'later'); writeFileSync(join(repo, 'later'), 'later\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'later'); const after = git(repo, 'rev-parse', 'HEAD'); git(repo, 'checkout', 'main'); git(repo, 'branch', '-D', 'later'); git(repo, 'worktree', 'add', '-b', branch, tree, 'main')
  const script = join(repo, 'advance.sh'); writeFileSync(script, `git update-ref "refs/heads/$2" "${after}"\ngit worktree remove --force "$1"\n`)
  upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } } }); db().query('UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=? WHERE id=?').run(repo, tree, branch, branch, target); db().query('UPDATE run SET cwd=?,branch=? WHERE id=?').run(repo, branch, owner)
  try { const result = await discard(target); expect(result.ok).toBe(false); expect(result.error?.message).toContain(`shared branch ${branch} moved from ${before} to ${after}`); expect(result.error?.message).toContain(`run ${owner} owns it`); expect(git(repo, 'rev-parse', branch)).toBe(after) }
  finally { rmSync(repo, { recursive: true, force: true }) }
})

test('discard refuses when another run acquires the branch during the remove tool', async () => {
  const { repo } = scratchRepo(); const project = `acquired-ref-${Date.now()}`; const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project }); const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project }); const tree = createWorktree(repo, target); const tip = git(repo, 'rev-parse', tree.branch)
  const assign = join(repo, 'assign.ts'); writeFileSync(assign, `import { Database } from 'bun:sqlite'\nnew Database(process.env.ORCH_DB!).query('UPDATE run SET branch=? WHERE id=?').run(process.argv[2]!,${owner})\n`)
  const script = join(repo, 'assign-remove.sh'); writeFileSync(script, `"${process.execPath}" "${assign}" "$2"\ngit worktree remove --force "$1"\ngit branch -D "$2"\n`)
  upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } } }); db().query('UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=? WHERE id=?').run(repo, tree.path, tree.branch, tree.branch, target); db().query('UPDATE run SET cwd=? WHERE id=?').run(repo, owner)
  try { const result = await discard(target); expect(result.ok).toBe(false); expect(result.error?.message).toContain(`Run ${owner} acquired branch ${tree.branch} during cleanup`); expect(result.error?.message).toContain(`restored ${tip}`); expect(git(repo, 'rev-parse', tree.branch)).toBe(tip); expect(db().query('SELECT branch FROM run WHERE id=?').get(owner)).toEqual({ branch: tree.branch }) }
  finally { rmSync(repo, { recursive: true, force: true }) }
})

test('a failed unscored run does not pin a branch whose patch is already on trunk', async () => {
  const { repo, tree } = scratchRepo(); writeFileSync(join(tree, 'landed.txt'), 'landed\n'); git(tree, 'add', '.'); git(tree, 'commit', '-m', 'landed'); writeFileSync(join(repo, 'other'), 'other\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'other'); git(repo, 'cherry-pick', 'AB-2581')
  upsertProject({ name: 'landed-failed-pin', path: repo, settings: { trunk: 'main' } }); const root = addRun({ agent: 'codex', job: 'implement', session: 'orch-test-session' }); const failed = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  db().query('UPDATE run SET repo=?,cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=? WHERE id=?').run('landed-failed-pin', tree, tree, 'AB-2581', 'AB-2581', git(repo, 'rev-parse', 'main'), root); db().query('UPDATE run SET repo=?,cwd=?,branch=? WHERE id=?').run('landed-failed-pin', repo, 'AB-2581', failed)
  try { expect((await discard(root)).ok).toBe(true); expect(existsSync(tree)).toBe(false); expect(Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', 'refs/heads/AB-2581'], { cwd: repo, env: hermeticGitEnv() }).exitCode).not.toBe(0) }
  finally { rmSync(repo, { recursive: true, force: true }) }
})

test.each(['discard', 'abandon'] as const)('%s refuses finalization when a run acquires the worktree during removal', async (cleanup) => {
  const { repo } = scratchRepo(); const project = `${cleanup}-acquired-${Date.now()}`; const target = addRun({ agent: 'codex', job: 'implement', status: cleanup === 'abandon' ? 'asking' : 'ok', repo: project }); const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project }); const tree = createWorktree(repo, target)
  const assign = join(repo, 'assign-tree.ts'); writeFileSync(assign, `import { Database } from 'bun:sqlite'\nnew Database(process.env.ORCH_DB!).query('UPDATE run SET worktree=? WHERE id=?').run(process.argv[2]!,${owner})\n`)
  const script = join(repo, 'assign-remove.sh'); writeFileSync(script, `"${process.execPath}" "${assign}" "$1"\ngit worktree remove --force "$1"\ngit branch -D "$2"\n`)
  upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } } }); db().query("UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=?,worktree_source='recipe' WHERE id=?").run(repo, tree.path, tree.branch, tree.branch, tree.base, target); db().query('UPDATE run SET cwd=? WHERE id=?').run(repo, owner)
  try { const result = await discard(target); expect(result.ok).toBe(false); expect(result.error?.message).toContain(String(owner)); expect(result.error?.message).toContain(`another conversation claimed ${tree.path} during cleanup`); expect(existsSync(tree.path)).toBe(false); expect(db().query('SELECT worktree FROM run WHERE id=?').get(owner)).toEqual({ worktree: tree.path }); expect(db().query('SELECT worktree FROM run WHERE id=?').get(target)).toEqual({ worktree: tree.path }) }
  finally { rmSync(repo, { recursive: true, force: true }) }
})
