import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { OrchProjectListSchema } from '../../shared/orch-contract.ts'
import type { WorktreeCreate } from './projects.ts'
import { addRun, candidates, createWorktree, db, declaredCreate, dir, hermeticGitEnv, projectByName, projects, upsertProject } from '../test/fixture.ts'

import { runCollectionDescribeFixture } from '../test/fixture.ts'

describe("detached run collection", () => {
  const { CLI, orchInput, orch, orchFrom, insert, checkpointedOrch, lifecycleResult, dispatchArtifacts, expectNoDispatchArtifacts, expectCreateMigrationRefused } = runCollectionDescribeFixture()
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  const registerRepo = (branch: string) => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-register-')))
    git(repo, 'init', '-b', branch)
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'fixture')
    return repo
  }
test('discard removes both non-live worktrees owned by one chain', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-discard-chain-trees-')))
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  try {
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'fixture')
    const first = join(repo, 'first-tree')
    const second = join(repo, 'second-tree')
    git(repo, 'worktree', 'add', '-b', 'first-tree', first)
    git(repo, 'worktree', 'add', '-b', 'second-tree', second)
    upsertProject({ name: 'discard-chain-trees', path: repo, settings: { trunk: 'main' } })
    const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'orch-test-session' })
    const child = addRun({ agent: 'codex', job: 'implement', status: 'failed', session: 'orch-test-session', parent: root, turn: 2 })
    db().query('UPDATE run SET repo=?,cwd=?,worktree=?,branch=?,base_commit=?,worktree_source=? WHERE id=?')
      .run('discard-chain-trees', first, first, 'first-tree', 'main', 'git', root)
    db().query('UPDATE run SET repo=?,cwd=?,worktree=?,branch=?,base_commit=?,worktree_source=? WHERE id=?')
      .run('discard-chain-trees', second, second, 'second-tree', 'main', 'git', child)
    const discarded = orch('discard', String(root), '--force')
    expect(discarded.code, discarded.err).toBe(0)
    expect(existsSync(first)).toBe(false)
    expect(existsSync(second)).toBe(false)
    expect(db().query('SELECT count(*) n FROM run WHERE worktree IS NOT NULL AND (id=? OR parent_run_id=?)')
      .get(root, root)).toEqual({ n: 0 })
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
test('create commands must exist and be executable before dispatch', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-create-command-')))
    const binDir = mkdtempSync(join(tmpdir(), 'orch-create-command-bin-'))
    const git = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    const invoke = (args: string[], extraEnv: Record<string, string> = {}) => {
      const p = Bun.spawnSync([process.execPath, CLI, ...args], {
        cwd: repo, env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session', ...extraEnv,
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
    }
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-m', 'fixture')
      const create = (command: string) => upsertProject({
        name: 'create-command', path: repo, canon: false,
        settings: {
          worktree: {
            create: declaredCreate(command, ['create', '{branch}', '{base}']), branch: 'task/{id}',
          },
        },
      })

      for (const args of [[], ['--base', 'HEAD']]) {
        create('scripts/missing-worktree')
        const before = dispatchArtifacts(repo)
        const r = orchFrom(repo, 'orch-test-session', 'do', 'implement', 'inspect', ...args)
        expect(r.code).not.toBe(0)
        expect(r.err).toContain(
          'project create-command worktree create command scripts/missing-worktree is absent or not executable',
        )
        expectNoDispatchArtifacts(repo, before)
      }

      mkdirSync(join(repo, 'scripts'))
      writeFileSync(join(repo, 'scripts', 'not-executable'), '#!/bin/sh\n')
      create('scripts/not-executable')
      const nonExecutableBefore = dispatchArtifacts(repo)
      const nonExecutable = orchFrom(repo, 'orch-test-session', 'do', 'implement', 'inspect')
      expect(nonExecutable.code).not.toBe(0)
      expect(nonExecutable.err).toContain('scripts/not-executable is absent or not executable')
      expectNoDispatchArtifacts(repo, nonExecutableBefore)

      writeFileSync(join(binDir, 'present-worktree'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(binDir, 'present-worktree'), 0o755)
      create('present-worktree')
      const pathEnv = { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      const present = invoke([
        'do', 'implement', '--file', '/definitely/not/a/prompt', '--base', 'HEAD',
      ], pathEnv)
      expect(present.code).not.toBe(0)
      expect(present.err).toContain('/definitely/not/a/prompt')
      expect(present.err).not.toContain('absent or not executable')

      create('missing-from-path')
      const bareBefore = dispatchArtifacts(repo)
      const absentBare = invoke(['do', 'implement', 'inspect'], pathEnv)
      expect(absentBare.code).not.toBe(0)
      expect(absentBare.err).toContain('missing-from-path is absent or not executable')
      expectNoDispatchArtifacts(repo, bareBefore)
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 20_000)

  test('project set refuses incomplete resulting settings without saving them', () => {
    upsertProject({ name: 'warned', path: process.cwd() })
    const r = orch(
      'project', 'set', 'warned', '--settings',
      JSON.stringify({ worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']) } }),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain('has a create command but no branch template')
    expect(r.err).toContain('has a create command with a {seed} placeholder but no seeds list')
    const saved = db().query('SELECT settings FROM project WHERE name=?').get('warned') as
      { settings: string }
    expect(JSON.parse(saved.settings)).toEqual({})
  })

  test('project set --allow-incomplete saves and prints the same warnings', () => {
    upsertProject({ name: 'warned', path: process.cwd() })
    const r = orch(
      'project', 'set', 'warned', '--settings',
      JSON.stringify({ worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']) } }),
      '--allow-incomplete',
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain('has a create command but no branch template')
    expect(r.out).toContain('has a create command with a {seed} placeholder but no seeds list')
    const saved = db().query('SELECT settings FROM project WHERE name=?').get('warned') as
      { settings: string }
    expect(JSON.parse(saved.settings)).toEqual({
      worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']) },
    })
  })

  test('project set changes notes beside a legacy string create without rewriting it', () => {
    const create = 'bun run worktree create "{branch}"'
    upsertProject({
      name: 'legacy-notes', path: process.cwd(),
      settings: { worktree: { create, branch: 'task/{id}', notes: 'before' } } as any,
    })
    const r = orch(
      'project', 'set', 'legacy-notes', '--settings',
      JSON.stringify({ worktree: { notes: 'after' } }),
    )
    expect(r.code).toBe(0)
    expect(projectByName('legacy-notes')!.settings.worktree as any).toEqual({
      create, branch: 'task/{id}', notes: 'after',
    })
  })

  test('project set refuses legacy and malformed create declarations at registration', () => {
    upsertProject({ name: 'malformed-create', path: process.cwd() })
    for (const [create, message] of [
      ['scripts/worktree create {branch}', 'is a shell string; migrate it (DEV-308)'],
      [{ command: 'scripts/worktree create', args: ['{branch}'] }, 'must name one executable'],
      [{ command: 'sh', args: ['-c', 'scripts/worktree create {branch}'] }, 'may not disguise a shell string'],
      [{ pipeline: 'scripts/worktree create {branch}' }, 'only for a command that uses a pipe'],
      [{ command: 'scripts/worktree', args: [{ value: '--base={base}', omitWhenEmpty: 'seed' }] },
        'value must contain {seed}'],
    ] as const) {
      const r = orch(
        'project', 'set', 'malformed-create', '--settings',
        JSON.stringify({ worktree: { create } }), '--allow-incomplete',
      )
      expect(r.code).toBe(1)
      expect(r.err).toContain(message)
      expect(projectByName('malformed-create')!.settings).toEqual({})
    }
  }, 20_000)

  test('project set admits the pipeline escape only for an actual pipeline', () => {
    upsertProject({ name: 'pipeline-create', path: process.cwd() })
    const pipeline = `printf '{"name":"{name}"}' | bun scripts/worktree.ts create`
    const r = orch(
      'project', 'set', 'pipeline-create', '--settings',
      JSON.stringify({ worktree: { create: { pipeline }, branch: 'task/{id}' } }),
      '--allow-incomplete',
    )
    expect(r.code).toBe(0)
    expect(projectByName('pipeline-create')!.settings.worktree?.create).toEqual({ pipeline })
  })

  test('project set validates command environment values and their placeholders', () => {
    upsertProject({ name: 'create-env', path: process.cwd() })
    const valid = orch(
      'project', 'set', 'create-env', '--settings', JSON.stringify({
        worktree: {
          create: {
            command: 'scripts/worktree', args: ['add', '{branch}'],
            env: { NAME: '{name}', SEED: 'value with {seed}', BASE: '{base}' },
          },
          branch: 'task/{id}', seeds: ['none'],
        },
      }), '--allow-incomplete',
    )
    expect(valid.code).toBe(0)
    expect(projectByName('create-env')!.settings.worktree?.create).toEqual({
      command: 'scripts/worktree', args: ['add', '{branch}'],
      env: { NAME: '{name}', SEED: 'value with {seed}', BASE: '{base}' },
    })

    for (const [env, message] of [
      [{ NAME: 3 }, 'worktree.create.env.NAME must be a string'],
      [{ NAME: '{missing}' }, 'worktree.create.env.NAME contains unknown placeholder {missing}'],
      [[], 'worktree.create.env must be an object mapping names to string values'],
    ] as const) {
      const r = orch(
        'project', 'set', 'create-env', '--settings',
        JSON.stringify({ worktree: { create: { command: 'tool', args: [], env } } }),
        '--allow-incomplete',
      )
      expect(r.code).toBe(1)
      expect(r.err).toContain(message)
    }
  }, 20_000)

  test('project list reports legacy create problems in text and JSON', () => {
    upsertProject({
      name: 'legacy-list', path: process.cwd(),
      settings: { worktree: { create: 'bun run worktree create "{branch}"' } } as any,
    })
    const text = orch('project', 'list')
    expect(text.code).toBe(0)
    expect(text.out).toContain(
      'legacy-list: worktree.create is a shell string; migrate it (DEV-308)',
    )
    expect(text.out.match(/legacy-list: worktree\.create is a shell string/g)).toHaveLength(1)

    const json = orch('project', 'list', '--json')
    expect(json.code).toBe(0)
    expect(JSON.parse(json.out)[0].problems).toEqual([
      'worktree.create is a shell string; migrate it (DEV-308)',
    ])
  })

  test('migrate-create dry-runs the five live register shapes', () => {
    const fixtures = {
      adanim: {
        create: 'echo \'{"cwd":"\'"$PWD"\'","name":"{name}"}\' | bun run scripts/worktree.ts create',
        after: { pipeline: 'echo \'{"cwd":"\'"$PWD"\'","name":"{name}"}\' | bun run scripts/worktree.ts create' },
      },
      alephbeis: {
        create: "scripts/worktree add {branch} '{base}' {seed} --name={name} && echo $PWD/.claude/worktrees/{name}",
        refusal: `'&&'-chained tail "echo $PWD/.claude/worktrees/{name}" cannot be migrated; ` +
          `the chain must move into the project's script`,
      },
      starship: {
        create: "WORKTREE_NAME_OVERRIDE={name} WORKTREE_SEED='{seed}' scripts/worktree add {branch} '{base}'",
        after: {
          command: 'scripts/worktree', args: ['add', '{branch}', '{base}'],
          env: { WORKTREE_NAME_OVERRIDE: '{name}', WORKTREE_SEED: '{seed}' },
        },
      },
      stopal: {
        create: 'bun run worktree create "{branch}"',
        after: { command: 'bun', args: ['run', 'worktree', 'create', '{branch}'] },
      },
    } as const
    for (const [name, fixture] of Object.entries(fixtures)) {
      upsertProject({
        name, path: process.cwd(),
        settings: { worktree: { create: fixture.create } } as any,
      })
      const before = projectByName(name)!.settings.worktree!.create
      const r = orch('project', 'migrate-create', name)
      expect(r.code, name).toBe(0)
      expect(r.out, name).toContain(`${name}: before ${JSON.stringify(fixture.create)}`)
      if ('after' in fixture) {
        expect(r.out, name).toContain(`${name}: after  ${JSON.stringify(fixture.after)}`)
      } else {
        expect(r.out, name).toContain(`${name}: ${fixture.refusal}`)
      }
      expect(projectByName(name)!.settings.worktree!.create, name).toEqual(before)
    }

    upsertProject({ name: PLATFORM_SLUG, path: process.cwd(), settings: { worktree: { recipe: {} } } })
    const recipe = orch('project', 'migrate-create', PLATFORM_SLUG)
    expect(recipe.code).toBe(0)
    expect(recipe.out.trim()).toBe(
      `${PLATFORM_SLUG}: worktree.create is a recipe; nothing to migrate`,
    )
  }, 20_000)

  test('migrate-create --apply stores the printed object form', () => {
    const create = 'bun run worktree create "{branch}"'
    upsertProject({
      name: 'apply-create', path: process.cwd(),
      settings: { worktree: { create } } as any,
    })
    const r = orch('project', 'migrate-create', 'apply-create', '--apply')
    expect(r.code).toBe(0)
    expect(projectByName('apply-create')!.settings.worktree?.create).toEqual({
      command: 'bun', args: ['run', 'worktree', 'create', '{branch}'],
    })
  })

  test('migrate-create refuses a pipe carrying seed semantics', () => {
    const create = 'printf %s {seed} | scripts/worktree create'
    upsertProject({
      name: 'seed-pipe', path: process.cwd(), settings: { worktree: { create } } as any,
    })
    const r = orch('project', 'migrate-create', 'seed-pipe', '--apply')
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      `a pipe using {seed} cannot be migrated; the pipe must move into the project's script`,
    )
    expect(projectByName('seed-pipe')!.settings.worktree?.create as any).toBe(create)
  })

  test('migrate-create refuses every unquoted class outside the allowlist', () => {
    for (const [name, create, token, position, kind] of [
      ['backslash', 'tool foo\\ bar', '\\', 8, 'unsupported shell token'],
      ['redirection', 'printf ok > created-path', '>', 10, 'unsupported shell token'],
      ['semicolon', 'tool; other', ';', 4, 'unsupported shell token'],
      ['logical-or', 'tool || other', '|', 5, 'unsupported shell token'],
      ['dollar', 'X=$HOME tool', '$', 2, 'unsupported shell token'],
      ['backtick', 'tool `other`', '`', 5, 'unsupported shell token'],
      ['newline', 'a\nb', '\n', 1, 'unsupported shell token'],
      ['comment', 'tool # comment', '#', 5, 'unsupported shell token'],
      ['glob-star', 'tool *', '*', 5, 'unsupported shell token'],
      ['glob-question', 'tool ?', '?', 5, 'unsupported shell token'],
      ['glob-open', 'tool [ab]', '[', 5, 'unsupported shell token'],
      ['glob-close', 'tool ]', ']', 5, 'unsupported shell token'],
      ['tilde', 'tool ~', '~', 5, 'unsupported shell token'],
      ['paren-open', 'tool (x)', '(', 5, 'unsupported shell token'],
      ['paren-close', 'tool )', ')', 5, 'unsupported shell token'],
      ['brace-open', 'tool {not-closed', '{', 5, 'unsupported shell token'],
      ['brace-close', 'tool }', '}', 5, 'unsupported shell token'],
      ['bang', 'tool !', '!', 5, 'unsupported shell token'],
      ['caret', 'tool ^', '^', 5, 'unsupported shell token'],
      ['ampersand', 'tool & other', '&', 5, 'unsupported shell token'],
      ['unclosed', 'tool "foo', '"', 5, 'unclosed quote'],
    ] as const) {
      expectCreateMigrationRefused(`${name}-create`, create, token, position, kind)
    }
  }, 20_000)

  test('migrate-create accepts each ruled plain or quoted spelling', () => {
    const accepted: [string, string, WorktreeCreate][] = [
      ['plain', 'tool Az09_-./:=@,+%', { command: 'tool', args: ['Az09_-./:=@,+%'] }],
      ['placeholder', 'tool {branch}', { command: 'tool', args: ['{branch}'] }],
      ['quoted-glob', 'tool "*?[]~(){}!^"', { command: 'tool', args: ['*?[]~(){}!^'] }],
      ['quoted-comment', "tool '# comment'", { command: 'tool', args: ['# comment'] }],
      ['quoted-literal-shell', "tool '$HOME `x` foo\\ bar'", {
        command: 'tool', args: ['$HOME `x` foo\\ bar'],
      }],
      ['env', 'NAME=value tool --flag', {
        command: 'tool', args: ['--flag'], env: { NAME: 'value' },
      }],
    ]
    for (const [name, create, after] of accepted) {
      upsertProject({
        name: `accepted-${name}`, path: process.cwd(),
        settings: { worktree: { create } } as any,
      })
      const r = orch('project', 'migrate-create', `accepted-${name}`, '--apply')
      expect(r.code, name).toBe(0)
      expect(r.out, name).toContain(`accepted-${name}: after  ${JSON.stringify(after)}`)
      expect(projectByName(`accepted-${name}`)!.settings.worktree?.create, name).toEqual(after)
    }
  }, 20_000)

  test('project set records register invalidation when trunk changes', () => {
    const repo = registerRepo('main')
    try {
      upsertProject({ name: 'trunk-change', path: repo, settings: { trunk: 'main' } })
      git(repo, 'checkout', '-b', 'develop')
      const r = orchFrom(repo, 'orch-test-session', 'project', 'set', 'trunk-change', '--settings', '{"trunk":"develop"}')
      expect(r.code, r.err).toBe(0)
      expect(db().query(
        `SELECT resource_kind, event_kind, resource_key, cause FROM contention WHERE resource_kind='register'`,
      ).get()).toEqual({
        resource_kind: 'register', event_kind: 'invalidation',
        resource_key: 'trunk-change', cause: 'trunk main -> develop',
      })
      const unchanged = orchFrom(repo, 'orch-test-session', 'project', 'set', 'trunk-change', '--settings', '{"gate":"true"}')
      expect(unchanged.code, unchanged.err).toBe(0)
      expect(db().query(
        "SELECT COUNT(*) AS n FROM contention WHERE resource_kind='register'",
      ).get()).toEqual({ n: 1 })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('project set still writes when the contention table is absent', () => {
    const repo = registerRepo('main')
    try {
      upsertProject({ name: 'trunk-no-contention', path: repo, settings: { trunk: 'main' } })
      const table = db().query(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='contention'",
      ).get() as { sql: string }
      const indexes = db().query(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='contention' AND sql IS NOT NULL",
      ).all() as { sql: string }[]
      db().exec('DROP TABLE contention')
      try {
        const r = orchFrom(repo, 'orch-test-session', 'project', 'set', 'trunk-no-contention', '--settings', '{"gate":"true"}')
        expect(r.code, r.err).toBe(0)
        expect(projectByName('trunk-no-contention')!.settings.trunk).toBe('main')
        expect(projectByName('trunk-no-contention')!.settings.gate).toBe('true')
      } finally {
        db().exec(table.sql)
        for (const index of indexes) db().exec(index.sql)
      }
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('project set refuses a trunk that is not checkout HEAD, with both anchored lines', () => {
    const repo = registerRepo('main')
    try {
      upsertProject({ name: 'trunk-mismatch', path: repo, settings: { trunk: 'main' } })
      const r = orchFrom(repo, 'orch-test-session', 'project', 'set', 'trunk-mismatch', '--settings', '{"trunk":"develop"}')
      expect(r.code).toBe(1)
      expect(r.err).toContain('checkout HEAD is main, not landing branch develop')
      expect(r.err).toContain('invariant: the register landing branch agrees with the main checkout and its integration-branch canon')
      expect(r.err).toContain('cleared by:')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('project add refuses a declared trunk that is not checkout HEAD', () => {
    const repo = registerRepo('main')
    try {
      const r = orchFrom(repo, 'orch-test-session', 'project', 'add', repo, '--name', 'add-mismatch',
        '--no-canon', '--settings', '{"trunk":"develop"}')
      expect(r.code).toBe(1)
      expect(r.err).toContain('checkout HEAD is main, not landing branch develop')
      expect(r.err).toContain('invariant:')
      expect(r.err).toContain('cleared by:')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('project set refuses a landing branch that disagrees with integration-branch canon', () => {
    const repo = registerRepo('main')
    try {
      writeFileSync(join(repo, 'AGENTS.md'), 'The integration branch is develop.\n')
      git(repo, 'add', 'AGENTS.md')
      git(repo, 'commit', '-m', 'canon')
      upsertProject({ name: 'canon-mismatch', path: repo, settings: { trunk: 'main' } })
      const r = orchFrom(repo, 'orch-test-session', 'project', 'set', 'canon-mismatch', '--settings', '{"gate":"true"}')
      expect(r.code).toBe(1)
      expect(r.err).toContain('canon names integration branch develop, not landing branch main')
      expect(r.err).toContain('invariant:')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('doctor reports a checkout off its landing branch as a register question, not a failure', () => {
    const repo = registerRepo('main')
    try {
      git(repo, 'checkout', '-b', 'topic')
      upsertProject({ name: 'off-trunk', path: repo, settings: { trunk: 'main' } })
      const r = orch('doctor')
      expect(r.code, r.err).toBe(0)
      expect(r.out).toContain('register questions (not run failures):')
      expect(r.out).toContain('off-trunk: checkout HEAD is topic, not landing branch main')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('project set settings null deletes that key during a deep merge', () => {
    upsertProject({ name: 'merged', path: process.cwd(), settings: { a: { b: 1, c: 2 } } })
    const r = orch('project', 'set', 'merged', '--settings', '{"a":{"b":null}}')
    expect(r.code).toBe(0)
    expect(projects().find((project) => project.name === 'merged')?.settings).toEqual({
      a: { c: 2 },
    })
  })

  test('project set round-trips worktree readonly_notes', () => {
    upsertProject({ name: 'read-only-notes', path: process.cwd() })
    const r = orch(
      'project', 'set', 'read-only-notes', '--settings',
      '{"worktree":{"readonly_notes":"Dependencies are installed; bun run test works."}}',
    )
    expect(r.code).toBe(0)
    expect(projectByName('read-only-notes')!.settings.worktree?.readonly_notes)
      .toBe('Dependencies are installed; bun run test works.')
  })

  test('project set refuses positional settings, names the first extra, and shows the working form', () => {
    upsertProject({ name: 'positional-settings', path: process.cwd() })
    const r = orch('project', 'set', 'positional-settings', 'gate', 'bun run check')
    expect(r.code).toBe(1)
    expect(r.err).toContain('unrecognised argument: gate')
    expect(r.err).toContain(
      'working form: orch project set <name> [--name NEW] [--stack X] [--path P] [--canon|--no-canon] [--settings JSON] [--json]',
    )
    expect(projects().find((project) => project.name === 'positional-settings')?.settings).toEqual({})
  })

  test('project add and set --json print the resulting register row', () => {
    const added = orch(
      'project', 'add', dir, '--name', 'json-row', '--stack', 'first', '--no-canon', '--json',
    )
    expect(added.code).toBe(0)
    expect(JSON.parse(added.out)).toEqual(projects().find((project) => project.name === 'json-row'))

    const updated = orch('project', 'set', 'json-row', '--stack', 'second', '--canon', '--json')
    expect(updated.code).toBe(0)
    expect(JSON.parse(updated.out)).toEqual(projects().find((project) => project.name === 'json-row'))
  })

  test('write verbs print usage on --help without side effects', () => {
    upsertProject({ name: 'help-target', path: process.cwd(), settings: { trunk: 'main' } })
    const before = JSON.stringify(projectByName('help-target'))
    for (const args of [
      ['project', 'set', 'help-target', '--settings', '{"gate":"true"}', '--help'],
      ['project', 'remove', 'help-target', '--help'],
      ['note', 'would-file-this', '--help'],
      ['sweep', '--help'],
      ['answer', '1', '--help'],
      ['continue', '1', '--help'],
      ['tell', '1', '--help'],
      ['agent', 'set', 'codex', '--jobs', 'implement', '--help'],
    ]) {
      const r = orch(...args)
      expect(r.code, args.join(' ')).toBe(0)
      expect(r.out.length + r.err.length, args.join(' ')).toBeGreaterThan(0)
    }
    expect(JSON.stringify(projectByName('help-target'))).toBe(before)
  })

  test('answer and continue refuse escaped and confinement-unverified chains naming clear', () => {
    for (const kind of ['escaped', 'confinement_unverified'] as const) {
      const id = insert('failed', 'implement')
      db().query('UPDATE run SET session_id=?, failure_kind=? WHERE id=?')
        .run('orch-test-session', kind, id)
      db().query(
        'INSERT INTO question (run_id, asked_at, question, why) VALUES (?,?,?,?)',
      ).run(id, new Date().toISOString(), 'should we?', 'need a ruling')
      const answered = orch('answer', String(id), 'yes, do that')
      expect(answered.code).toBe(1)
      expect(answered.err).toContain(kind)
      expect(answered.err).toContain('invariant:')
      expect(answered.err).toContain(`orch confinement clear ${id}`)
      const continued = orch('continue', String(id), 'keep going')
      expect(continued.code).toBe(1)
      expect(continued.err).toContain(`orch confinement clear ${id}`)
    }
  })

  test('an unattributed run warns with the explicit repo remedy', () => {
    const r = orch('do', 'summarize', '--file', '/definitely/not/a/prompt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('will not be attributed to any project')
    expect(r.err).toContain('--repo <name>')
  })

  test('an explicit repo is validated before the prompt is read', () => {
    const r = orch(
      'do', 'summarize', '--repo', 'not-registered', '--file', '/definitely/not/a/prompt',
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain('unknown repo "not-registered"')
    expect(r.err).not.toContain('ENOENT')
  })

  test('abandon retires an asking run from the live inbox and keeps it in all as terminal', () => {
    const id = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', id)
    db().query(
      `INSERT INTO question (run_id, asked_at, question)
       VALUES (?, ?, 'which design?')`,
    ).run(id, new Date().toISOString())
    expect(orch('inbox').out).toContain(`run ${id}`)
    expect(orch('inbox', '--all').out).toContain(`run ${id}`)

    const abandoned = orch('abandon', String(id), '--note', 'superseded')
    expect(abandoned.code).toBe(0)
    const run = db().query(
      'SELECT status, error, failure_kind FROM run WHERE id=?',
    ).get(id) as { status: string; error: string; failure_kind: string }
    expect(run).toEqual({
      status: 'stale', error: 'abandoned by architect: superseded', failure_kind: 'abandoned',
    })
    const question = db().query(
      'SELECT answer, answered_by, answered_at, delivery_pending_at FROM question WHERE run_id=?',
    ).get(id) as { answer: string; answered_by: string; answered_at: string | null; delivery_pending_at: string | null }
    expect(question.answer).toBe('(abandoned)')
    expect(question.answered_by).toBe('orch-test-session')
    expect(question.answered_at).not.toBeNull()
    expect(question.delivery_pending_at).toBeNull()
    expect(orch('inbox').out).not.toContain(`run ${id}`)
    expect(orch('inbox', '--all').out).toContain(`run ${id}`)
    expect(orch('inbox', '--all').out).toContain('stale (terminal)')
    expect(JSON.parse(orch('inbox', '--all', '--json').out)).toContainEqual(
      expect.objectContaining({ run_id: id, status: 'stale', can_answer: false }),
    )
  }, 20_000)

  test('stop terminates a running vendor and keeps its recorded worktree', async () => {
    const vendor = Bun.spawn(['sleep', '30'])
    const id = insert('running', 'implement')
    const worktree = createWorktree(dir, id)
    db().query('UPDATE run SET agent_pid=?, cwd=?, worktree=?, branch=? WHERE id=?')
      .run(vendor.pid, worktree.path, worktree.path, worktree.branch, id)

    try {
      const stopped = orch('stop', String(id))
      expect(stopped.code).toBe(0)
      expect(stopped.out).toContain(`stopped run ${id}`)
      expect(await vendor.exited).not.toBe(0)
      expect(db().query('SELECT status, error, failure_kind, worktree FROM run WHERE id=?').get(id))
        .toEqual({
          status: 'stopped', error: 'stopped by architect', failure_kind: 'stopped', worktree: worktree.path,
        })
      expect(existsSync(worktree.path)).toBe(true)
      const candidate = candidates('implement').find((item) => item.agent === 'codex')!
      expect(candidate.evidence).toBe(0)
      expect(candidate.failures).toBe(0)
    } finally {
      try { vendor.kill() } catch { /* already stopped */ }
      if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true })
    }
  })

  test('stop succeeds but keeps a shared worktree and pointer for an unscored owner', async () => {
    const vendor = Bun.spawn(['sleep', '30'])
    const stopped = insert('running', 'implement')
    const owner = insert('failed', 'implement')
    const worktree = mkdtempSync(join(tmpdir(), 'orch-stop-shared-'))
    const evidence = join(worktree, 'evidence.txt')
    writeFileSync(evidence, 'unjudged work\n')
    db().query('UPDATE run SET agent_pid=?, worktree=?, branch=? WHERE id=?')
      .run(vendor.pid, worktree, `orch/${stopped}`, stopped)
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(worktree, `orch/${stopped}`, owner)

    try {
      const result = orch('stop', String(stopped))
      expect(result.code).toBe(0)
      expect(result.out).toContain(`stopped run ${stopped}`)
      expect(result.out).toContain(`kept worktree ${worktree}`)
      expect(await vendor.exited).not.toBe(0)
      expect(readFileSync(evidence, 'utf8')).toBe('unjudged work\n')
      expect(db().query('SELECT status, worktree FROM run WHERE id=?').get(stopped))
        .toEqual({ status: 'stopped', worktree })
    } finally {
      try { vendor.kill() } catch { /* already stopped */ }
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  test('a foreign session can neither stop nor abandon an owned run', async () => {
    const vendor = Bun.spawn(['sleep', '30'])
    const runningRoot = insert('asking', 'implement')
    const running = insert('running', 'implement')
    const askingRoot = insert('asking', 'implement')
    const asking = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id IN (?,?)')
      .run('other-session', runningRoot, askingRoot)
    db().query('UPDATE run SET parent_run_id=?, session_id=NULL, pid=? WHERE id=?')
      .run(runningRoot, vendor.pid, running)
    db().query('UPDATE run SET parent_run_id=?, session_id=NULL WHERE id=?')
      .run(askingRoot, asking)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(asking, new Date().toISOString(), 'which shape?')

    try {
      const stopped = orch('stop', String(running))
      expect(stopped.code).toBe(1)
      expect(stopped.err).toContain(`run ${running} is owned by session other-session`)
      expect((db().query('SELECT status FROM run WHERE id=?').get(running) as { status: string }).status)
        .toBe('running')
      expect(() => process.kill(vendor.pid, 0)).not.toThrow()

      const abandoned = orch('abandon', String(asking))
      expect(abandoned.code).toBe(1)
      expect(abandoned.err).toContain(`run ${asking} is owned by session other-session`)
      expect(db().query(
        'SELECT answer, answered_by, answered_at FROM question WHERE run_id=?',
      ).get(asking)).toEqual({ answer: null, answered_by: null, answered_at: null })
      expect((db().query('SELECT status FROM run WHERE id=?').get(asking) as { status: string }).status)
        .toBe('asking')
    } finally {
      vendor.kill()
      await vendor.exited
     }
  })

  test('discard resolves a child to its root owner before filesystem mutation', () => {
    const root = insert('ok', 'implement')
    const child = insert('ok', 'implement')
    const path = join(dir, 'foreign-owned-worktree')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('other-session', root)
    db().query('UPDATE run SET parent_run_id=?, worktree=? WHERE id=?').run(root, path, child)

    const discarded = orch('discard', String(child), '--force')
    expect(discarded.code).toBe(1)
    expect(discarded.err).toContain(`run ${child} is owned by session other-session`)
    expect(db().query('SELECT worktree FROM run WHERE id=?').get(child)).toEqual({ worktree: path })
    expect(db().query('SELECT COUNT(*) n FROM run_mutation_audit').get()).toEqual({ n: 0 })
  })

  test('stop refuses a run that is not running without changing it', () => {
    const id = insert('ok')
    const r = orch('stop', String(id))
    expect(r.code).toBe(1)
    expect(r.err).toContain(`run ${id}'s chain has no running turn — nothing to stop`)
    expect(r.err).toContain(`${id} turn 1 ok`)
    expect((db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }).status)
      .toBe('ok')
  })

  test('stopping a running turn records the conversation root as stopped', () => {
    const root = insert('asking', 'implement')
    const turn = insert('running', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    expect(orch('stop', String(turn)).code).toBe(0)
    expect(db().query('SELECT id, status FROM run WHERE id IN (?,?) ORDER BY id').all(root, turn))
      .toEqual([{ id: root, status: 'stopped' }, { id: turn, status: 'stopped' }])
  })

  test('stop by a chain root stops its running child turn', () => {
    const root = insert('ok', 'implement')
    const turn = insert('running', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', root)
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)

    const stopped = orch('stop', String(root))
    expect(stopped.code).toBe(0)
    expect(stopped.out).toContain(`stopped run ${turn}`)
    expect(db().query('SELECT id, status FROM run WHERE id IN (?,?) ORDER BY id').all(root, turn))
      .toEqual([{ id: root, status: 'stopped' }, { id: turn, status: 'stopped' }])
    expect(db().query(
      'SELECT run_id, root_id, action FROM run_mutation_audit WHERE root_id=?',
    ).all(root)).toEqual([{ run_id: root, root_id: root, action: 'stop' }])
  })

  test('stop waits for a concurrent continuation claim and stops the claimed turn', async () => {
    const root = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', root)
    const pending = await checkpointedOrch('stop-before-immediate', 'stop', String(root))
    const concurrent = new Database(process.env.ORCH_DB!)
    concurrent.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
    const turn = (concurrent.query(
      `INSERT INTO run
        (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,parent_run_id,turn)
       VALUES (?,'codex','implement','x',1,'x','running',?,2) RETURNING id`,
    ).get(new Date().toISOString(), root) as { id: number }).id
    writeFileSync(pending.release, 'continue may commit\n')
    await Bun.sleep(50)
    concurrent.exec('COMMIT')
    concurrent.close()

    const stopped = await lifecycleResult(pending.child)
    expect(stopped.code).toBe(0)
    expect(stopped.out).toContain(`stopped run ${turn}`)
    expect(db().query('SELECT id, status FROM run WHERE id IN (?,?) ORDER BY id').all(root, turn))
      .toEqual([{ id: root, status: 'stopped' }, { id: turn, status: 'stopped' }])
    expect(db().query('SELECT action FROM run_mutation_audit WHERE root_id=?').all(root))
      .toEqual([{ action: 'stop' }])
  }, 15_000)

  test('abandon loses cleanly to a concurrent continuation claim', async () => {
    const root = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', root)
    const pending = await checkpointedOrch('abandon-before-immediate', 'abandon', String(root))
    const concurrent = new Database(process.env.ORCH_DB!)
    concurrent.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
    const turn = (concurrent.query(
      `INSERT INTO run
        (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,parent_run_id,turn)
       VALUES (?,'codex','implement','x',1,'x','running',?,2) RETURNING id`,
    ).get(new Date().toISOString(), root) as { id: number }).id
    writeFileSync(pending.release, 'continue may commit\n')
    await Bun.sleep(50)
    concurrent.exec('COMMIT')
    concurrent.close()

    const abandoned = await lifecycleResult(pending.child)
    expect(abandoned.code).toBe(1)
    expect(abandoned.err).toContain(`${root} turn 1 asking; ${turn} turn 2 running`)
    expect(db().query('SELECT id, status FROM run WHERE id IN (?,?) ORDER BY id').all(root, turn))
      .toEqual([{ id: root, status: 'asking' }, { id: turn, status: 'running' }])
    expect(db().query('SELECT action FROM run_mutation_audit WHERE root_id=?').all(root)).toEqual([])
  }, 15_000)

  test('stop refuses when its candidate completes before the immediate transaction', async () => {
    const root = insert('asking', 'implement')
    const turn = insert('running', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', root)
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, turn)
    const pending = await checkpointedOrch('stop-before-immediate', 'stop', String(root))
    const concurrent = new Database(process.env.ORCH_DB!)
    concurrent.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
    concurrent.query("UPDATE run SET status='ok' WHERE id=?").run(turn)
    writeFileSync(pending.release, 'completion may commit\n')
    await Bun.sleep(50)
    concurrent.exec('COMMIT')
    concurrent.close()

    const stopped = await lifecycleResult(pending.child)
    expect(stopped.code).toBe(1)
    expect(stopped.err).toContain(`${root} turn 1 asking; ${turn} turn 2 ok`)
    expect(db().query('SELECT status FROM run WHERE id=?').get(root)).toEqual({ status: 'asking' })
    expect(db().query('SELECT action FROM run_mutation_audit WHERE root_id=?').all(root)).toEqual([])
  }, 15_000)

  test('abandon refuses a completed run without changing it', () => {
    const id = insert('ok')
    const r = orch('abandon', String(id))
    expect(r.code).toBe(1)
    expect(r.err).toContain(`run ${id}'s chain has no asking turn — nothing to abandon`)
    expect(r.err).toContain(`${id} turn 1 ok`)
    expect((db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }).status)
      .toBe('ok')
  })

  test('an abandoned run is not routing evidence', () => {
    const id = insert('asking', 'implement')
    expect(orch('abandon', String(id)).code).toBe(0)
    const c = candidates('implement').find((candidate) => candidate.agent === 'codex')!
    expect(c.evidence).toBe(0)
    expect(c.failures).toBe(0)
  })

  test('abandoning a resumed turn keeps the root\'s prior failure kind', () => {
    const root = insert('failed', 'implement')
    db().query("UPDATE run SET failure_kind='timeout', error='timed out' WHERE id=?").run(root)
    const child = insert('asking', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, child)
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, new Date().toISOString(), 'root question?', 'answered', new Date().toISOString())
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'child question?')

    const before = candidates('implement').find((candidate) => candidate.agent === 'codex')!
    expect(before.evidence).toBe(1)

    expect(orch('abandon', String(child)).code).toBe(0)
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(child))
      .toEqual({ status: 'stale', failure_kind: 'abandoned' })
    expect(db().query('SELECT status, error, failure_kind FROM run WHERE id=?').get(root))
      .toEqual({
        status: 'stale', error: 'abandoned by architect', failure_kind: 'timeout',
      })
    const after = candidates('implement').find((candidate) => candidate.agent === 'codex')!
    expect(after.evidence).toBe(1)
    expect(after.failures).toBe(1)
  })

  test('abandon by a chain root retires its asking child turn', () => {
    const root = insert('asking', 'implement')
    const child = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', root)
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, child)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'last question?')

    const abandoned = orch('abandon', String(root), '--note', 'superseded')
    expect(abandoned.code).toBe(0)
    expect(abandoned.out).toContain(`abandoned run ${child}`)
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(child))
      .toEqual({ status: 'stale', failure_kind: 'abandoned' })
    expect(db().query('SELECT status FROM run WHERE id=?').get(root)).toEqual({ status: 'stale' })
    expect(db().query(
      'SELECT run_id, root_id, action FROM run_mutation_audit WHERE root_id=?',
    ).all(root)).toEqual([{ run_id: root, root_id: root, action: 'abandon' }])
  })

  test('abandon does not delete a branch recorded by another run', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-abandon-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
      return p.stdout.toString().trim()
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', 'kept.txt')
      git('commit', '-m', 'base')
      git('branch', 'shared-branch')

      const abandoned = insert('asking', 'implement')
      const owner = insert('running', 'implement')
      const gone = join(repo, '.claude', 'worktrees', 'gone')
      db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
        .run(repo, gone, 'shared-branch', abandoned)
      db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, 'shared-branch', owner)

      const r = orch('abandon', String(abandoned))
      expect(r.code).toBe(0)
      expect(r.out).toContain(`branch shared-branch left because run ${owner} records it`)
      expect(git('branch', '--list', 'shared-branch')).toContain('shared-branch')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('abandon does not treat a live same-named branch in another repository as an owner', () => {
    const first = mkdtempSync(join(tmpdir(), 'orch-abandon-first-'))
    const second = mkdtempSync(join(tmpdir(), 'orch-abandon-second-'))
    const git = (repo: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      for (const repo of [first, second]) {
        git(repo, 'init', '-b', 'main')
        git(repo, 'config', 'user.email', 'orch-test@example.invalid')
        git(repo, 'config', 'user.name', 'Orch Test')
        writeFileSync(join(repo, 'kept.txt'), 'base\n')
        git(repo, 'add', 'kept.txt')
        git(repo, 'commit', '-m', 'base')
        git(repo, 'branch', 'shared-branch')
      }
      upsertProject({ name: 'abandon-first', path: first })
      upsertProject({ name: 'abandon-second', path: second })
      const abandoned = insert('asking', 'implement')
      const otherRepository = insert('running', 'implement')
      db().query('UPDATE run SET repo=?, cwd=?, worktree=NULL, branch=? WHERE id=?')
        .run('abandon-first', first, 'shared-branch', abandoned)
      db().query('UPDATE run SET repo=?, cwd=?, branch=? WHERE id=?')
        .run('abandon-second', second, 'shared-branch', otherRepository)

      const r = orch('abandon', String(abandoned))
      expect(r.code).toBe(0)
      expect(r.out).not.toContain(`run ${otherRepository} records it`)
      expect(git(first, 'branch', '--list', 'shared-branch')).toBe('')
      expect(git(second, 'branch', '--list', 'shared-branch')).toContain('shared-branch')
    } finally {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  })

  test('answer says an existing ruling stuck and reports the current status', () => {
    const id = insert('failed', 'implement')
    db().query(
      `INSERT INTO question (run_id, question, answer, asked_at, answered_at)
       VALUES (?, 'which way?', 'the ruled way', ?, ?)`,
    ).run(id, new Date().toISOString(), new Date().toISOString())
    const r = orch('answer', String(id), 'again')
    expect(r.code).toBe(1)
    expect(r.err).toContain('has already been ruled on')
    expect(r.err).toContain('current status is failed')
  })

  test('answer delivers a child turn live ruling without resuming the root', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2,
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, child)
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', root)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'which design?')
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n

    const r = orch('answer', String(root), 'use the first design')

    expect(r.code).toBe(0)
    expect(r.out).toContain('the owning turn is still working')
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(child) as
      { answer: string }).answer).toBe('use the first design')
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
  })

  test('answer reads a ruling from a file without shell interpretation', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=?, session_id=? WHERE id=?')
      .run(process.pid, 'orch-test-session', id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which names?')
    const path = join(dir, `answer-${id}.txt`)
    const ruling = 'Use $var and method(Param $x).\nKeep this line exactly.\n'
    writeFileSync(path, ruling)

    const r = orch('answer', String(id), '--file', path)

    expect(r.code).toBe(0)
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(id) as
      { answer: string }).answer).toBe(ruling)
  })

  test('answer reads a ruling from stdin without shell interpretation', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=?, session_id=? WHERE id=?')
      .run(process.pid, 'orch-test-session', id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which names?')
    const ruling = 'Use $var and method(Param $x).\nKeep this line exactly.\n'

    const r = orchInput(['answer', String(id)], ruling)

    expect(r.code).toBe(0)
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(id) as
      { answer: string }).answer).toBe(ruling)
  })

  test('answer --q<id> --file reads the file and never stores the flag name', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which design?')
    const qid = (db().query('SELECT id FROM question WHERE run_id=?').get(id) as { id: number }).id
    const path = join(dir, `answer-q-file-${id}.txt`)
    const ruling = 'Choose the first design.\nKeep the public shape.\n'
    writeFileSync(path, ruling)

    const r = orch('answer', String(id), `--q${qid}`, '--file', path)

    expect(r.code).toBe(0)
    expect((db().query('SELECT answer FROM question WHERE id=?').get(qid) as
      { answer: string }).answer).toBe(ruling)
    expect((db().query('SELECT answer FROM question WHERE id=?').get(qid) as
      { answer: string }).answer).not.toBe('--file')
  })

  test('a ruling of --file alone is refused and not stored', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which design?')
    const qid = (db().query('SELECT id FROM question WHERE run_id=?').get(id) as { id: number }).id
    const stored = () => (db().query('SELECT answer FROM question WHERE id=?').get(qid) as
      { answer: string | null }).answer

    const missingPath = orch('answer', String(id), `--q${qid}`, '--file')
    expect(missingPath.code).toBe(1)
    expect(missingPath.err).toContain('argument --file needs a value')
    expect(stored()).toBeNull()

    const asEquals = orch('answer', String(id), `--q${qid}=--file`)
    expect(asEquals.code).toBe(1)
    expect(asEquals.err).toContain('received "--file" as a ruling')
    expect(asEquals.err).toContain('orch answer <id> --q<id> --file <path>')
    expect(stored()).toBeNull()

    const path = join(dir, `answer-dash-token-${id}.txt`)
    writeFileSync(path, '--file')
    const fromFile = orch('answer', String(id), `--q${qid}`, '--file', path)
    expect(fromFile.code).toBe(1)
    expect(fromFile.err).toContain('received "--file" as a ruling')
    expect(stored()).toBeNull()
  }, 20_000)

  test('a ruling containing backticks and command substitution is stored byte-for-byte from --file', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which names?')
    const path = join(dir, `answer-backticks-${id}.txt`)
    const ruling = 'Never run `git stash push` or $(git stash pop) against the shared checkout.\n'
    writeFileSync(path, ruling)

    const r = orch('answer', String(id), '--file', path)

    expect(r.code).toBe(0)
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(id) as
      { answer: string }).answer).toBe(ruling)
  })

  test('multi-question answer mixes positional --q text with per-question --file', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'first?')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'second?')
    const questions = db().query('SELECT id FROM question WHERE run_id=? ORDER BY id')
      .all(id) as { id: number }[]
    const path = join(dir, `answer-mixed-${id}.txt`)
    writeFileSync(path, 'from the file\n')

    const r = orch(
      'answer', String(id),
      `--q${questions[0]!.id}`, 'positional ruling',
      `--q${questions[1]!.id}`, '--file', path,
    )

    expect(r.code).toBe(0)
    expect((db().query('SELECT answer FROM question WHERE id=?').get(questions[0]!.id) as
      { answer: string }).answer).toBe('positional ruling')
    expect((db().query('SELECT answer FROM question WHERE id=?').get(questions[1]!.id) as
      { answer: string }).answer).toBe('from the file\n')
  })

  test('a multi-word positional ruling is stored whole, not just the first word', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which design?')

    const r = orch('answer', String(id), 'alpha', 'beta', 'gamma')

    expect(r.code).toBe(0)
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(id) as
      { answer: string }).answer).toBe('alpha beta gamma')
  })

  test('a two-word message beginning with -- is accepted as a ruling', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which design?')

    const r = orch('answer', String(id), '--literal is intended')

    expect(r.code).toBe(0)
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(id) as
      { answer: string }).answer).toBe('--literal is intended')
  })

  test('a --q naming a question that is not open on this chain refuses the whole command', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'on this chain?')
    const qid = (db().query('SELECT id FROM question WHERE run_id=?').get(id) as { id: number }).id
    const other = insert('running', 'implement')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(other, new Date().toISOString(), 'on another chain?')
    const alien = (db().query('SELECT id FROM question WHERE run_id=?').get(other) as
      { id: number }).id

    const r = orch('answer', String(id), `--q${qid}`, 'valid', `--q${alien}`, 'alien')

    expect(r.code).toBe(1)
    expect(r.err).toContain(`--q${alien} belongs to run ${other}, not this chain`)
    expect(r.err).toContain('nothing was stored')
    expect((db().query('SELECT answer FROM question WHERE id=?').get(qid) as
      { answer: string | null }).answer).toBeNull()
    expect((db().query('SELECT answer FROM question WHERE id=?').get(alien) as
      { answer: string | null }).answer).toBeNull()
  })

  test('a closed or duplicate --q refuses the whole command', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    const now = new Date().toISOString()
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?, ?, 'already done?', 'yes', ?)`,
    ).run(id, now, now)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, now, 'still open?')
    const rows = db().query('SELECT id, answered_at FROM question WHERE run_id=? ORDER BY id')
      .all(id) as { id: number; answered_at: string | null }[]
    const closed = rows.find((q) => q.answered_at)!.id
    const openId = rows.find((q) => !q.answered_at)!.id

    const closedR = orch('answer', String(id), `--q${closed}`, 'again', `--q${openId}`, 'ok')
    expect(closedR.code).toBe(1)
    expect(closedR.err).toContain(`--q${closed} on run ${id} is already closed`)
    expect((db().query('SELECT answer FROM question WHERE id=?').get(openId) as
      { answer: string | null }).answer).toBeNull()

    const dup = orch('answer', String(id), `--q${openId}`, 'one', `--q${openId}`, 'two')
    expect(dup.code).toBe(1)
    expect(dup.err).toContain(`--q${openId} given more than once`)
    expect((db().query('SELECT answer FROM question WHERE id=?').get(openId) as
      { answer: string | null }).answer).toBeNull()
  })

  test('answer --file refuses invalid UTF-8 at the byte offset', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which design?')
    const path = join(dir, `answer-bad-utf8-${id}.bin`)
    writeFileSync(path, Buffer.from([0x66, 0x80, 0xff, 0x67]))

    const r = orch('answer', String(id), '--file', path)

    expect(r.code).toBe(1)
    expect(r.err).toContain('invalid UTF-8')
    expect(r.err).toContain('byte offset 1')
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(id) as
      { answer: string | null }).answer).toBeNull()
  })

  test('answer stdin refuses invalid UTF-8 at the byte offset', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which design?')
    const r = orchInput(['answer', String(id)], Buffer.from([0x66, 0x80, 0xff, 0x67]))
    expect(r.code).toBe(1)
    expect(r.err).toContain('invalid UTF-8')
    expect(r.err).toContain('byte offset 1')
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(id) as
      { answer: string | null }).answer).toBeNull()
  })

  test('answer keeps flag-shaped words after the message starts', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which design?')
    const r = orch('answer', String(id), 'use', '--quiet', 'mode')
    expect(r.code).toBe(0)
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(id) as
      { answer: string }).answer).toBe('use --quiet mode')
  })

  test('answer stdin refuses whitespace-only input', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which design?')
    const r = orchInput(['answer', String(id)], Buffer.from([0x20, 0x09, 0x0d, 0x0a]))
    expect(r.code).toBe(1)
    expect(r.err).toContain('empty ruling')
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(id) as
      { answer: string | null }).answer).toBeNull()
  })

  test('a partial multi-question ruling names the single-command rule', () => {
    const id = insert('running', 'implement')
    db().query('UPDATE run SET pid=?, session_id=? WHERE id=?')
      .run(process.pid, 'orch-test-session', id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'first?')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'second?')
    const questions = db().query('SELECT id FROM question WHERE run_id=? ORDER BY id')
      .all(id) as { id: number }[]

    const r = orch('answer', String(id), `--q${questions[0]!.id}`, 'only one')

    expect(r.code).toBe(1)
    expect(r.err).toContain('pass every --q<id> in a single command')
    expect((db().query('SELECT COUNT(*) n FROM question WHERE answered_at IS NOT NULL').get() as
      { n: number }).n).toBe(0)
  })

  test('answer resumes a durable root question when no child is running', async () => {
    const root = addRun({ agent: 'missing-test-agent', job: 'implement', status: 'asking' })
    const prompt = join(dir, `answer-root-${root}.prompt.txt`)
    writeFileSync(prompt, 'original implementation spec')
    db().query('UPDATE run SET vendor_session=?, prompt_path=? WHERE id=?')
      .run('test-session', prompt, root)
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', root)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(root, new Date().toISOString(), 'which design?')
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n

    const r = orch('answer', String(root), 'use the first design')

    expect(r.code).toBe(0)
    expect(r.out).toContain(`resumed run ${root} as run`)
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before + 1)
    const resumed = db().query(
      'SELECT id FROM run WHERE id > ? ORDER BY id DESC LIMIT 1',
    ).get(root) as { id: number }

    for (let i = 0; i < 100; i++) {
      const status = (db().query('SELECT status FROM run WHERE id=?').get(resumed.id) as
        { status: string }).status
      if (status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })


  test('project list JSON satisfies the hub contract and a field hub reads cannot be dropped', () => {
    upsertProject({ name: 'contract-project', path: process.cwd(), settings: {} })
    const listed = orch('project', 'list', '--json')
    expect(listed.code).toBe(0)
    const document = JSON.parse(listed.out) as Record<string, unknown>[]
    expect(() => OrchProjectListSchema.parse(document)).not.toThrow()
    expect(document[0]).toMatchObject({ commit_hooks_skipped: true })
    delete document[0]!.path
    expect(() => OrchProjectListSchema.parse(document)).toThrow()
  })
})
