import { describe,expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS } from '../../src/agents.ts'
import { db } from '../../src/db.ts'
import { projectAt, upsertProject } from '../../src/projects.ts'
import { run as runJob } from '../../src/run.ts'
import { cloneRepository, hermeticGitEnv } from '../fixtures/git.ts'
import { addRun, dir } from '../fixtures/store.ts'


describe('task branch resolution', () => {
const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
const repository = () => {
    const repo = cloneRepository('orch-task-branch-')
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

