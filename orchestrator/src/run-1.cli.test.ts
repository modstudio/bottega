import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AGENTS, COULD_NOT_VERIFY_INSTRUCTION, INFRASTRUCTURE_RECOVERY, ImportRefusalError, JOBS, NO_REPO_PREAMBLE, READER_DELIVERABLE_FIRST, READONLY_PREAMBLE, REVIEW_PROVENANCE_INSTRUCTION, REVIEW_SCHEMA, REVIEW_SEVERITY_INSTRUCTION, WORKER_PREAMBLE, addRun, applyImport, baselineForPair, candidates, checkMessages, contractConflicts, createWorktreeForBranch, db, dir, getDoc, hermeticGitEnv, inferredReadOnlyKey, jobBoundInstructionForContract, ledgerRef, listDocRevisions, listDocs, listDoctrineRules, listPairs, listSkips, messageArchitect, messagesForRun, planImport, preflight, projectAt, projects, resolveTaskBranch, runJob, runWithDelayedStdoutReader, score, setDoc, sourceCoverage, taskBranchCandidacySql, upsertProject, weigh } from '../test/fixture.ts'

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
          process.execPath, new URL('cli.ts', import.meta.url).pathname,
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
    candidate(repo, project.id, project.name, 'DEV-440-existing', 'DEV-440', { worktree: tree })
    const script = join(dir, `task-branch-agent-${randomUUID()}.ts`)
    writeFileSync(script, `
      const reply = {status:'done',summary:'attached',files_changed:[],questions:null,deviations:null,blockers:null,tests:{command:null,ran:false,passed:null,detail:null}}
      require('node:fs').writeFileSync(process.env.ORCH_SCRATCH + '/reply.json', JSON.stringify(reply))
    `)
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    const priorDepth = process.env.ORCH_DEPTH
    agent.bin = process.execPath
    agent.argv = () => [script]
    agent.readsOut = false
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'implement', prompt: 'continue DEV-440', cwd: tree, base: 'DEV-440-existing',
        key: 'DEV-440', agent: 'codex', noFailover: true,
      })
      expect(db().query(
        'SELECT worktree,branch,minted_branch,worktree_source,base_commit FROM run WHERE id=?',
      ).get(result.id)).toEqual({
        worktree: realpathSync(tree), branch: 'DEV-440-existing',
        minted_branch: null, worktree_source: 'git', base_commit: git(tree, 'rev-parse', 'HEAD'),
      })
      expect(git(repo, 'branch', '--list', `*${result.id}*`)).toBe('')
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('recreates a resolved task branch from trunk without suggesting a landing bypass', async () => {
    const { repo, project } = repository()
    const oldTree = branchWithCommit(repo, 'DEV-440-recreate', 'fix.txt', 'fixed\n')
    candidate(repo, project.id, project.name, 'DEV-440-recreate', 'DEV-440')
    git(repo, 'worktree', 'remove', oldTree)
    const script = join(dir, `task-branch-recreate-${randomUUID()}.ts`)
    writeFileSync(script, `
      const reply = {status:'done',summary:'recreated',files_changed:[],questions:null,deviations:null,blockers:null,tests:{command:null,ran:false,passed:null,detail:null}}
      require('node:fs').writeFileSync(process.env.ORCH_SCRATCH + '/reply.json', JSON.stringify(reply))
    `)
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    const priorDepth = process.env.ORCH_DEPTH
    agent.bin = process.execPath
    agent.argv = () => [script]
    agent.readsOut = false
    process.env.ORCH_DEPTH = '0'
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
      rmSync(script, { force: true })
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
    const script = join(dir, `task-branch-command-${randomUUID()}.ts`)
    writeFileSync(script, `
      const fs = require('node:fs')
      fs.writeFileSync('continued.txt', 'continued\\n')
      for (const args of [['add', 'continued.txt'], ['commit', '-m', 'continued']]) {
        const git = Bun.spawnSync(['git', ...args], {stdout:'pipe', stderr:'pipe'})
        if (git.exitCode !== 0) throw new Error(git.stderr.toString())
      }
      const reply = {status:'done',summary:'new branch',files_changed:['continued.txt'],questions:null,deviations:null,blockers:null,tests:{command:null,ran:false,passed:null,detail:null}}
      fs.writeFileSync(process.env.ORCH_SCRATCH + '/reply.json', JSON.stringify(reply))
    `)
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    const priorDepth = process.env.ORCH_DEPTH
    const inheritedGit = {
      object: process.env.GIT_OBJECT_DIRECTORY,
      alternates: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      index: process.env.GIT_INDEX_FILE,
    }
    agent.bin = process.execPath
    agent.argv = () => [script]
    agent.readsOut = false
    process.env.ORCH_DEPTH = '0'
    process.env.GIT_OBJECT_DIRECTORY = foreignObjects
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = foreignObjects
    process.env.GIT_INDEX_FILE = join(foreignObjects, 'index')
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
      rmSync(script, { force: true })
      rmSync(repo, { recursive: true, force: true })
      rmSync(foreignObjects, { recursive: true, force: true })
    }
  })

  test('two writer dispatches for one key carry their work on one branch', async () => {
    const { repo } = repository()
    const script = join(dir, `task-branch-two-dispatches-${randomUUID()}.ts`)
    writeFileSync(script, `
      const fs = require('node:fs')
      fs.appendFileSync('dispatch-work.txt', String(Date.now()) + '\\n')
      for (const args of [['add', 'dispatch-work.txt'], ['commit', '-m', 'dispatch work']]) {
        const git = Bun.spawnSync(['git', ...args], {stdout:'pipe', stderr:'pipe'})
        if (git.exitCode !== 0) throw new Error(git.stderr.toString())
      }
      const reply = {status:'done',summary:'committed work',files_changed:['dispatch-work.txt'],questions:null,deviations:null,blockers:null,tests:{command:null,ran:false,passed:null,detail:null}}
      fs.writeFileSync(process.env.ORCH_SCRATCH + '/reply.json', JSON.stringify(reply))
    `)
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    const priorDepth = process.env.ORCH_DEPTH
    agent.bin = process.execPath
    agent.argv = () => [script]
    agent.readsOut = false
    process.env.ORCH_DEPTH = '0'
    try {
      const first = await runJob({
        job: 'implement', prompt: 'start DEV-440', cwd: repo, base: 'main',
        key: 'DEV-440', agent: 'codex', noFailover: true, keepTree: true,
      })
      const firstRow = db().query(
        'SELECT worktree,branch,minted_branch FROM run WHERE id=?',
      ).get(first.id) as { worktree: string; branch: string; minted_branch: string }
      db().query("UPDATE run SET status='ok' WHERE id=?").run(first.id)
      const second = await runJob({
        job: 'implement', prompt: 'continue DEV-440', cwd: firstRow.worktree,
        key: 'DEV-440', agent: 'codex', noFailover: true, keepTree: true,
      })
      expect(db().query(
        'SELECT worktree,branch,minted_branch FROM run WHERE id=?',
      ).get(second.id)).toEqual({
        worktree: firstRow.worktree, branch: firstRow.branch, minted_branch: null,
      })
      expect(git(repo, 'branch', '--format=%(refname:short)')
        .split('\n').filter((branch) => branch !== 'main')).toEqual([firstRow.branch])
      expect(git(firstRow.worktree, 'rev-list', '--count', 'main..HEAD')).toBe('2')
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a writer refuses a task worktree still owned by a concurrent run', async () => {
    const { repo, project } = repository()
    const tree = branchWithCommit(repo, 'DEV-440-busy', 'fix.txt', 'fixed\n')
    const owner = candidate(
      repo, project.id, project.name, 'DEV-440-busy', 'DEV-440',
      { worktree: tree, status: 'running' },
    )
    const script = join(dir, `task-branch-busy-agent-${randomUUID()}.ts`)
    writeFileSync(script, 'throw new Error("agent must not start")\n')
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    const priorDepth = process.env.ORCH_DEPTH
    agent.bin = process.execPath
    agent.argv = () => [script]
    agent.readsOut = false
    process.env.ORCH_DEPTH = '0'
    try {
      await expect(runJob({
        job: 'implement', prompt: 'continue DEV-440', cwd: tree,
        key: 'DEV-440', agent: 'codex', noFailover: true,
      })).rejects.toThrow(`run ${owner} is still using the task branch`)
      await expect(runJob({
        job: 'implement', prompt: 'continue DEV-440', cwd: tree,
        key: 'DEV-440', agent: 'codex', noFailover: true,
      })).rejects.toThrow('Two concurrent runs never share one task branch')
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
      db().query("UPDATE run SET status='stopped' WHERE id=?").run(owner)
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('read-only run task attribution', () => {
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }

  const repository = (branch = 'main') => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-attribution-'))
    git(repo, 'init', '-b', branch)
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
    git(repo, 'add', 'tracked.txt')
    git(repo, 'commit', '-m', 'fixture')
    upsertProject({
      name: `attribution-${randomUUID()}`, path: repo,
      settings: { keyPrefixes: ['DEV'] },
    })
    return repo
  }

  const launch = async (cwd: string, key?: string) => {
    const script = join(dir, `attribution-agent-${randomUUID()}.ts`)
    writeFileSync(script, 'process.stdout.write("attributed")\n')
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    const priorDepth = process.env.ORCH_DEPTH
    agent.bin = process.execPath
    agent.argv = () => [script]
    agent.readsOut = false
    process.env.ORCH_DEPTH = '0'
    try {
      const result = await runJob({
        job: 'file-question', prompt: 'inspect', cwd, key, agent: 'codex', noFailover: true,
      })
      return (db().query('SELECT launch_key FROM run WHERE id=?').get(result.id) as
        { launch_key: string | null }).launch_key
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
    }
  }

  test('records the key carried by the caller worktree name before the branch key', async () => {
    const repo = repository()
    const worktree = join(repo, '.claude', 'worktrees', 'DEV-204-context')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'feature/DEV-205-branch', worktree)
    try {
      expect(inferredReadOnlyKey(worktree)).toBe('DEV-204')
      expect(await launch(worktree)).toBe('DEV-204')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('records the branch key when the checkout name carries none', async () => {
    const repo = repository('feature/DEV-205-branch')
    try {
      expect(inferredReadOnlyKey(repo)).toBe('DEV-205')
      expect(await launch(repo)).toBe('DEV-205')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an explicit key wins over worktree and branch inference', async () => {
    const repo = repository()
    const worktree = join(repo, '.claude', 'worktrees', 'DEV-204-context')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'feature/DEV-205-branch', worktree)
    try { expect(await launch(worktree, 'DEV-206')).toBe('DEV-206') }
    finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a read-only run with no inferable key launches and records null', async () => {
    const repo = repository()
    try {
      expect(inferredReadOnlyKey(repo)).toBeNull()
      expect(await launch(repo)).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an inferred attribution key never satisfies a writing-run branch requirement', () => {
    const repo = repository()
    const worktree = join(repo, '.claude', 'worktrees', 'DEV-204-context')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'feature/no-key', worktree)
    const project = projectAt(repo)!
    upsertProject({
      name: project.name, path: repo,
      settings: { keyPrefixes: ['DEV'], worktree: { branch: '{key}-orch-{id}' } },
    })
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      expect(inferredReadOnlyKey(worktree)).toBe('DEV-204')
      expect(() => preflight('implement', worktree)).toThrow('--key <KEY-123>')
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('run mailbox', () => {
  const mailboxOrchInput = (args: string[], stdin?: string | Uint8Array, extraEnv: Record<string, string> = {}) => {
    const p = Bun.spawnSync([process.execPath, new URL('cli.ts', import.meta.url).pathname, ...args], {
      cwd: dir,
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session', ...extraEnv,
      },
      stdin: stdin === undefined ? undefined
        : typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin,
      stdout: 'pipe', stderr: 'pipe',
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  const mailboxOrch = (...args: string[]) => mailboxOrchInput(args)

  test('queues inbound context and receipts it only when the worker checks', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query('UPDATE run SET vendor_session=?, run_token=? WHERE id=?')
      .run('worker-session', 'token', root)

    const told = mailboxOrch('tell', String(root), 'keep the public shape unchanged')
    expect(told.code).toBe(0)
    expect(told.out).toContain('it has not been read')
    const queued = messagesForRun(root)[0]!
    expect(queued).toMatchObject({
      direction: 'to_worker', root_run_id: root, run_id: root,
      body: 'keep the public shape unchanged', read_at: null, read_by: null,
      delivery: 'architect_cli',
    })

    const read = checkMessages(root)
    expect(read).toHaveLength(1)
    expect(read[0]!.read_at).not.toBeNull()
    expect(read[0]!.read_by).toBe('worker-session')
    expect(checkMessages(root)).toEqual([])
  })

  test('tell authorizes against the root and records the permitted sender', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const child = addRun({ agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2 })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('owner-session', root)
    db().query('UPDATE run SET session_id=? WHERE id=?').run('foreign-session', child)

    const foreign = mailboxOrchInput(['tell', String(child), 'foreign steering'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'foreign-session',
    })
    expect(foreign.code).toBe(1)
    expect(foreign.err).toContain(`run ${child} is owned by session owner-session`)
    expect(messagesForRun(root)).toEqual([])

    const owner = mailboxOrchInput(['tell', String(child), 'owner context'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'owner-session',
    })
    expect(owner.code).toBe(0)
    expect(messagesForRun(root)[0]!.sender_session).toBe('owner-session')
    expect(db().query(
      'SELECT action, actor_session FROM run_mutation_audit WHERE run_id=?',
    ).get(child)).toEqual({ action: 'tell', actor_session: 'owner-session' })
  })

  test('the first tell adopts an unowned root and refuses a second session', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(root)

    const first = mailboxOrchInput(['tell', String(root), 'session A context'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'session-A',
    })
    expect(first.code).toBe(0)
    expect(db().query('SELECT session_id FROM run WHERE id=?').get(root))
      .toEqual({ session_id: 'session-A' })

    const second = mailboxOrchInput(['tell', String(root), 'conflicting session B context'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'session-B',
    })
    expect(second.code).toBe(1)
    expect(second.err).toContain(`run ${root} is owned by session session-A`)
    expect(messagesForRun(root).map((message) => ({ body: message.body, sender: message.sender_session })))
      .toEqual([{ body: 'session A context', sender: 'session-A' }])
    expect(db().query(
      `SELECT action, actor_session, reason FROM run_mutation_audit
        WHERE root_id=? ORDER BY rowid`,
    ).all(root)).toEqual([
      { action: 'adopt', actor_session: 'session-A', reason: 'before tell' },
      { action: 'tell', actor_session: 'session-A', reason: null },
    ])
  })

  test('an unread note stays queued and cannot close an open question', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question)
       VALUES (?, ?, 'which interface?')`,
    ).run(root, new Date().toISOString())

    expect(mailboxOrch('tell', String(root), 'background context only').code).toBe(0)
    expect(messagesForRun(root)[0]!.read_at).toBeNull()
    expect(db().query(
      'SELECT answer, answered_at FROM question WHERE run_id=?',
    ).get(root)).toEqual({ answer: null, answered_at: null })
    expect((db().query('SELECT status FROM run WHERE id=?').get(root) as { status: string }).status)
      .toBe('running')
  })

  test('tell reads long context from a file without shell interpretation', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const path = join(dir, 'mailbox-long-note.txt')
    const body = 'keep `literal` and $VALUE\nsecond paragraph\n'
    writeFileSync(path, body)
    expect(mailboxOrch('tell', String(root), '--file', path).code).toBe(0)
    expect(messagesForRun(root)[0]!.body).toBe(body)
  })

  test('tell refuses a message that is only --file', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const path = join(dir, 'mailbox-dash-token.txt')
    writeFileSync(path, '--file')
    const r = mailboxOrch('tell', String(root), '--file', path)
    expect(r.code).toBe(1)
    expect(r.err).toContain('received "--file" as a message')
    expect(messagesForRun(root)).toEqual([])
  })

  test('tell accepts a two-word message beginning with --', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const r = mailboxOrch('tell', String(root), '--literal is intended')
    expect(r.code).toBe(0)
    expect(messagesForRun(root)[0]!.body).toBe('--literal is intended')
  })

  test('tell --file refuses invalid UTF-8 at the byte offset', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const path = join(dir, 'mailbox-bad-utf8.bin')
    writeFileSync(path, Buffer.from([0x66, 0x80, 0xff, 0x67]))
    const r = mailboxOrch('tell', String(root), '--file', path)
    expect(r.code).toBe(1)
    expect(r.err).toContain('invalid UTF-8')
    expect(r.err).toContain('byte offset 1')
    expect(messagesForRun(root)).toEqual([])
  })

  test('tell stdin refuses invalid UTF-8 at the byte offset', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const r = mailboxOrchInput(['tell', String(root)], Buffer.from([0x66, 0x80, 0xff, 0x67]))
    expect(r.code).toBe(1)
    expect(r.err).toContain('invalid UTF-8')
    expect(r.err).toContain('byte offset 1')
    expect(messagesForRun(root)).toEqual([])
  })

  test('tell keeps flag-shaped words after the message starts', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const r = mailboxOrch('tell', String(root), 'use', '--agent', 'codex', 'exactly')
    expect(r.code).toBe(0)
    expect(messagesForRun(root)[0]!.body).toBe('use --agent codex exactly')
  })

  test('tell stdin refuses whitespace-only input', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const r = mailboxOrchInput(['tell', String(root)], Buffer.from([0x20, 0x09, 0x0d, 0x0a]))
    expect(r.code).toBe(1)
    expect(r.err).toContain('empty message')
    expect(messagesForRun(root)).toEqual([])
  })

  test('tell refuses a message that is only a flag-shaped word', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const r = mailboxOrch('tell', String(root), '--quiet')
    expect(r.code).toBe(1)
    expect(r.err).toContain('received "--quiet" as a message')
    expect(messagesForRun(root)).toEqual([])
  })

  test('run detail is read-only; only the root owner can explicitly receipt worker messages', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const child = addRun({ agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2 })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('session-A', root)
    db().query('UPDATE run SET session_id=?, vendor_session=? WHERE id=?')
      .run('session-B', 'worker-session', child)

    const sent = messageArchitect(child, 'the implementation is taking a narrower shape')
    expect(sent).toMatchObject({
      direction: 'from_worker', root_run_id: root, run_id: child,
      sender_session: 'worker-session', read_at: null, read_by: null, delivery: 'worker_tool',
    })

    const detail = JSON.parse(mailboxOrchInput(['run', String(child)], undefined, {
      CLAUDE_CODE_SESSION_ID: 'session-B',
    }).out)
    expect(detail.messages[0].body).toBe('the implementation is taking a narrower shape')
    expect(messagesForRun(root)[0]).toMatchObject({ read_at: null, read_by: null })

    const foreign = mailboxOrchInput(['run', String(child), '--receipt'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'session-B',
    })
    expect(foreign.code).toBe(1)
    expect(foreign.err).toContain(`run ${child} is owned by session session-A`)
    expect(messagesForRun(root)[0]).toMatchObject({ read_at: null, read_by: null })

    const owner = mailboxOrchInput(['run', String(child), '--receipt'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'session-A',
    })
    expect(owner.code).toBe(0)
    expect(JSON.parse(owner.out).messages[0]).toMatchObject({ read_by: 'session-A' })
    expect(messagesForRun(root)[0]!.read_at).not.toBeNull()
    expect(messagesForRun(root)[0]!.read_by).toBe('session-A')
    expect(db().query('SELECT COUNT(*) n FROM run_mutation_audit').get()).toEqual({ n: 0 })
  }, 20_000)

  test('bridge-only identity cannot receipt an unowned run', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    messageArchitect(root, 'the implementation is taking a narrower shape')
    const result = Bun.spawnSync(
      [process.execPath, new URL('cli.ts', import.meta.url).pathname, 'run', String(root), '--receipt'],
      { cwd: dir, env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_CODE_BRIDGE_SESSION_ID: 'shared-bridge' },
        stdout: 'pipe', stderr: 'pipe' },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(
      `run ${root} is unowned; CLAUDE_CODE_SESSION_ID is not set`,
    )
    expect(messagesForRun(root)[0]).toMatchObject({ read_at: null, read_by: null })
    expect(db().query('SELECT session_id FROM run WHERE id=?').get(root))
      .toEqual({ session_id: null })
    expect(db().query('SELECT COUNT(*) n FROM run_mutation_audit').get()).toEqual({ n: 0 })
  })

  test('the worker MCP tools send outbound and read inbound at a checkpoint', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query('UPDATE run SET vendor_session=?, run_token=? WHERE id=?')
      .run('worker-session', 'mailbox-token', root)
    expect(mailboxOrch('tell', String(root), 'new context').code).toBe(0)
    const calls = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'message_orchestrator', arguments: { body: 'progress without stopping' },
      } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'check_orchestrator_messages', arguments: {},
      } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n'
    const result = mailboxOrchInput(['ask-server'], calls, {
      ORCH_RUN_ID: String(root), ORCH_RUN_TOKEN: 'mailbox-token',
    })
    expect(result.code).toBe(0)
    const replies = result.out.trim().split('\n').map((line) => JSON.parse(line))
    expect(replies[0].result.content[0].text).toContain('Keep working')
    expect(replies[1].result.content[0].text).toContain('[message')
    expect(replies[1].result.content[0].text).toContain('new context')
    expect(replies[1].result.content[0].text).toContain('non-authoritative context')
    expect(messagesForRun(root)).toHaveLength(2)
    expect(messagesForRun(root).find((message) => message.direction === 'to_worker')!.read_at)
      .not.toBeNull()
    expect((db().query('SELECT status FROM run WHERE id=?').get(root) as { status: string }).status)
      .toBe('running')
  })

  test('a resumed turn reads tell queued after the first turn ended', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2,
    })
    db().query('UPDATE run SET vendor_session=?, run_token=? WHERE id=?')
      .run('first-turn-session', 'root-token', root)
    db().query('UPDATE run SET vendor_session=?, run_token=? WHERE id=?')
      .run('resume-session', 'turn-token', child)
    expect(mailboxOrch('tell', String(root), 'note after turn one').code).toBe(0)
    expect(messagesForRun(root)[0]!.read_at).toBeNull()

    const unrecognised = mailboxOrchInput(['ask-server'],
      JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'check_orchestrator_messages', arguments: {},
        },
      }) + '\n',
      { ORCH_RUN_ID: '', ORCH_RUN_TOKEN: '' },
    )
    const unrecognisedReply = JSON.parse(unrecognised.out.trim().split('\n')[0]!)
    expect(unrecognisedReply.result.isError).toBe(true)
    expect(unrecognisedReply.result.content[0].text)
      .toContain('this process is not a recognised orchestrator worker')
    expect(messagesForRun(root)[0]!.read_at).toBeNull()

    const resumed = mailboxOrchInput(['ask-server'],
      JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'check_orchestrator_messages', arguments: {},
        },
      }) + '\n',
      { ORCH_RUN_ID: String(child), ORCH_RUN_TOKEN: 'turn-token' },
    )
    expect(resumed.code).toBe(0)
    const resumedReply = JSON.parse(resumed.out.trim().split('\n')[0]!)
    expect(resumedReply.result.content[0].text).toContain('note after turn one')
    expect(messagesForRun(root)[0]!.read_at).not.toBeNull()
    expect(messagesForRun(root)[0]!.read_by).toBe('resume-session')
  })

  test('tell targets the active child turn while retaining the conversation root', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2,
    })
    expect(mailboxOrch('tell', String(root), 'context for turn two').code).toBe(0)
    expect(messagesForRun(child)[0]).toMatchObject({ root_run_id: root, run_id: child })
  })

  test('tell refuses a finished conversation instead of claiming a queue', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    const told = mailboxOrch('tell', String(root), 'too late')
    expect(told.code).toBe(1)
    expect(told.err).toContain('has no running turn — no message was queued')
    expect(messagesForRun(root)).toEqual([])
  })
})

describe('port importer', () => {
  const registered = () => {
    upsertProject({ name: 'alpha-invented', path: '/w/alpha-invented', settings: { keyPrefixes: ['ALP'] } })
    upsertProject({ name: 'beta-invented', path: '/w/beta-invented', settings: { keyPrefixes: ['BET'] } })
    return projects()
  }
  const fixture = (overrides: Partial<Record<'doctrine' | 'differences' | 'backports' | 'refs' | 'state' | 'projects', string>> = {}) => ({
    doctrine: '# Doctrine\n\nPreface text.\n\n1. **Keep the whole rule** Opening sentence.\nContinuation line.\nA known final item at the end of the rule.\n',
    differences: '# Differences\n\n## Stack mapping (how to translate, not a reason to skip)\nMap body.\n\n## Per-project uniques\n\n### alpha-invented\nAlpha body.\n\n### Shared deployment constraint\nUnassigned body.\n\n### beta-invented\nBeta body.\n\n## Process differences\nProcess body.\n',
    backports: '# Backports\n\n## -> alpha-invented\n' + 'A long backport body. '.repeat(20) + '\nKnown final checkbox.\n\n## -> beta-invented\nBeta backport.\n',
    refs: JSON.stringify({ 'BET-7': { source: 'alpha-invented', commits: ['abc'], paths: ['src/a.ts'], notes: 'Native notes.' } }),
    state: JSON.stringify({ pairs: { 'alpha-invented->beta-invented': { lastPortedSha: 'abc', scannedAt: '2026-01-01', skipped: [{ feature: 'old feature', reason: 'superseded', raiseAgain: false }] } } }),
    projects: '# Projects\n\n## Category map\nCategories.\n\n## Reference implementations (deepest instance = default port source)\nReferences.\n',
    ...overrides,
  })

  test('plans complete long sections and classifies an unmatched differences heading globally', () => {
    const plan = planImport(fixture(), registered())
    expect(plan.refusals).toEqual([])
    const backport = plan.docs.find((doc) => doc.subject === 'alpha-invented' && doc.slug === 'port-backports')!
    expect(backport.body.length).toBeGreaterThan(backport.body.indexOf('\n') + 300)
    expect(backport.body).toContain('Known final checkbox.')
    expect(plan.doctrine[0]!.body).toContain('A known final item at the end of the rule.')
    expect(plan.docs.find((doc) => doc.slug === 'port-differences-unassigned')?.body)
      .toContain('Shared deployment constraint')
    expect(plan.docs.find((doc) => doc.subject === 'beta-invented' && doc.slug === 'port-differences')?.body)
      .not.toContain('Process body.')
  })

  test('excludes incompatible baselines and unmapped fields while preserving bare skips losslessly', () => {
    const state = JSON.stringify({ pairs: {
      'alpha-invented->beta-invented': {
        lastPortedSha: null, scannedAt: '2026-01-01', skipped: ['bare candidate'],
        note: 'one', notes: 'two', scope: ['src'], staged: ['ALP-1'],
      },
    } })
    const plan = planImport(fixture({ state }), registered())
    expect(plan.exclusions.filter((r) => r.what.startsWith('pair field')).map((r) => r.what)).toEqual([
      'pair field "note"', 'pair field "notes"', 'pair field "scope"', 'pair field "staged"',
    ])
    expect(plan.exclusions.find((r) => r.what === 'baseline')?.where)
      .toBe('state.json pairs["alpha-invented->beta-invented"]')
    expect(plan.skips).toEqual([expect.objectContaining({
      candidate: 'bare candidate',
      reason: 'recorded in the source with no separate reason; the candidate text is the entire record',
    })])
    expect(plan.docs.find((doc) => doc.slug === 'port-import-exclusions')?.body)
      .toContain('Original value:\none')

    const missingSha = planImport(fixture({ state: JSON.stringify({ pairs: {
      'alpha-invented->beta-invented': { scannedAt: null, skipped: [] },
    } }) }), projects())
    expect(missingSha.exclusions.find((issue) => issue.what === 'baseline')?.why)
      .toBe('lastPortedSha is missing')
  })

  test('splits declared multi-sources, preserves qualifiers, and refuses unresolved sources and task prefixes', () => {
    upsertProject({ name: 'alpha-invented', path: '/w/a', settings: { keyPrefixes: ['ALP'] } })
    upsertProject({ name: 'beta-invented', path: '/w/b', settings: { keyPrefixes: ['DUP'] } })
    upsertProject({ name: 'gamma-invented', path: '/w/c', settings: { keyPrefixes: ['DUP'] } })
    const refs = JSON.stringify({
      'ALP-1': { source: 'alpha-invented + beta-invented', commits: [], paths: [], notes: '' },
      'ALP-2': { source: 'alpha-invented (concept); new mechanism', commits: [], paths: [], notes: '' },
      'ALP-3': { source: 'missing-invented (unknown)', commits: [], paths: [], notes: '' },
      'NONE-2': { source: 'alpha-invented', commits: [], paths: [], notes: '' },
      'DUP-3': { source: 'alpha-invented', commits: [], paths: [], notes: '' },
    })
    const plan = planImport(fixture({ refs }), projects())
    expect(plan.refs.find((ref) => ref.taskKey === 'ALP-1')?.sources.map((source) => source.source_project_id))
      .toEqual([projects().find((p) => p.name === 'alpha-invented')!.id,
        projects().find((p) => p.name === 'beta-invented')!.id])
    expect(plan.refs.find((ref) => ref.taskKey === 'ALP-2')?.sources[0]?.note)
      .toBe(' (concept); new mechanism')
    expect(plan.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ where: 'refs.json ALP-3', what: 'project "missing-invented (unknown)"' }),
      expect.objectContaining({ where: 'refs.json NONE-2', why: expect.stringContaining('no registered project') }),
      expect.objectContaining({ where: 'refs.json DUP-3', why: expect.stringContaining('several registered projects') }),
    ]))

    const nonStringSource = planImport(fixture({ refs: JSON.stringify({
      'ALP-4': { source: ['alpha-invented'], commits: [], paths: [], notes: '' },
    }) }), projects())
    expect(nonStringSource.refusals.find((issue) => issue.where === 'refs.json ALP-4')?.why)
      .toBe('source must name registered projects')
  })

  test('records the deliberately unimported register-derived sections as one exclusion', () => {
    const source = fixture({ projects: '# Projects\n\n## Resolving the workspace\nOld paths.\n\n## Stacks\nOld stacks.\n\n## Category map\nCategories.\n\n## Reference implementations (deepest instance = default port source)\nReferences.\n' })
    const plan = planImport(source, registered())
    expect(plan.exclusions.filter((r) => r.where === 'projects.md')).toEqual([
      expect.objectContaining({ what: 'workspace and stack sections' }),
    ])
  })

  test('a refusal makes apply all-or-nothing', () => {
    const plan = planImport(fixture(), registered())
    plan.refusals.push({ kind: 'refusal', what: 'bad row', where: 'fixture row', why: 'cannot resolve it' })
    expect(() => applyImport(plan)).toThrow(ImportRefusalError)
    expect(listPairs()).toEqual([])
    expect(listDoctrineRules()).toEqual([])
    expect(getDoc('global', null, 'port-category-map')).toBeNull()
    const uncovered = sourceCoverage(plan, fixture())
    expect(uncovered).toHaveLength(6)
    expect(uncovered.map((gap) => gap.text)).toEqual(expect.arrayContaining(Object.values(fixture())))
  })

  test('a destination refusal makes the plan report its whole input uncovered', () => {
    const files = fixture()
    applyImport(planImport(files, registered()))
    const refused = planImport(files, projects())
    expect(() => applyImport(refused)).toThrow(ImportRefusalError)
    expect(refused.refusals).toEqual([
      expect.objectContaining({ what: 'existing port data', kind: 'refusal' }),
    ])
    expect(sourceCoverage(refused, files)).toHaveLength(6)
  })

  test('persists every exclusion and its original value inside the import transaction', () => {
    const state = JSON.stringify({ pairs: {
      'alpha-invented->beta-invented': {
        lastPortedSha: 'abc', scannedAt: '2026-01-01', skipped: [],
        note: 'Original text that must survive verbatim.',
      },
    } })
    const plan = planImport(fixture({ state }), registered())
    expect(plan.refusals).toEqual([])
    applyImport(plan)
    expect(getDoc('global', null, 'port-import-exclusions')).toMatchObject({
      title: 'Port import exclusions',
      body: expect.stringContaining('Original value:\nOriginal text that must survive verbatim.'),
    })
    expect(listDocRevisions('global', null, 'port-import-exclusions')[0]).toMatchObject({
      op: 'import', author: 'port-import', reason: 'port import from source corpus',
    })
  })

  test('a second import refuses existing data and replace atomically rewrites it', () => {
    const plan = planImport(fixture(), registered())
    applyImport(plan)
    expect(() => applyImport(plan)).toThrow(ImportRefusalError)
    const replacement = planImport(fixture({ doctrine: '# Doctrine\n\nNew preface.\n\n2. **Replacement rule** Replacement body.\n' }), projects())
    applyImport(replacement, { replace: true })
    expect(listDoctrineRules().map((row) => row.number)).toEqual([2])
    expect(listPairs()).toHaveLength(1)
    expect(getDoc('global', null, 'port-doctrine-preface')?.body).toContain('New preface.')
    expect(listDocRevisions('global', null, 'port-doctrine-preface').map((revision) => revision.op))
      .toEqual(['import', 'delete', 'import'])
  })

  test('an importer-owned doc alone makes the destination non-empty', () => {
    const plan = planImport(fixture(), registered())
    setDoc({ scope: 'global', subject: null, slug: 'port-category-map', title: 'Existing', body: 'Keep me.' })
    expect(() => applyImport(plan)).toThrow(ImportRefusalError)
    expect(getDoc('global', null, 'port-category-map')).toMatchObject({ title: 'Existing', body: 'Keep me.' })
    expect(listPairs()).toEqual([])
  })

  test('a late doctrine constraint failure rolls back every preceding write', () => {
    const plan = planImport(fixture(), registered())
    plan.doctrine.push({ ...plan.doctrine[0]!, title: 'Duplicate' })
    expect(() => applyImport(plan)).toThrow()
    expect(listPairs()).toEqual([])
    expect(db().query('SELECT COUNT(*) n FROM port_baseline').get()).toEqual({ n: 0 })
    expect(db().query('SELECT COUNT(*) n FROM port_skip').get()).toEqual({ n: 0 })
    expect(db().query('SELECT COUNT(*) n FROM port_ref').get()).toEqual({ n: 0 })
    expect(db().query('SELECT COUNT(*) n FROM port_ref_source').get()).toEqual({ n: 0 })
    expect(listDoctrineRules()).toEqual([])
    expect(listDocs().filter((doc) => doc.slug.startsWith('port-'))).toEqual([])
  })

  test('a late replacement failure restores all deleted prior data and docs', () => {
    const original = planImport(fixture(), registered())
    applyImport(original)
    const priorPair = listPairs()
    const priorBaseline = baselineForPair(priorPair[0]!.id)
    const priorSkips = listSkips(priorPair[0]!.id)
    const priorRef = ledgerRef('BET-7')
    const priorDoc = getDoc('global', null, 'port-category-map')
    const replacement = planImport(fixture(), projects())
    replacement.doctrine.push({ ...replacement.doctrine[0]!, title: 'Duplicate' })
    expect(() => applyImport(replacement, { replace: true })).toThrow()
    expect(listPairs()).toEqual(priorPair)
    expect(baselineForPair(priorPair[0]!.id)).toEqual(priorBaseline)
    expect(listSkips(priorPair[0]!.id)).toEqual(priorSkips)
    expect(ledgerRef('BET-7')).toEqual(priorRef)
    expect(getDoc('global', null, 'port-category-map')).toEqual(priorDoc)
    expect(listDoctrineRules()).toHaveLength(1)
  })

  test('CLI dry-run shows body lengths, writes nothing, and names a missing file', () => {
    registered()
    const source = mkdtempSync(join(tmpdir(), 'port-import-invented-'))
    try {
      for (const [name, body] of Object.entries(fixture())) writeFileSync(join(source, `${name}.json`), body)
      // Markdown inputs have their source filenames rather than the fixture object's uniform suffix.
      for (const name of ['doctrine', 'differences', 'backports', 'projects'] as const) {
        writeFileSync(join(source, `${name}.md`), fixture()[name])
      }
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const run = (path: string) => Bun.spawnSync([process.execPath, CLI, 'port', 'import', path, '--dry-run', '--json'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
      })
      const sessionsBefore = db().query('SELECT COUNT(*) n FROM session_seen').get()
      const clean = run(source)
      expect(clean.exitCode).toBe(0)
      const cleanPlan = JSON.parse(clean.stdout.toString())
      expect(cleanPlan.docs[0].bodyLength).toBeGreaterThan(0)
      expect(cleanPlan.uncoveredSpans).toEqual([])
      const human = Bun.spawnSync([process.execPath, CLI, 'port', 'import', source, '--dry-run'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(human.exitCode).toBe(0)
      expect(human.stdout.toString()).toContain('uncovered spans (0)')
      expect(listPairs()).toEqual([])
      expect(db().query('SELECT COUNT(*) n FROM session_seen').get()).toEqual(sessionsBefore)

      const incomplete = mkdtempSync(join(tmpdir(), 'port-import-missing-invented-'))
      try {
        const missing = run(incomplete)
        expect(missing.exitCode).toBe(1)
        const missingPlan = JSON.parse(missing.stdout.toString())
        expect(missingPlan.refusals).toHaveLength(6)
        expect(missingPlan.refusals.every((issue: any) => issue.what.startsWith('source file'))).toBe(true)
        expect(missingPlan.refusals.map((issue: any) => issue.where)).toContain(join(incomplete, 'refs.json'))
        expect(missingPlan.uncoveredSpans).toHaveLength(6)
      } finally { rmSync(incomplete, { recursive: true, force: true }) }
    } finally { rmSync(source, { recursive: true, force: true }) }
  })

  test('CLI dry-run pipes a complete large JSON refusal plan', async () => {
    registered()
    const source = mkdtempSync(join(tmpdir(), 'port-import-large-refusal-invented-'))
    try {
      const contents = fixture({
        refs: JSON.stringify({
          'BET-7': {
            source: 'missing-invented', commits: [], paths: [], notes: 'unresolved source',
          },
        }),
        state: JSON.stringify({ pairs: {
          'alpha-invented->beta-invented': {
            lastPortedSha: 'abc', scannedAt: '2026-01-01', skipped: [],
            note: 'large-excluded-value-'.repeat(3_500),
          },
        } }),
      })
      for (const [name, body] of Object.entries({
        'doctrine.md': contents.doctrine, 'differences.md': contents.differences,
        'backports.md': contents.backports, 'refs.json': contents.refs,
        'state.json': contents.state, 'projects.md': contents.projects,
      })) writeFileSync(join(source, name), body)

      const planned = planImport(contents, projects())
      const expected = Buffer.from(`${JSON.stringify({
        ...planned,
        doctrine: planned.doctrine.map((row) => ({ ...row, bodyLength: row.body.length })),
        docs: planned.docs.map((row) => ({ ...row, bodyLength: row.body.length })),
        uncoveredSpans: sourceCoverage(planned, contents),
      }, null, 2)}\n`)
      const cli = new URL('cli.ts', import.meta.url).pathname
      const run = await runWithDelayedStdoutReader(
        [process.execPath, cli, 'port', 'import', source, '--dry-run', '--json'],
        { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      )
      expect(expected.byteLength).toBeGreaterThan(65_536)
      expect(run.stdout.byteLength).toBe(expected.byteLength)
      expect(run.stdout.equals(expected)).toBe(true)
      const plan = JSON.parse(run.stdout.toString())
      expect(plan.refusals).toContainEqual(expect.objectContaining({
        what: 'project "missing-invented"',
      }))
      expect(plan.exclusions[0].value).toHaveLength('large-excluded-value-'.length * 3_500)
      expect(run.exitCode).toBe(1)
    } finally { rmSync(source, { recursive: true, force: true }) }
  })

  test('CLI dry-run refuses a nonexistent database without creating any SQLite files', () => {
    const source = mkdtempSync(join(tmpdir(), 'port-import-readonly-invented-'))
    const absent = join(source, 'absent.db')
    try {
      const contents = fixture()
      for (const [name, body] of Object.entries({
        'doctrine.md': contents.doctrine, 'differences.md': contents.differences,
        'backports.md': contents.backports, 'refs.json': contents.refs,
        'state.json': contents.state, 'projects.md': contents.projects,
      })) writeFileSync(join(source, name), body)
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const run = Bun.spawnSync([process.execPath, CLI, 'port', 'import', source, '--dry-run', '--json'], {
        env: { ...process.env, ORCH_DB: absent, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(run.exitCode).toBe(1)
      expect(run.stdout.toString()).toContain('orchestrator database does not exist')
      expect(existsSync(absent)).toBe(false)
      expect(existsSync(`${absent}-wal`)).toBe(false)
      expect(existsSync(`${absent}-shm`)).toBe(false)
    } finally { rmSync(source, { recursive: true, force: true }) }
  })

  test('CLI dry-run explains a WAL database whose shared-memory sidecar is absent', () => {
    const source = mkdtempSync(join(tmpdir(), 'port-import-wal-invented-'))
    const walPath = join(source, 'wal-copy.db')
    try {
      const contents = fixture()
      for (const [name, body] of Object.entries({
        'doctrine.md': contents.doctrine, 'differences.md': contents.differences,
        'backports.md': contents.backports, 'refs.json': contents.refs,
        'state.json': contents.state, 'projects.md': contents.projects,
      })) writeFileSync(join(source, name), body)
      const wal = new Database(walPath)
      wal.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE project (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
          stack TEXT, canon INTEGER NOT NULL, settings TEXT
        );
        PRAGMA wal_checkpoint(TRUNCATE);
      `)
      wal.close()
      rmSync(`${walPath}-shm`, { force: true })
      rmSync(`${walPath}-wal`, { force: true })
      expect(existsSync(`${walPath}-shm`)).toBe(false)

      const CLI = new URL('cli.ts', import.meta.url).pathname
      const run = Bun.spawnSync([process.execPath, CLI, 'port', 'import', source, '--dry-run', '--json'], {
        env: { ...process.env, ORCH_DB: walPath, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(run.exitCode).toBe(1)
      const why = JSON.parse(run.stdout.toString()).refusals[0].why
      expect(why).toContain(`WAL-mode with no ${walPath}-shm sidecar`)
      expect(why).toContain('PRAGMA wal_checkpoint(TRUNCATE)')
      expect(why).toContain('Underlying error: SQLiteError: unable to open database file')
      expect(existsSync(`${walPath}-shm`)).toBe(false)
      expect(existsSync(`${walPath}-wal`)).toBe(false)
    } finally { rmSync(source, { recursive: true, force: true }) }
  })

  test('every non-whitespace source span in synthetic port files is accounted for', () => {
    const files = fixture({
      refs: JSON.stringify({
        _format: 'invented ledger shape',
        'BET-7': { source: 'alpha-invented', commits: ['abc'], paths: ['src/a.ts'], notes: 'Native notes.' },
        'BET-8': { source: 'alpha-invented + beta-invented', commits: ['def'], paths: ['src/b.ts'], notes: 'Two sources.' },
      }),
    })
    const state = JSON.parse(files.state)
    const projectNames = [...new Set(Object.keys(state.pairs).flatMap((pair) => pair.split('->')))] as string[]
    const refs = JSON.parse(files.refs)
    const prefixes = [...new Set(Object.keys(refs).filter((key) => !key.startsWith('_')).map((key) => key.split('-')[0]))]
    const syntheticRegister = projectNames.map((name, index) => ({
      id: index + 1, name, path: `/fixture/${index}`, stack: null, canon: false,
      settings: index === 0 ? { keyPrefixes: prefixes } : {},
    }))
    const plan = planImport(files, syntheticRegister)
    expect(plan.refusals).toEqual([])
    expect(sourceCoverage(plan, files)).toEqual([])

    const wrongId = structuredClone(plan)
    wrongId.refs[0]!.sources[0]!.source_project_id = 999999
    expect(sourceCoverage(wrongId, files)).toContainEqual({ file: 'refs.json', offset: 0, text: files.refs })

    const duplicatedSource = structuredClone(plan)
    const multiSource = duplicatedSource.refs.find((ref) => ref.sources.length > 1)!
    multiSource.sources[0] = structuredClone(multiSource.sources[1]!)
    expect(sourceCoverage(duplicatedSource, files))
      .toContainEqual({ file: 'refs.json', offset: 0, text: files.refs })

    const repeatedSkipState = JSON.parse(files.state)
    const [repeatedPairKey, repeatedPair] = Object.entries(repeatedSkipState.pairs as Record<string, any>)
      .find(([, pair]: [string, any]) => Array.isArray(pair.skipped) && pair.skipped.length > 0)!
    repeatedPair.skipped.push(structuredClone(repeatedPair.skipped[0]))
    const repeatedSkipFiles = { ...files, state: JSON.stringify(repeatedSkipState) }
    const missingRepeatedSkip = planImport(repeatedSkipFiles, syntheticRegister)
    const repeatedRows = missingRepeatedSkip.skips
      .map((skip, index) => ({ skip, index }))
      .filter(({ skip }) => skip.pairKey === repeatedPairKey)
    missingRepeatedSkip.skips.splice(repeatedRows.at(-1)!.index, 1)
    expect(sourceCoverage(missingRepeatedSkip, repeatedSkipFiles))
      .toContainEqual({ file: 'state.json', offset: 0, text: repeatedSkipFiles.state })

    plan.docs = plan.docs.filter((doc) => doc.slug !== 'port-import-source-context')
    expect(sourceCoverage(plan, files)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: expect.stringMatching(/\.md$/), offset: expect.any(Number), text: expect.any(String) }),
    ]))

    const jsonPlan = planImport(files, syntheticRegister)
    jsonPlan.docs = jsonPlan.docs.filter((doc) => doc.slug !== 'port-state-metadata')
    expect(sourceCoverage(jsonPlan, files)).toContainEqual({ file: 'state.json', offset: 0, text: files.state })
    jsonPlan.docs = planImport(files, syntheticRegister).docs.filter((doc) => doc.slug !== 'port-ref-metadata')
    expect(sourceCoverage(jsonPlan, files)).toContainEqual({ file: 'refs.json', offset: 0, text: files.refs })
  })
})

describe('reclassify-failures', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const runCli = (...args: string[]) => Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
    stdout: 'pipe', stderr: 'pipe',
  })

  test('reclassifies only failed rows whose own error has the DEV-122 signature', () => {
    const startedAt = '2026-09-03T12:00:00.000Z'
    const quotaError = 'Internal error: { "message": "API error (status 402 Payment Required): Grok Build usage exhausted" }\nfull stored detail'
    const successful = addRun({
      agent: 'grok', job: 'review-lens', status: 'ok', kind: 'other', startedAt,
    })
    score(successful, 'full', 'right')
    const failed = addRun({
      agent: 'grok', job: 'review-lens', status: 'failed', kind: 'other', startedAt,
    })
    const nullKind = addRun({
      agent: 'codex', job: 'review-lens', status: 'failed', startedAt,
    })
    const unrelated = addRun({
      agent: 'grok', job: 'review-lens', status: 'stale', kind: 'other', startedAt,
    })
    db().query('UPDATE run SET error=? WHERE id=?').run(quotaError, successful)
    db().query('UPDATE run SET error=? WHERE id=?').run(quotaError, failed)
    db().query('UPDATE run SET error=? WHERE id=?').run(quotaError, nullKind)
    db().query('UPDATE run SET error=? WHERE id=?').run('abandoned by architect', unrelated)

    const before = candidates('review-lens').find((c) => c.agent === 'grok')!
    expect(before.failures).toBe(2)
    expect(before.evidence).toBe(3)

    const dry = runCli('reclassify-failures', '--dry-run')
    expect(dry.exitCode).toBe(0)
    const dryOut = new TextDecoder().decode(dry.stdout)
    expect(dryOut).toContain('BEFORE (all failed/stale rows)')
    expect(dryOut).toContain('grok  other  2')
    expect(dryOut).toContain(`run ${failed}  grok/review-lens  [failed]  other -> quota`)
    expect(dryOut).toContain(`run ${nullKind}  codex/review-lens  [failed]  null -> quota`)
    expect(dryOut).toContain(quotaError)
    expect(dryOut).toContain('AFTER (all failed/stale rows)')
    expect(dryOut).toContain('grok  other  1')
    expect(dryOut).toContain('grok  quota  1')
    expect(dryOut).toContain('2 rows would be reclassified — dry run, no writes.')
    expect(db().query('SELECT failure_kind FROM run WHERE id=?').get(failed))
      .toEqual({ failure_kind: 'other' })

    const applied = runCli('reclassify-failures')
    expect(applied.exitCode).toBe(0)
    expect(new TextDecoder().decode(applied.stdout)).toContain('2 rows reclassified.')
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(failed))
      .toEqual({ status: 'failed', failure_kind: 'quota' })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(successful))
      .toEqual({ status: 'ok', failure_kind: 'other' })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(nullKind))
      .toEqual({ status: 'failed', failure_kind: 'quota' })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(unrelated))
      .toEqual({ status: 'stale', failure_kind: 'other' })

    const after = candidates('review-lens').find((c) => c.agent === 'grok')!
    expect(after.failures).toBe(1)
    expect(after.evidence).toBe(2)
    expect(after.score).toBeCloseTo(
      (weigh('full', 'right') + weigh('none', null)) / 2,
    )

    const again = runCli('reclassify-failures')
    expect(again.exitCode).toBe(0)
    expect(new TextDecoder().decode(again.stdout)).toContain('PLAN (0 matched rows)')
    expect(new TextDecoder().decode(again.stdout)).toContain('0 rows reclassified.')
  }, 20_000)
})

