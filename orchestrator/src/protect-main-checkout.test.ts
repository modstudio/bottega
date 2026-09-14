import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { upsertProject } from './projects.ts'
import { MAIN_CHECKOUT_INVARIANT, mainCheckoutWorktreeHint } from './projects.ts'

const HOOK = new URL('../hooks/protect-main-checkout.py', import.meta.url).pathname

describe('architect-side main checkout edit hook', () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  const scratch = () => {
    const repo = cloneRepository('orch-hook-main-')
    writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'fixture')
    return repo
  }
  const runHook = (payload: Record<string, unknown>) => Bun.spawnSync(
    ['python3', HOOK],
    {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! },
    },
  )
  const editor = (repo: string, file: string, tool = 'Edit') => ({
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    cwd: repo,
    tool_input: { file_path: join(repo, file) },
  })

  test('denies a tracked edit in a registered main checkout with both anchored lines', () => {
    const repo = scratch()
    try {
      upsertProject({ name: 'hook-main', path: repo, canon: false, settings: {} })
      const result = runHook(editor(repo, 'tracked.txt'))
      expect(result.exitCode).toBe(0)
      const body = JSON.parse(result.stdout.toString())
      const reason = body.hookSpecificOutput.permissionDecisionReason as string
      expect(body.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(reason).toContain('tracked.txt')
      expect(reason).toContain(`work from a worktree under ${mainCheckoutWorktreeHint(repo)} instead`)
      expect(reason).toContain(`invariant: ${MAIN_CHECKOUT_INVARIANT}`)
      expect(reason).toContain(`cleared by: orch do --cwd '${mainCheckoutWorktreeHint(repo)}/<tree>'`)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('allows an edit in a worktree of that same project', () => {
    const repo = scratch()
    const tree = join(repo, '.claude', 'worktrees', 'hook-tree')
    try {
      mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
      git(repo, 'worktree', 'add', '-b', 'hook-tree', tree, 'main')
      upsertProject({ name: 'hook-tree-project', path: repo, canon: false, settings: {} })
      const result = runHook(editor(tree, 'tracked.txt'))
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString().trim()).toBe('')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('allows creating an untracked file in main', () => {
    const repo = scratch()
    try {
      upsertProject({ name: 'hook-untracked', path: repo, canon: false, settings: {} })
      const result = runHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        cwd: repo,
        tool_input: { file_path: join(repo, 'new.txt'), content: 'x\n' },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString().trim()).toBe('')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('allows a tracked edit when the project declared the exemption', () => {
    const repo = scratch()
    try {
      upsertProject({
        name: 'hook-exempt', path: repo, canon: false,
        settings: { requireCleanMain: false },
      })
      const result = runHook(editor(repo, 'tracked.txt'))
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString().trim()).toBe('')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('hostile GIT_DIR still denies a tracked edit in the named checkout', () => {
    const repo = scratch()
    const other = scratch()
    const previousDir = process.env.GIT_DIR
    const previousIndex = process.env.GIT_INDEX_FILE
    try {
      upsertProject({ name: 'hook-hostile', path: repo, canon: false, settings: {} })
      writeFileSync(join(other, 'tracked.txt'), 'other\n')
      process.env.GIT_DIR = git(other, 'rev-parse', '--path-format=absolute', '--git-dir')
      process.env.GIT_INDEX_FILE = git(other, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
      const result = runHook(editor(repo, 'tracked.txt'))
      expect(result.exitCode).toBe(0)
      const body = JSON.parse(result.stdout.toString())
      expect(body.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(body.hookSpecificOutput.permissionDecisionReason).toContain('tracked.txt')
    } finally {
      if (previousDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousDir
      if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = previousIndex
      rmSync(repo, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })

  test('does not gate Bash, so landings and builds are not blocked', () => {
    const repo = scratch()
    try {
      upsertProject({ name: 'hook-bash', path: repo, canon: false, settings: {} })
      const result = runHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command: `printf changed > ${join(repo, 'tracked.txt')}` },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString().trim()).toBe('')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})
