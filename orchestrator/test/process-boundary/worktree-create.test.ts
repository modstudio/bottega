import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type WorktreeCreate } from "../../src/worktree-template.ts"
import { addRun, branchTip, compoundCreate, createArgv, createReadOnlyWithTool, createReadOnlyWorktree, createWithTool, createWorktree, db, declaredCreate, hermeticGitCommand, hermeticGitEnv, preflight, prepareSharedRefGuard, removeFor, resolveReviewTarget, run, upsertProject, worktreeDescribeFixture } from "../fixture.ts"
describe('worktree creation process boundary', () => {
const { fromRoot, git, scratchRepo } = worktreeDescribeFixture()
test('repository dispatch refuses a register landing branch that disagrees with HEAD', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'wrong-register-branch', path: repo,
      settings: {
        trunk: 'develop',
        worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}']), branch: '{key}' },
      },
    })
    expect(() => fromRoot(() => preflight('file-question', repo))).toThrow(
      /invariant: the register landing branch agrees.*orch project set wrong-register-branch/s,
    )
    rmSync(repo, { recursive: true, force: true })
  })

test('legacy reads and migrated declarations invoke all four tools identically', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-legacy-create-'))
    const bin = join(root, 'bin')
    const scripts = join(root, 'scripts')
    const capture = join(root, 'capture.json')
    mkdirSync(bin)
    mkdirSync(scripts)
    const recorder = `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const input = await Bun.stdin.text()
appendFileSync(process.env.CAPTURE, JSON.stringify({
  argv: process.argv.slice(2),
  name: process.env.WORKTREE_NAME_OVERRIDE ?? null,
  seed: process.env.WORKTREE_SEED ?? null,
  input,
}) + '\\n')
`
    writeFileSync(join(bin, 'bun'), recorder)
    writeFileSync(join(scripts, 'worktree'), recorder)
    chmodSync(join(bin, 'bun'), 0o755)
    chmodSync(join(scripts, 'worktree'), 0o755)

    const old = {
      adanim: 'echo \'{"cwd":"\'"$PWD"\'","name":"{name}"}\' | bun run scripts/worktree.ts create',
      alephbeis: "scripts/worktree add {branch} '{base}' {seed} --name={name} && echo $PWD/.claude/worktrees/{name}",
      starship: "WORKTREE_NAME_OVERRIDE={name} WORKTREE_SEED='{seed}' scripts/worktree add {branch} '{base}'",
      stopal: 'bun run worktree create "{branch}"',
    }
    const migrated = {
      adanim: { pipeline: old.adanim },
      alephbeis: declaredCreate('scripts/worktree', [
        'add', '{branch}', '{base}', { expand: 'seed' }, '--name={name}',
      ]),
      starship: {
        command: 'scripts/worktree', args: ['add', '{branch}', '{base}'],
        env: { WORKTREE_NAME_OVERRIDE: '{name}', WORKTREE_SEED: '{seed}' },
      },
      stopal: declaredCreate('bun', ['run', 'worktree', 'create', '{branch}']),
    }
    const invoke = (create: WorktreeCreate | string, vars: Record<string, string>) => {
      writeFileSync(capture, '')
      const declaredEnv = typeof create === 'object' && 'command' in create
        ? Object.fromEntries(Object.entries(create.env ?? {}).map(([name, value]) => [
            name, value.replace(/\{(\w+)\}/g, (_placeholder, key: string) => vars[key] ?? ''),
          ]))
        : {}
      const result = Bun.spawnSync(createArgv(create, vars), {
        cwd: root,
        env: {
          ...process.env, ...declaredEnv,
          PATH: `${bin}:${process.env.PATH ?? ''}`, CAPTURE: capture,
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      return readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    }
    try {
      for (const base of ['', 'abc123']) {
        const vars = {
          branch: 'technical/DEV-182-orch-1519', name: 'orch-1519',
          seed: '--full --budget-mb=2000', base, key: 'DEV-182', path: '',
        }
        for (const project of Object.keys(old) as (keyof typeof old)[]) {
          expect(invoke(old[project], vars)).toEqual(invoke(migrated[project], vars))
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

test('createWorktree from inside a worktree does not nest under it', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    try {
      process.chdir(tree)
      const w = createWorktree(process.cwd(), 657)
      expect(realpathSync(w.repoRoot)).toBe(realpathSync(repo))
      expect(realpathSync(w.path)).toBe(
        realpathSync(join(repo, '.claude', 'worktrees', 'orch-657')),
      )
      expect(w.path.startsWith(tree)).toBe(false)
      expect(existsSync(join(tree, '.claude', 'worktrees', 'orch-657'))).toBe(false)
      expect(readFileSync(join(w.path, '.orch-run'), 'utf8'))
        .toBe(`657\n${realpathSync(repo)}\nsource: git\n`)
      const exclude = resolve(w.path, git(w.path, 'rev-parse', '--git-path', 'info/exclude'))
      expect(readFileSync(exclude, 'utf8').split('\n')).toContain('.orch-run')
      expect(git(w.path, 'check-ignore', '.orch-run')).toBe('.orch-run')
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('a read-only job bypasses the project create tool and gets a detached base', () => {
    const { repo } = scratchRepo()
    const received = join(repo, 'received-seed')
    const removed = join(repo, 'project-remove-invoked')
    const path = join(repo, '.claude', 'worktrees', 'orch-658')
    const create = join(repo, 'scripts', 'create-read-only')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    writeFileSync(create, `#!/bin/sh
printf '%s' "$1" > "${received}"
${hermeticGitCommand} worktree add -b "$2" "${path}" HEAD >/dev/null
echo "${path}"
`)
    chmodSync(create, 0o755)
    const tool = {
      branch: 'orch/{id}',
      seeds: ['none', 'full'],
      create: compoundCreate(
        `printf '%s' {seed} > "${received}" && ` +
        `${hermeticGitCommand} worktree add -b {branch} "${path}" HEAD >/dev/null && ` +
        `echo "${path}"`),
      remove: `printf invoked > "${removed}"`,
    }
    upsertProject({ name: 'read-only-tool-seed', path: repo, settings: { worktree: tool } })
    try {
      const base = git(repo, 'rev-parse', 'HEAD')
      const w = createReadOnlyWorktree(repo, 658, base)
      expect(realpathSync(w.path)).toBe(realpathSync(path))
      expect(existsSync(received)).toBe(false)
      expect(Bun.spawnSync(['git', 'symbolic-ref', '-q', 'HEAD'], { cwd: w.path }).exitCode).not.toBe(0)
      expect(git(w.path, 'rev-parse', 'HEAD')).toBe(base)
      expect(w.source).toBe('git')
      expect(removeFor(w, repo).removed).toBe(true)
      expect(existsSync(removed)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('a command recipe with detached support satisfies the explicit-review postcondition', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'orch-659')
    const tool = {
      detached: true,
      branch: 'review/{id}',
      create: compoundCreate(
        `${hermeticGitCommand} worktree add --detach "${path}" {base} >/dev/null && ` +
        `echo "${path}"`,
      ),
    }
    upsertProject({
      name: 'detached-review-fixture', path: repo,
      settings: { trunk: 'main', worktree: tool },
    })
    try {
      const base = fromRoot(() => resolveReviewTarget('review-lens', repo, 'main'))!.commit
      const w = createWithTool(tool, repo, 659, undefined, undefined, base, undefined, true)
      expect(git(w.path, 'rev-parse', 'HEAD')).toBe(base)
      expect(Bun.spawnSync(['git', 'symbolic-ref', '-q', 'HEAD'], {
        cwd: w.path, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      }).exitCode).not.toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('readonly_create provisions a detached tree and uses readonly_remove', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'orch-659')
    const removed = join(repo, 'readonly-removed')
    const create = join(repo, 'readonly-create.sh')
    writeFileSync(create, `#!/bin/sh
if [ -n "$GIT_OBJECT_DIRECTORY" ] || [ -n "$GIT_ALTERNATE_OBJECT_DIRECTORIES" ] || [ -n "$ORCH_ALLOWED_GIT_REF" ]; then
  echo inherited git routing >&2
  exit 42
fi
exec git worktree add --detach "$1" "$2"
`)
    chmodSync(create, 0o755)
    const tool = {
      readonly_create: declaredCreate(create, ['{path}', '{base}']),
      readonly_remove: `${hermeticGitCommand} worktree remove --force {path} && printf invoked > "${removed}"`,
    }
    upsertProject({ name: 'read-only-recipe', path: repo, settings: { worktree: tool } })
    const inherited = {
      object: process.env.GIT_OBJECT_DIRECTORY,
      alternates: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      allowed: process.env.ORCH_ALLOWED_GIT_REF,
    }
    try {
      process.env.GIT_OBJECT_DIRECTORY = join(repo, '.git', 'objects')
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = join(repo, '.git', 'objects')
      process.env.ORCH_ALLOWED_GIT_REF = 'refs/heads/unrelated-worker-branch'
      const w = createReadOnlyWithTool(tool, repo, 659, git(repo, 'rev-parse', 'HEAD'))
      expect(realpathSync(w.path)).toBe(realpathSync(path))
      expect(w.source).toBe('readonly_recipe')
      expect(Bun.spawnSync(['git', 'symbolic-ref', '-q', 'HEAD'], { cwd: path }).exitCode).not.toBe(0)
      const guard = prepareSharedRefGuard(w.path)
      expect(existsSync(guard.GIT_CONFIG_VALUE_0)).toBe(true)
      expect(removeFor(w, repo).removed).toBe(true)
      expect(existsSync(guard.GIT_CONFIG_VALUE_0)).toBe(false)
      expect(readFileSync(removed, 'utf8')).toBe('invoked')
    } finally {
      if (inherited.object === undefined) delete process.env.GIT_OBJECT_DIRECTORY
      else process.env.GIT_OBJECT_DIRECTORY = inherited.object
      if (inherited.alternates === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
      else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = inherited.alternates
      if (inherited.allowed === undefined) delete process.env.ORCH_ALLOWED_GIT_REF
      else process.env.ORCH_ALLOWED_GIT_REF = inherited.allowed
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('a command recipe declaring detached support fails if it leaves a branch checked out', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'orch-660')
    const tool = {
      detached: true,
      branch: 'review/{id}',
      create: compoundCreate(
        `${hermeticGitCommand} worktree add -b {branch} "${path}" {base} >/dev/null && ` +
        `echo "${path}"`,
      ),
    }
    upsertProject({
      name: 'branched-review-fixture', path: repo,
      settings: { trunk: 'main', worktree: tool },
    })
    try {
      const base = fromRoot(() => resolveReviewTarget('review-lens', repo, 'main'))!.commit
      expect(() => createWithTool(
        tool, repo, 660, undefined, undefined, base, undefined, true,
      )).toThrow(
        `project branched-review-fixture: worktree.create detached review postcondition failed; ` +
        `expected detached HEAD at ${base}, got refs/heads/review/660 at ${base}.`,
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('readonly_create receives only path and base template variables', () => {
    const { repo } = scratchRepo()
    const tool = {
      readonly_create: declaredCreate(
        'git', ['worktree', 'add', '--detach', '{path}', '{base}', '{key}'],
      ),
    }
    try {
      expect(() => createReadOnlyWithTool(tool, repo, 660, git(repo, 'rev-parse', 'HEAD')))
        .toThrow('worktree create template references unavailable placeholder {key}')
      expect(existsSync(join(repo, '.claude', 'worktrees', 'orch-660'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('readonly_create removes a tree that fails its detached-head check', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'orch-661')
    const removed = join(repo, 'failed-readonly-removed')
    const tool = {
      readonly_create: declaredCreate(
        'git', ['worktree', 'add', '-b', 'bad-readonly-661', '{path}', '{base}'],
      ),
      readonly_remove: `${hermeticGitCommand} worktree remove --force {path} && ` +
        `printf invoked > "${removed}"`,
    }
    try {
      expect(() => createReadOnlyWithTool(tool, repo, 661, git(repo, 'rev-parse', 'HEAD')))
        .toThrow(/created attached branch bad-readonly-661[\s\S]*cleanup: removed/)
      expect(existsSync(path)).toBe(false)
      expect(readFileSync(removed, 'utf8')).toBe('invoked')
      expect(branchTip(repo, 'bad-readonly-661')).toBeNull()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('readonly_create cleanup restores a pre-existing attached branch to its original tip', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'orch-663')
    const branch = 'preserved-readonly-663'
    const originalTip = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'branch', branch, originalTip)
    writeFileSync(join(repo, 'later.txt'), 'later\n')
    git(repo, 'add', 'later.txt')
    git(repo, 'commit', '-m', 'later base')
    const base = git(repo, 'rev-parse', 'HEAD')
    const tool = {
      readonly_create: declaredCreate(
        'git', ['worktree', 'add', '-B', branch, '{path}', '{base}'],
      ),
    }
    try {
      expect(() => createReadOnlyWithTool(tool, repo, 663, base))
        .toThrow(new RegExp(`created attached branch ${branch}[\\s\\S]*cleanup: removed`))
      expect(existsSync(path)).toBe(false)
      expect(branchTip(repo, branch)).toBe(originalTip)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('readonly_create reports a cleanup refusal after a failed check', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'orch-662')
    const tool = {
      readonly_create: declaredCreate(
        'git', ['worktree', 'add', '-b', 'bad-readonly-662', '{path}', '{base}'],
      ),
      readonly_remove: 'printf protected >&2; exit 23',
    }
    try {
      expect(() => createReadOnlyWithTool(tool, repo, 662, git(repo, 'rev-parse', 'HEAD')))
        .toThrow(/cleanup: .*read-only remove tool refused:[\s\S]*protected/)
      expect(existsSync(path)).toBe(true)
    } finally {
      if (existsSync(path)) git(repo, 'worktree', 'remove', '--force', path)
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('a project-created tree is recorded before its ownership marker is written', () => {
    const { repo } = scratchRepo()
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const custom = join(repo, 'elsewhere', `orch-${id}`)
    try {
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" HEAD >/dev/null && ` +
            `echo "${custom}"`),
        },
        repo, id, undefined, undefined, undefined,
        (created) => {
          expect(existsSync(created.path)).toBe(true)
          expect(existsSync(join(created.path, '.orch-run'))).toBe(false)
          db().query('UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=? WHERE id=?')
            .run(created.path, created.path, created.branch, created.base, id)
        },
      )
      expect(existsSync(join(w.path, '.orch-run'))).toBe(true)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: custom })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('a project-created tree is removed when its run cannot record it', () => {
    const { repo } = scratchRepo()
    const custom = join(repo, 'elsewhere', 'orch-920')
    try {
      expect(() => createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" HEAD >/dev/null && ` +
            `echo "${custom}"`),
        },
        repo, 920, undefined, undefined, undefined,
        () => { throw new Error('database write failed') },
      )).toThrow(/database write failed[\s\S]*unrecorded worktree cleanup: removed/)
      expect(existsSync(custom)).toBe(false)
      expect(git(repo, 'branch', '--list', 'orch/920')).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('a stop between recording and marking leaves no project-created orphan', () => {
    const { repo } = scratchRepo()
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const custom = join(repo, 'elsewhere', `orch-${id}`)
    let stopped: { code: number; err: string } | null = null
    try {
      let failure = ''
      try {
        createWithTool(
          {
            create: compoundCreate(
              `${hermeticGitCommand} worktree add -b {branch} "${custom}" HEAD >/dev/null && ` +
              `echo "${custom}"`),
          },
          repo, id, undefined, undefined, undefined,
          (created) => {
            db().query('UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=? WHERE id=?')
              .run(created.path, created.path, created.branch, created.base, id)
            const p = Bun.spawnSync(
              [process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname, 'stop', String(id)],
              {
                env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
                stdout: 'pipe', stderr: 'pipe',
              },
            )
            stopped = { code: p.exitCode, err: p.stderr.toString() }
          },
        )
      } catch (e) {
        failure = String((e as Error).message ?? e)
      }
      expect(failure).not.toBe('')
      expect(stopped).not.toBeNull()
      expect(stopped!.err).toBe('')
      expect(stopped!.code).toBe(0)
      expect(existsSync(custom)).toBe(false)
      expect(db().query('SELECT status, worktree FROM run WHERE id=?').get(id))
        .toEqual({ status: 'stopped', worktree: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