describe('job contracts are visible before submission', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const contract = (jobName: string) => {
    const p = Bun.spawnSync([process.execPath, CLI, 'contract', jobName], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }

  test('the read-only contract names inherited work without claiming it is always present', () => {
    expect(READONLY_PREAMBLE).toContain('fresh checkout of this')
    expect(READONLY_PREAMBLE).toContain("run's base commit")
    expect(READONLY_PREAMBLE).toContain('If the caller chose to carry their uncommitted work into it')
    expect(READONLY_PREAMBLE).toContain('do not report it as your change')
    expect(READONLY_PREAMBLE).not.toContain("It contains the caller's")
    expect(READONLY_PREAMBLE).toContain(
      'Edit and test freely when that helps you verify a finding. Your findings are the\n' +
      'deliverable, not your diff: every change you make here is scratch work and must\n' +
      'never be treated as a proposed change to land. Do not commit, push, or merge.',
    )
  })

  test('reader contracts require the deliverable before ceiling-vulnerable reasoning', () => {
    expect(READONLY_PREAMBLE).toContain(READER_DELIVERABLE_FIRST)
    expect(NO_REPO_PREAMBLE).toContain(READER_DELIVERABLE_FIRST)
  })

  test('diagnose and review-lens require partial delivery around blocked sub-questions', () => {
    for (const name of ['diagnose', 'review-lens']) {
      const r = contract(name)
      expect(r.code).toBe(0)
      const text = r.out.replace(/\s+/g, ' ')
      expect(text).toContain('A prompt with several questions is not atomic')
      expect(text).toContain('report BLOCKED under that question')
      expect(text).toContain('Never withhold deliverable answers behind a blocked one')
      expect(text).toContain('could_not_verify for that sub-question')
    }
  })

  test('repository readers and writers receive the same infrastructure recovery paragraph', () => {
    expect(READONLY_PREAMBLE).toContain(INFRASTRUCTURE_RECOVERY)
    expect(WORKER_PREAMBLE).toContain(INFRASTRUCTURE_RECOVERY)
    expect(READONLY_PREAMBLE.match(/PROJECT INFRASTRUCTURE RECOVERY/g)).toHaveLength(1)
    expect(WORKER_PREAMBLE.match(/PROJECT INFRASTRUCTURE RECOVERY/g)).toHaveLength(1)
    expect(INFRASTRUCTURE_RECOVERY).toContain('worktree.recipe.serve')
    expect(INFRASTRUCTURE_RECOVERY).toContain('worktree.notes')
    expect(INFRASTRUCTURE_RECOVERY).toContain(
      'A reader MAY run that serve step and MAY make scratch edits to verify a finding; a reader MUST NOT commit, and its diff is never the deliverable.',
    )
  })

  test('review provenance makes an unexecuted suite visible', () => {
    const paragraphInstruction = INFRASTRUCTURE_RECOVERY.split('\n\n').at(-1)!
    const schemaInstruction: string =
      REVIEW_SCHEMA.properties.provenance.properties.could_not_verify.description
    expect(paragraphInstruction).toBe(COULD_NOT_VERIFY_INSTRUCTION)
    expect(schemaInstruction).toBe(paragraphInstruction)
  })

  test('review contract prose names every provenance list dropped with schema binding', () => {
    const text = contract('review-lens').out.replace(/\s+/g, ' ')
    expect(text).toContain(REVIEW_PROVENANCE_INSTRUCTION)
    expect(text).toContain('provenance.mcp_tools')
    expect(text).toContain('provenance.docs_read')
    expect(text).toContain('provenance.substitutes')
    expect(text).toContain('Empty arrays are valid')
    expect(text).toContain('<server>.<tool>')
  })

  test('writing and reading workers file findings instead of leaving only mailbox notes', () => {
    for (const preamble of [WORKER_PREAMBLE, READONLY_PREAMBLE]) {
      expect(preamble).toContain('file_issue')
      expect(preamble).toContain('OUTSIDE')
      expect(preamble).toContain('do not leave it only as')
      expect(preamble).toContain('a mailbox note')
    }
  })

  test('contract prints the same preamble selected when a job is bound', () => {
    for (const [name, definition] of Object.entries(JOBS)) {
      const r = contract(name)
      expect(r.code).toBe(0)
      expect(r.out).toBe(
        `${definition.findings ? `${REVIEW_SEVERITY_INSTRUCTION}\n\n` : ''}${definition.needs.writesRepo
          ? WORKER_PREAMBLE
          : definition.needs.readsRepo ? READONLY_PREAMBLE : NO_REPO_PREAMBLE}\n\n` +
        `${jobBoundInstructionForContract(definition)}\n`,
      )
      expect(r.err).toBe('')
    }
  }, 20_000)

  test('contract rejects an unknown job', () => {
    const r = contract('not-a-job')
    expect(r.code).toBe(1)
    expect(r.err).toContain('unknown job "not-a-job"')
  })

  test('implement conflict warnings identify the original line', () => {
    const spec = [
      'Make the requested change.',
      'Commit it using the DEV-126 prefix.',
      'Then push the branch.',
    ].join('\n')
    expect(contractConflicts(spec)).toEqual([
      { line: 3, text: 'Then push the branch.' },
    ])
  })

  test('repeating the contract prohibitions is not reported as a conflict', () => {
    expect(contractConflicts([
      'Do not commit, push, or merge.',
      'Never push this branch.',
      'Make the change without committing it.',
      'There must be no commits.',
    ].join('\n'))).toEqual([])
  })

  test('a prohibition does not hide a conflicting instruction later on its line', () => {
    expect(contractConflicts('Do not commit. Push the branch instead.')).toEqual([
      { line: 1, text: 'Do not commit. Push the branch instead.' },
    ])
  })

  test.each([
    ['Kept separate rather than merged', false],
    ['reset the counter', false],
    ['merging two lists', false],
    ['merge the two lists', false],
    ['push the branch', true],
    ['merge into main', true],
    ['rebase onto trunk', true],
    ['git reset --hard', true],
    ['amend the commit', true],
    ['3. QUEUED — open, not started. Kept separate from in progress rather than merged.', false],
    ['push the fix', true],
    // merge is the most polysemous of the five; first-word merge is an accepted miss
    ['merge this when done', false],
    ['rebase before you finish', true],
    ['amend the previous change', true],
    ['the main loop resets state', false],
    ['the branch of the decision tree merges', false],
    ['in the main function, merge the maps', false],
    ['open a PR and merge it', true],
    ['merge into the main branch', true],
    ['merge from main', false],
  ] as const)('git-sense conflict %j fires=%s', (line, fires) => {
    expect(contractConflicts(line)).toEqual(
      fires ? [{ line: 1, text: line }] : [],
    )
  })

  test('a lowercase or preposition continuation joins the previous clause', () => {
    expect(contractConflicts('Push it\nto the remote')).toEqual([
      { line: 1, text: 'Push it' },
    ])
  })
})

describe('hooks fail open visibly', () => {
  const runHook = (name: string, input: string) => Bun.spawnSync(
    ['python3', new URL(`../hooks/${name}`, import.meta.url).pathname],
    { stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! } },
  )

  test('malformed stdin exits zero and writes one stderr line', () => {
    for (const hook of ['block-agent.py', 'score-reminder.py']) {
      const p = runHook(hook, '{not json')
      expect(p.exitCode).toBe(0)
      const lines = p.stderr.toString().trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('payload could not be parsed')
    }
    const fallback = new URL('../spawn-fallback.log', import.meta.url).pathname
    expect(readFileSync(fallback, 'utf8').trim().split('\n').at(-1))
      .toContain('payload could not be parsed')
  })

  test('NEEDS-WEB deep in a prompt is not a declaration', () => {
    const prompt = 'x'.repeat(500) + ' NEEDS-WEB'
    const p = runHook('block-agent.py', JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Agent',
      tool_input: { description: 'read files', prompt, subagent_type: 'general-purpose' },
    }))
    expect(p.exitCode).toBe(0)
    const reply = JSON.parse(p.stdout.toString())
    expect(reply.hookSpecificOutput.permissionDecision).toBe('deny')
  })
})
