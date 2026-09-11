import { describe,expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS,addRun,createWorktreeForBranch,db,dir,hermeticGitEnv,installTestProcessInventory,projectAt,resolveTaskBranch,runJob,taskBranchCandidacySql,upsertProject } from '../fixture.ts'
import { stubWorker } from '../stub-worker.ts'

describe('task branch resolution', () => {
const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
const repository = () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-task-branch-'))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    git(repo, 'add', 'tracked.txt')
    git(repo, 'commit', '-m', 'base')
    const name = `task-branch-${randomUUID()}`
    upsertProject({ name, path: repo, settings: { trunk: 'main', keyPrefixes: ['DEV'] } })
    return { repo, project: projectAt(repo)! }
  }
const candidate = (
    repo: string, projectId: number, projectName: string, branch: string,
    key: string, state: { status?: string; voided?: boolean; worktree?: string } = {},
  ) => {
    const id = addRun({ agent: 'codex', job: 'implement', status: state.status ?? 'ok', repo: projectName })
    db().query(
      `UPDATE run SET project_id=?,launch_key=?,branch=?,worktree=?,cwd=?,
                      worktree_source='git',base_commit=?,evidence_excluded=? WHERE id=?`,
    ).run(
      projectId, key, branch, state.worktree ?? null, state.worktree ?? repo,
      git(repo, 'merge-base', 'main', branch), state.voided ? 'voided with orch score --void' : null, id,
    )
    return id
  }
const branchWithCommit = (repo: string, branch: string, file: string, body: string) => {
    const tree = join(repo, '.claude', 'worktrees', branch.replaceAll('/', '-'))
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', branch, tree, 'main')
    writeFileSync(join(tree, file), body)
    git(tree, 'add', file)
    git(tree, 'commit', '-m', branch)
    return tree
  }
test('composes evidence and branch candidacy, then chooses content not present on trunk', () => {
    const { repo, project } = repository()
    try {
      expect(taskBranchCandidacySql('r')).toBe("r.status <> 'stopped'")
      const liveTree = branchWithCommit(repo, 'DEV-440-live', 'live.txt', 'live\n')
      candidate(repo, project.id, project.name, 'DEV-440-live', 'DEV-440', { worktree: liveTree })

      branchWithCommit(repo, 'DEV-440-stopped', 'stopped.txt', 'stopped\n')
      candidate(repo, project.id, project.name, 'DEV-440-stopped', 'DEV-440', { status: 'stopped' })
      branchWithCommit(repo, 'DEV-440-voided', 'voided.txt', 'voided\n')
      candidate(repo, project.id, project.name, 'DEV-440-voided', 'DEV-440', { voided: true })

      const landedTree = branchWithCommit(repo, 'DEV-440-landed', 'landed.txt', 'landed\n')
      candidate(repo, project.id, project.name, 'DEV-440-landed', 'DEV-440')
      writeFileSync(join(repo, 'landed.txt'), 'landed\n')
      git(repo, 'add', 'landed.txt')
      git(repo, 'commit', '-m', 'squash equivalent')

      expect(resolveTaskBranch(repo, 'DEV-440')).toMatchObject({
        branch: 'DEV-440-live',
        worktree: { path: realpathSync(liveTree), mintedBranch: null },
        commitCount: 1,
      })
      expect(git(landedTree, 'branch', '--show-current')).toBe('DEV-440-landed')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
test('refuses multiple content-bearing branches with tips, counts, and commands to clear them', () => {
    const { repo, project } = repository()
    try {
      for (const branch of ['DEV-440-one', 'DEV-440-two']) {
        branchWithCommit(repo, branch, `${branch}.txt`, `${branch}\n`)
        candidate(repo, project.id, project.name, branch, 'DEV-440')
      }
      expect(() => resolveTaskBranch(repo, 'DEV-440')).toThrow(/A task owns one branch/)
      try { resolveTaskBranch(repo, 'DEV-440') } catch (error) {
        const message = String(error)
        expect(message).toContain('DEV-440-one tip ')
        expect(message).toContain('DEV-440-two tip ')
        expect(message).toContain('commits 1')
        expect(message).toContain('orch score ')
        expect(message).toContain('--void --note')
        const command = message.match(/orch score (\d+) --void --note "([^"]+)"/)
        expect(command).not.toBeNull()
        const executed = Bun.spawnSync([
          process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname,
          'score', command![1]!, '--void', '--note', command![2]!,
        ], {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'command-test' },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(executed.exitCode, executed.stderr.toString()).toBe(0)
      }
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
test('treats a divergent two-commit cherry-pick as already represented on trunk', () => {
    const { repo, project } = repository()
    try {
      const tree = branchWithCommit(repo, 'DEV-440-cherry', 'one.txt', 'one\n')
      writeFileSync(join(tree, 'two.txt'), 'two\n')
      git(tree, 'add', 'two.txt')
      git(tree, 'commit', '-m', 'DEV-440 second')
      candidate(repo, project.id, project.name, 'DEV-440-cherry', 'DEV-440')
      writeFileSync(join(repo, 'trunk.txt'), 'divergent\n')
      git(repo, 'add', 'trunk.txt')
      git(repo, 'commit', '-m', 'independent trunk')
      const commits = git(tree, 'rev-list', '--reverse', 'main..DEV-440-cherry').split('\n')
      git(repo, 'cherry-pick', ...commits)
      expect(resolveTaskBranch(repo, 'DEV-440')).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
test('reuses an existing branch in a fresh tree when its retained worktree is gone', () => {
    const { repo, project } = repository()
    try {
      const oldTree = branchWithCommit(repo, 'DEV-440-dangling', 'work.txt', 'work\n')
      candidate(repo, project.id, project.name, 'DEV-440-dangling', 'DEV-440')
      git(repo, 'worktree', 'remove', oldTree)
      expect(resolveTaskBranch(repo, 'DEV-440')).toMatchObject({
        branch: 'DEV-440-dangling', worktree: null,
      })
      const created = createWorktreeForBranch(repo, 440001, 'DEV-440-dangling')
      expect(created).toMatchObject({
        branch: 'DEV-440-dangling', mintedBranch: null,
      })
      expect(git(created.path, 'branch', '--show-current')).toBe('DEV-440-dangling')
      expect(git(repo, 'branch', '--list', '*440001*')).toBe('')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
test('a writer attaches the sole retained task worktree and records that it minted no branch', async () => {
    const { repo, project } = repository()
    const tree = branchWithCommit(repo, 'DEV-440-existing', 'fix.txt', 'fixed\n')
    const attachedTree = realpathSync(tree)
    const attachedTip = git(tree, 'rev-parse', 'HEAD')
    candidate(repo, project.id, project.name, 'DEV-440-existing', 'DEV-440', { worktree: tree })
    const script = stubWorker()
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    const priorDepth = process.env.ORCH_DEPTH
    agent.bin = script
    agent.argv = () => []
    agent.readsOut = false
    process.env.ORCH_DEPTH = '0'
    process.env.ORCH_STUB_REPLY = JSON.stringify({status:'done',summary:'attached',files_changed:[],questions:null,deviations:null,blockers:null,tests:{command:null,ran:false,passed:null,detail:null}})
    installTestProcessInventory({ ascertainable: true, rows: [] })
    try {
      const result = await runJob({
        job: 'implement', prompt: 'continue DEV-440', cwd: tree, base: 'DEV-440-existing',
        key: 'DEV-440', agent: 'codex', noFailover: true,
      })
      expect(db().query(
        `SELECT worktree,branch,minted_branch,worktree_source,base_commit,
                branch_kept,branch_kept_tip FROM run WHERE id=?`,
      ).get(result.id)).toEqual({
        worktree: attachedTree, branch: 'DEV-440-existing',
        minted_branch: null, worktree_source: 'git', base_commit: attachedTip,
        branch_kept: 'DEV-440-existing', branch_kept_tip: attachedTip,
      })
      expect(existsSync(tree)).toBe(false)
      expect(git(repo, 'rev-parse', 'DEV-440-existing')).toBe(attachedTip)
      expect(git(repo, 'branch', '--list', `*${result.id}*`)).toBe('')
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      installTestProcessInventory(null)
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      delete process.env.ORCH_STUB_REPLY
      rmSync(repo, { recursive: true, force: true })
    }
  })
test('recreates a resolved task branch from trunk without suggesting a landing bypass', async () => {
    const { repo, project } = repository()
    const oldTree = branchWithCommit(repo, 'DEV-440-recreate', 'fix.txt', 'fixed\n')
    candidate(repo, project.id, project.name, 'DEV-440-recreate', 'DEV-440')
    git(repo, 'worktree', 'remove', oldTree)
    const script = stubWorker()
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    const priorDepth = process.env.ORCH_DEPTH
    agent.bin = script
    agent.argv = () => []
    agent.readsOut = false
    process.env.ORCH_DEPTH = '0'
    process.env.ORCH_STUB_REPLY = JSON.stringify({status:'done',summary:'recreated',files_changed:[],questions:null,deviations:null,blockers:null,tests:{command:null,ran:false,passed:null,detail:null}})
    try {
      const result = await runJob({
        job: 'implement', prompt: 'continue DEV-440', cwd: repo,
        key: 'DEV-440', agent: 'codex', noFailover: true, keepTree: true,
      })
      expect(result.worktree?.branch).toBe('DEV-440-recreate')
      expect(result.output).not.toContain('git merge --ff-only')
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      delete process.env.ORCH_STUB_REPLY
      rmSync(repo, { recursive: true, force: true })
    }
  })
test('command-backed tooling falls back to creating a new branch', async () => {
    const { repo, project } = repository()
    const foreignObjects = mkdtempSync(join(tmpdir(), 'orch-foreign-objects-'))
    mkdirSync(join(foreignObjects, 'info'), { recursive: true })
    mkdirSync(join(foreignObjects, 'pack'), { recursive: true })
    const oldTree = branchWithCommit(repo, 'DEV-440-command', 'fix.txt', 'fixed\n')
    candidate(repo, project.id, project.name, 'DEV-440-command', 'DEV-440')
    git(repo, 'worktree', 'remove', oldTree)
    const tool = join(repo, 'create-worktree.sh')
    writeFileSync(tool,
      '#!/bin/sh\n' +
      'path=".claude/worktrees/$2"\n' +
      'git worktree add -b "$1" "$path" main >/dev/null\n' +
      'printf "%s\\n" "$path"\n')
    git(repo, 'add', 'create-worktree.sh')
    git(repo, 'commit', '-m', 'add declared tool')
    upsertProject({
      name: project.name, path: repo,
      settings: { trunk: 'main', keyPrefixes: ['DEV'], worktree: {
        create: { command: 'sh', args: [tool, '{branch}', '{name}'] }, branch: 'task/{id}',
      } },
    })
    const script = stubWorker({ commands: [
      'printf "continued\\n" > continued.txt',
      'git add continued.txt',
      'git commit -m continued >/dev/null',
    ] })
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    const priorDepth = process.env.ORCH_DEPTH
    const inheritedGit = {
      object: process.env.GIT_OBJECT_DIRECTORY,
      alternates: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      index: process.env.GIT_INDEX_FILE,
    }
    agent.bin = script
    agent.argv = () => []
    agent.readsOut = false
    process.env.ORCH_DEPTH = '0'
    process.env.GIT_OBJECT_DIRECTORY = foreignObjects
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = foreignObjects
    process.env.GIT_INDEX_FILE = join(foreignObjects, 'index')
    process.env.ORCH_STUB_REPLY = JSON.stringify({status:'done',summary:'new branch',files_changed:['continued.txt'],questions:null,deviations:null,blockers:null,tests:{command:null,ran:false,passed:null,detail:null}})
    try {
      const result = await runJob({
        job: 'implement', prompt: 'continue DEV-440', cwd: repo,
        key: 'DEV-440', agent: 'codex', noFailover: true, keepTree: true,
      })
      expect(result.worktree?.branch).toBe(`task/${result.id}`)
      expect(result.worktree?.branch).not.toBe('DEV-440-command')
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (inheritedGit.object === undefined) delete process.env.GIT_OBJECT_DIRECTORY
      else process.env.GIT_OBJECT_DIRECTORY = inheritedGit.object
      if (inheritedGit.alternates === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
      else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = inheritedGit.alternates
      if (inheritedGit.index === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = inheritedGit.index
      delete process.env.ORCH_STUB_REPLY
      rmSync(repo, { recursive: true, force: true })
      rmSync(foreignObjects, { recursive: true, force: true })
    }
  })
})
