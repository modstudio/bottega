import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { OrchProjectListSchema } from '../../shared/orch-contract.ts'
import { db, declaredCreate, dir, hermeticGitEnv, projectByName, projects, upsertProject } from '../test/fixture.ts'
import { flagValue } from './args.ts'
import { projectCommand } from './project-commands.ts'

function invoke(...argv: string[]) {
  const lines: string[] = []
  const flags = {
    has: (name: string) => argv.includes(`--${name}`),
    flag: (name: string) => flagValue(argv, name),
  }
  try {
    projectCommand(argv[1] ?? 'list', argv, flags, {
      log: (...values) => lines.push(values.join(' ')),
      cwd: () => process.cwd(),
    })
    return { code: 0, out: lines.join('\n'), err: '' }
  } catch (error) {
    return { code: 1, out: lines.join('\n'), err: String(error) }
  }
}

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
const expectCreateMigrationRefused = (
  name: string, create: string, token: string, position: number,
  kind = 'unsupported shell token',
) => {
  upsertProject({ name, path: process.cwd(), settings: { worktree: { create } } as any })
  const result = invoke('project', 'migrate-create', name, '--apply')
  expect(result.code).toBe(0)
  expect(result.out).toContain(`${kind} ${JSON.stringify(token)} at position ${position}; cannot migrate`)
  expect(projectByName(name)!.settings.worktree?.create as any).toBe(create)
}

  test('project set refuses incomplete resulting settings without saving them', () => {
    upsertProject({ name: 'warned', path: process.cwd() })
    const r = invoke(
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
    const r = invoke(
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
    const r = invoke(
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
      const r = invoke(
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
    const r = invoke(
      'project', 'set', 'pipeline-create', '--settings',
      JSON.stringify({ worktree: { create: { pipeline }, branch: 'task/{id}' } }),
      '--allow-incomplete',
    )
    expect(r.code).toBe(0)
    expect(projectByName('pipeline-create')!.settings.worktree?.create).toEqual({ pipeline })
  })

  test('project set validates command environment values and their placeholders', () => {
    upsertProject({ name: 'create-env', path: process.cwd() })
    const valid = invoke(
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
      const r = invoke(
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
    const text = invoke('project', 'list')
    expect(text.code).toBe(0)
    expect(text.out).toContain(
      'legacy-list: worktree.create is a shell string; migrate it (DEV-308)',
    )
    expect(text.out.match(/legacy-list: worktree\.create is a shell string/g)).toHaveLength(1)

    const json = invoke('project', 'list', '--json')
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
      const r = invoke('project', 'migrate-create', name)
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
    const recipe = invoke('project', 'migrate-create', PLATFORM_SLUG)
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
    const r = invoke('project', 'migrate-create', 'apply-create', '--apply')
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
    const r = invoke('project', 'migrate-create', 'seed-pipe', '--apply')
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
      const r = invoke('project', 'migrate-create', `accepted-${name}`, '--apply')
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
      const r = invoke('project', 'set', 'trunk-change', '--settings', '{"trunk":"develop"}')
      expect(r.code, r.err).toBe(0)
      expect(db().query(
        `SELECT resource_kind, event_kind, resource_key, cause FROM contention WHERE resource_kind='register'`,
      ).get()).toEqual({
        resource_kind: 'register', event_kind: 'invalidation',
        resource_key: 'trunk-change', cause: 'trunk main -> develop',
      })
      const unchanged = invoke('project', 'set', 'trunk-change', '--settings', '{"gate":"true"}')
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
        const r = invoke('project', 'set', 'trunk-no-contention', '--settings', '{"gate":"true"}')
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
      const r = invoke('project', 'set', 'trunk-mismatch', '--settings', '{"trunk":"develop"}')
      expect(r.code).toBe(1)
      expect(r.err).toContain('checkout HEAD is main, not landing branch develop')
      expect(r.err).toContain('invariant: the register landing branch agrees with the main checkout and its integration-branch canon')
      expect(r.err).toContain('cleared by:')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('project add refuses a declared trunk that is not checkout HEAD', () => {
    const repo = registerRepo('main')
    try {
      const r = invoke('project', 'add', repo, '--name', 'add-mismatch',
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
      const r = invoke('project', 'set', 'canon-mismatch', '--settings', '{"gate":"true"}')
      expect(r.code).toBe(1)
      expect(r.err).toContain('canon names integration branch develop, not landing branch main')
      expect(r.err).toContain('invariant:')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })


  test('project set settings null deletes that key during a deep merge', () => {
    upsertProject({ name: 'merged', path: process.cwd(), settings: { a: { b: 1, c: 2 } } })
    const r = invoke('project', 'set', 'merged', '--settings', '{"a":{"b":null}}')
    expect(r.code).toBe(0)
    expect(projects().find((project) => project.name === 'merged')?.settings).toEqual({
      a: { c: 2 },
    })
  })

  test('project set round-trips worktree readonly_notes', () => {
    upsertProject({ name: 'read-only-notes', path: process.cwd() })
    const r = invoke(
      'project', 'set', 'read-only-notes', '--settings',
      '{"worktree":{"readonly_notes":"Dependencies are installed; bun run test works."}}',
    )
    expect(r.code).toBe(0)
    expect(projectByName('read-only-notes')!.settings.worktree?.readonly_notes)
      .toBe('Dependencies are installed; bun run test works.')
  })


  test('project add and set --json print the resulting register row', () => {
    const added = invoke(
      'project', 'add', dir, '--name', 'json-row', '--stack', 'first', '--no-canon', '--json',
    )
    expect(added.code).toBe(0)
    expect(JSON.parse(added.out)).toEqual(projects().find((project) => project.name === 'json-row'))

    const updated = invoke('project', 'set', 'json-row', '--stack', 'second', '--canon', '--json')
    expect(updated.code).toBe(0)
    expect(JSON.parse(updated.out)).toEqual(projects().find((project) => project.name === 'json-row'))
  })


  test('project list JSON satisfies the hub contract and a field hub reads cannot be dropped', () => {
    upsertProject({ name: 'contract-project', path: process.cwd(), settings: {} })
    const listed = invoke('project', 'list', '--json')
    expect(listed.code).toBe(0)
    const document = JSON.parse(listed.out) as Record<string, unknown>[]
    expect(() => OrchProjectListSchema.parse(document)).not.toThrow()
    expect(document[0]).toMatchObject({ commit_hooks_skipped: true })
    delete document[0]!.path
    expect(() => OrchProjectListSchema.parse(document)).toThrow()
  })
