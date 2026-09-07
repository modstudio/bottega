import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { WorktreeCreate } from './projects.ts'
import { AGENTS, addRun, branchTip, compoundCreate, createArgv, createReadOnlyWithTool, createReadOnlyWorktree, createWithTool, createWorktree, db, declaredCreate, fill, fillTool, hermeticGitCommand, hermeticGitEnv, preflight, prepareSharedRefGuard, removeFor, repoRootOf, resolveReviewTarget, runJob, seedArgv, upsertProject } from '../test/fixture.ts'

import { worktreeDescribeFixture } from '../test/fixture.ts'

describe("a worktree is resolved against the main checkout, not the caller cwd", () => {
  const { fromRoot, git, scratchRepo } = worktreeDescribeFixture()
test('review-lens preflight requires a git checkout', () => {
    const outside = mkdtempSync(join(tmpdir(), 'orch-no-repo-'))
    const { repo } = scratchRepo()
    const priorDepth = process.env.ORCH_DEPTH
    try {
      process.env.ORCH_DEPTH = '0'
      expect(() => preflight('review-lens', outside, undefined, undefined, undefined, false, false, 'scope')).toThrow('not inside a git checkout')
      expect(() => preflight('review-lens', repo, undefined, undefined, undefined, false, false, 'scope')).not.toThrow()
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(outside, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('preflight refuses a create command without a branch template', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'no-branch', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}']) } },
    })
    expect(() => fromRoot(() => preflight('implement', repo))).toThrow(
      'orch project set no-branch --settings \'{"worktree":{"branch":"<template>"}}\'',
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight lets a legacy create reach worktree creation with its string arguments', () => {
    const { repo } = scratchRepo()
    const capture = join(repo, 'legacy-create-argv')
    const createTool = join(repo, 'legacy-create')
    writeFileSync(createTool, `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(capture)}
exit 17
`)
    chmodSync(createTool, 0o755)
    const create = `${createTool} create "{branch}"`
    upsertProject({
      name: 'legacy-preflight', path: realpathSync(repo),
      settings: {
        worktree: { create, branch: 'task/{id}' },
      } as any,
    })
    const before = (db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n
    const r = Bun.spawnSync([
      process.execPath, new URL('cli.ts', import.meta.url).pathname,
      'do', 'implement', 'inspect', '--follow',
    ], {
      cwd: repo,
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.toString()).toContain("the project's worktree tool failed")
    const created = db().query('SELECT id FROM run ORDER BY id DESC LIMIT 1').get() as { id: number }
    expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual([
      'create', `task/${created.id}`,
    ])
    expect(createArgv(create, { branch: `task/${created.id}` })).toEqual([
      'sh', '-c', `${createTool} create "task/${created.id}"`,
    ])
    expect((db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n).toBe(before + 1)
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight refuses a structured create missing args before any run row exists', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'malformed-preflight', path: realpathSync(repo),
      settings: {
        worktree: { create: { command: 'scripts/worktree' }, branch: 'task/{id}' },
      } as any,
    })
    const before = (db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n
    const r = Bun.spawnSync([
      process.execPath, new URL('cli.ts', import.meta.url).pathname, 'do', 'implement', 'inspect',
    ], {
      cwd: repo,
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.toString()).toContain('worktree.create.args must be an array')
    expect((db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n).toBe(before)
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight refuses an explicit base a command template cannot honor', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'no-base-placeholder', path: realpathSync(repo),
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}']), branch: 'task/{id}',
        },
      },
    })
    try {
      expect(() => fromRoot(() => preflight(
        'implement', realpathSync(repo), undefined, undefined, 'main',
      )))
        .toThrow(
          'project no-base-placeholder cannot honour --base because its worktree create template ' +
          '{"command":"scripts/worktree","args":["create","{branch}"]} has no {base} slot',
        )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('explicit review names a command recipe that cannot accept its base', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'adanim-fixture', path: repo,
      settings: {
        trunk: 'main',
        worktree: {
          create: declaredCreate('worktree-create', ['{branch}']),
          branch: 'review/{id}', seeds: [],
        },
      },
    })
    expect(() => fromRoot(() => preflight(
      'review-lens', repo, undefined, undefined, undefined, false, false,
      'correctness', 'feature/reviewed',
    ))).toThrow(
      'project adanim-fixture: worktree.create has no {base} placeholder; --review needs one',
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('explicit review refuses a command recipe without declared detached support', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'attached-review-fixture', path: repo,
      settings: {
        trunk: 'main',
        worktree: {
          create: declaredCreate('worktree-create', ['{branch}', '{base}']),
          branch: 'review/{id}', seeds: [],
        },
      },
    })
    expect(() => fromRoot(() => preflight(
      'review-lens', repo, undefined, undefined, undefined, false, false,
      'correctness', 'feature/reviewed',
    ))).toThrow(
      `project attached-review-fixture: worktree.create does not declare detached review support.\n` +
      `  orch project set attached-review-fixture --settings '{"worktree":{"detached":true}}'`,
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight refuses shell metacharacters in a key', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'bad-key', path: repo,
      settings: { worktree: { recipe: {}, branch: '{key}-orch-{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo, undefined, 'DEV-70; touch nope')))
      .toThrow('key "DEV-70; touch nope" does not match ^[A-Z][A-Z0-9]+-[0-9]+$')
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight reports missing key and seed together', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'missing-arguments', path: repo,
      settings: {
        worktree: {
          create: declaredCreate(process.execPath, ['create', '{branch}', '{seed}']), branch: '{key}-orch-{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    expect(() => fromRoot(() => preflight('implement', repo))).toThrow(
      `this project's branch names must carry a ticket key ({key}-orch-{id}), and orch will ` +
      `not invent one.\n  --key <KEY-123>\n` +
      `this project requires a database size for a new worktree, and has no default.\n` +
      `  --seed small\n  --seed=small\n  --seed full\n  --seed=full\n` +
      `Multi-token seed specs must be quoted as one value, for example:\n` +
      `  --seed "--bundle=catalog --budget-mb=700"\n` +
      `  --seed="--bundle=catalog --budget-mb=700"\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
    expect(() => fromRoot(() => preflight('implement', repo, 'small'))).toThrow(
      `this project's branch names must carry a ticket key ({key}-orch-{id}), and orch will ` +
      `not invent one.\n  --key <KEY-123>`,
    )
    expect(() => fromRoot(() => preflight('implement', repo, undefined, 'DEV-61'))).toThrow(
      `this project requires a database size for a new worktree, and has no default.\n` +
      `  --seed small\n  --seed=small\n  --seed full\n  --seed=full\n` +
      `Multi-token seed specs must be quoted as one value, for example:\n` +
      `  --seed "--bundle=catalog --budget-mb=700"\n` +
      `  --seed="--bundle=catalog --budget-mb=700"\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('read-only preflight does not require a writing branch key and refuses seeds', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'read-only-arguments', path: repo,
      settings: {
        worktree: {
          create: declaredCreate(process.execPath, ['create', '{branch}', '{seed}']), branch: '{key}-orch-{id}',
          seeds: ['none', 'small', 'full'],
        },
      },
    })
    expect(fromRoot(() => preflight(
      'review-lens', repo, undefined, undefined, undefined, false, false, 'safety',
    ))).toBeUndefined()
    expect(fromRoot(() => preflight(
      'review-lens', repo, undefined, 'DEV-264', undefined, false, false, 'safety',
    ))).toBeUndefined()
    expect(() => fromRoot(() => preflight(
      'review-lens', repo, 'small', 'DEV-264', undefined, false, false, 'safety',
    ))).toThrow('seeds belong to writing runs')
    rmSync(repo, { recursive: true, force: true })
  })

  test('jobs that cut no worktree do not require the branch template key', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'inline-no-key', path: repo,
      settings: { worktree: { recipe: {}, branch: '{key}-orch-{id}' } },
    })
    expect(() => fromRoot(() => preflight('summarize', repo))).not.toThrow()
    expect(() => fromRoot(() => preflight(
      'review-lens-inline', repo, undefined, undefined, undefined, false, false, 'inline',
    ))).not.toThrow()
    rmSync(repo, { recursive: true, force: true })
  })

  test('read-only preflight ignores a writing recipe seed list', () => {
    const { repo } = scratchRepo()
    const trees = join(repo, '.claude', 'worktrees')
    upsertProject({
      name: 'read-only-no-none', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']), branch: 'task/{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    const before = readdirSync(trees).sort()
    expect(fromRoot(() => preflight(
      'review-lens', repo, undefined, undefined, undefined, false, false, 'safety',
    ))).toBeUndefined()
    expect(readdirSync(trees).sort()).toEqual(before)
    rmSync(repo, { recursive: true, force: true })
  })

  test('read-only preflight leaves a project without listed seeds unaffected', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'read-only-unseeded', path: repo,
      settings: { worktree: { create: declaredCreate(process.execPath, ['create', '{branch}']), branch: 'task/{id}' } },
    })
    expect(fromRoot(() => preflight(
      'review-lens', repo, undefined, undefined, undefined, false, false, 'safety',
    ))).toBeUndefined()
    rmSync(repo, { recursive: true, force: true })
  })

  test('fill shell-quotes unquoted values and respects existing quotes', () => {
    const value = "two words' ; echo nope"
    for (const render of [fill, fillTool]) {
      expect(render('cmd {name}', { name: value })).toBe("cmd 'two words'\\'' ; echo nope'")
      expect(render("cmd '{name}'", { name: value })).toBe("cmd 'two words'\\'' ; echo nope'")
      expect(render('cmd "{name}"', { name: value })).toBe("cmd \"two words' ; echo nope\"")
    }
  })

  test('structured create declarations render argv without a shell', () => {
    const vars = {
      branch: 'technical/DEV-70-orch-804', seed: 'none', name: 'orch-804',
      path: '/tmp/orch-804', base: '', key: 'DEV-70',
    }
    expect(createArgv(declaredCreate('scripts/worktree', [
      'add', '{branch}', '{base}', { expand: 'seed' }, '--name={name}',
    ]), vars)).toEqual([
      'scripts/worktree', 'add', 'technical/DEV-70-orch-804', '', 'none', '--name=orch-804',
    ])
    expect(createArgv(declaredCreate('bun', [
      'run', 'worktree', 'create', '{branch}',
      { value: '--base={base}', omitWhenEmpty: 'base' },
    ]), vars)).toEqual([
      'bun', 'run', 'worktree', 'create', 'technical/DEV-70-orch-804',
    ])
    expect(createArgv(declaredCreate('bun', [
      'run', 'worktree', 'create', '{branch}',
      { value: '--base={base}', omitWhenEmpty: 'base' },
    ]), { ...vars, base: 'abc123' })).toEqual([
      'bun', 'run', 'worktree', 'create', 'technical/DEV-70-orch-804', '--base=abc123',
    ])
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

  test('preflight refuses a create placeholder without --seed even when no seeds are listed', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'no-seed', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{seed}']), branch: 'task/{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo))).toThrow(
      'contain {seed}, so a seed is required',
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight passes a project-specific seed spec intact to the project resolver', () => {
    const { repo } = scratchRepo()
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const received = join(repo, 'received-seed')
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
if [ "$#" -eq 0 ]; then echo 'scripts/worktree resolve [seed]'; exit 0; fi
if [ "$1" = resolve ]; then
  shift
  for arg in "$@"; do printf '%s\\n' "$arg" >> "${received}"; done
  printf -- '---\\n' >> "${received}"
  exit 0
fi
exit 1
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'custom-seed', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', { expand: 'seed' }]), branch: 'task/{id}',
          seeds: ['none', 'minimal', 'full'],
        },
      },
    })
    const seeds = [
      '--full --budget-mb=2000', '--bundle=tanach --bundle=word-bank',
      'none', 'minimal', 'full',
    ]
    for (const seed of seeds) {
      expect(() => fromRoot(() => preflight('implement', repo, seed))).not.toThrow()
    }
    expect(readFileSync(received, 'utf8')).toBe(
      '--full\n--budget-mb=2000\n---\n' +
      '--bundle=tanach\n--bundle=word-bank\n---\n' +
      'none\n---\nminimal\n---\nfull\n---\n',
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('resolver argv equals the explicitly expanded create argv', () => {
    const positional = declaredCreate('scripts/worktree', [
      'add', '{branch}', '{base}', { expand: 'seed' }, '--name={name}',
    ])
    const scalar = declaredCreate('env', [
      'WORKTREE_SEED={seed}', 'scripts/worktree', 'add', '{branch}', '{base}',
    ])
    const vars = { branch: 'b', name: 'n', base: '', key: '', path: '' }
    for (const seed of ['--full --budget-mb=2000', "--tables='hello world'"]) {
      const rendered = createArgv(positional, { ...vars, seed })!
      const resolveArgv = seedArgv(positional, seed)
      expect(rendered.slice(4, -1)).toEqual(resolveArgv)
    }
    expect(seedArgv(scalar, '--full --budget-mb=2000')).toEqual(['--full --budget-mb=2000'])
    expect(seedArgv(scalar, "--tables='hello world'")).toEqual(["--tables='hello world'"])
  })

  test('a scalar seed argument keeps the seed as one resolve argv', () => {
    const { repo } = scratchRepo()
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const received = join(repo, 'received-seed')
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
if [ "$#" -eq 0 ]; then echo 'scripts/worktree resolve [seed]'; exit 0; fi
if [ "$1" = resolve ]; then
  shift
  for arg in "$@"; do printf '%s\\n' "$arg" >> "${received}"; done
  exit 0
fi
exit 1
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'quoted-seed', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('env', ['WORKTREE_SEED={seed}', 'scripts/worktree', 'add', '{branch}']),
          branch: 'task/{id}',
        },
      },
    })
    expect(() => fromRoot(() => preflight('implement', repo, '--full --budget-mb=2000')))
      .not.toThrow()
    expect(readFileSync(received, 'utf8')).toBe('--full --budget-mb=2000\n')
    rmSync(repo, { recursive: true, force: true })
  })

  test('a resolver refusal happens before a run row or worktree can exist', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-rejected-seed-'))
    git(repo, 'init', '-b', 'main')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const created = join(repo, 'create-ran')
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
if [ "$#" -eq 0 ]; then echo 'scripts/worktree resolve [seed]'; exit 0; fi
if [ "$1" = resolve ]; then echo 'over budget' >&2; exit 2; fi
touch "${created}"
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'rejected-seed', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{seed}']), branch: 'task/{id}', seeds: ['full'],
        },
      },
    })
    const started = performance.now()
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      await expect(runJob({ job: 'implement', prompt: 'change it', cwd: repo, seed: 'full' }))
        .rejects.toThrow("the project's seed resolver rejected the seed:\nover budget")
      expect(performance.now() - started).toBeLessThan(1000)
      expect(existsSync(created)).toBe(false)
      expect(existsSync(join(repo, '.claude', 'worktrees'))).toBe(false)
      expect((db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n).toBe(0)
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a resolver failure is not treated as a successful check', () => {
    const { repo } = scratchRepo()
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
if [ "$#" -eq 0 ]; then echo 'scripts/worktree resolve [seed]'; exit 0; fi
echo 'catalog unreachable' >&2
exit 1
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'unchecked-seed', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{seed}']), branch: 'task/{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo, 'minimal'))).toThrow(
      "the project's seed resolver rejected the seed or could not check it:\ncatalog unreachable",
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('a project whose worktree tool exposes no resolver still accepts its seed', () => {
    const { repo } = scratchRepo()
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    const tool = join(repo, 'scripts', 'worktree')
    writeFileSync(tool, `#!/bin/sh
echo 'Usage: scripts/worktree create [seed]'
`)
    chmodSync(tool, 0o755)
    upsertProject({
      name: 'no-resolver', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{seed}']), branch: 'task/{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo, '--anything=project-specific')))
      .not.toThrow()
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight accepts a branch template and a listed seed', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'good-tool', path: repo,
      settings: {
        worktree: {
          create: declaredCreate(process.execPath, ['create', '{branch}', '{seed}']), branch: 'task/{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    expect(() => fromRoot(() => preflight('implement', repo, 'small'))).not.toThrow()
    rmSync(repo, { recursive: true, force: true })
  })

  test('from inside a worktree, repoRootOf is the main checkout, not this tree', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    try {
      process.chdir(tree)
      const got = repoRootOf(process.cwd())
      expect(got).not.toBeNull()
      expect(realpathSync(got!)).toBe(realpathSync(repo))
      expect(realpathSync(got!)).not.toBe(realpathSync(tree))
      // And the naive --show-toplevel answer, which is what shipped, is the
      // worktree itself. If this ever stops being true the bug cannot recur
      // in the same shape and the test should be rewritten, not weakened.
      const toplevel = git(process.cwd(), 'rev-parse', '--show-toplevel')
      expect(realpathSync(toplevel)).toBe(realpathSync(tree))
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
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

  test('a recipe-project read-only run records git source and warns that infrastructure is absent', async () => {
    const { repo, tree } = scratchRepo()
    const invoked = join(repo, 'writing-create-invoked')
    writeFileSync(join(tree, 'feature.txt'), 'feature state\n')
    git(tree, 'add', 'feature.txt')
    git(tree, 'commit', '-m', 'feature state')
    const featureHead = git(tree, 'rev-parse', 'HEAD')
    expect(featureHead).not.toBe(git(repo, 'rev-parse', 'main'))
    upsertProject({
      name: 'read-only-run-recipe', path: repo,
      settings: { worktree: {
        create: declaredCreate(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(invoked)}, 'yes')`]),
        remove: `printf removed`, branch: '{key}-orch-{id}', seeds: ['full'],
      } },
    })
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    let sent = ''
    try {
      agent.bin = process.execPath
      agent.readsOut = false
      agent.argv = ({ prompt }) => {
        sent = prompt
        return ['-e', 'console.log("inspected")']
      }
      process.env.ORCH_DEPTH = '0'
      const result = await runJob({ job: 'file-question', prompt: 'inspect', cwd: tree, agent: 'codex' })
      expect(existsSync(invoked)).toBe(false)
      expect(result.worktree?.source).toBe('git')
      expect(result.worktree?.base).toBe(featureHead)
      expect(git(result.worktree!.path, 'rev-parse', 'HEAD')).toBe(featureHead)
      expect(Bun.spawnSync(['git', 'symbolic-ref', '-q', 'HEAD'], { cwd: result.worktree!.path }).exitCode).not.toBe(0)
      expect(db().query('SELECT worktree_source, branch FROM run WHERE id=?').get(result.id))
        .toEqual({ worktree_source: 'git', branch: null })
      expect(sent).toContain('NO provisioned infrastructure')
      expect(sent).toContain(`project's files at ${featureHead}`)
      expect(sent).toContain('no databases, no generated env, no vendor tree')
      expect(sent).toContain('could_not_verify')
      expect(removeFor(result.worktree!, repo).removed).toBe(true)
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a read-only run uses the project\'s declared infrastructure note', async () => {
    const { repo, tree } = scratchRepo()
    const note = 'Dependencies are installed and bun run test uses in-process PGlite.'
    upsertProject({
      name: 'read-only-run-notes', path: repo,
      settings: { worktree: { recipe: {}, readonly_notes: note } },
    })
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
    let sent = ''
    try {
      agent.bin = process.execPath
      agent.readsOut = false
      agent.argv = ({ prompt }) => {
        sent = prompt
        return ['-e', 'console.log("inspected")']
      }
      process.env.ORCH_DEPTH = '0'
      const result = await runJob({ job: 'file-question', prompt: 'inspect', cwd: tree, agent: 'codex' })
      expect(sent).toContain(`This read-only run has the project's files at ${result.worktree!.base}. ${note}`)
      expect(sent).not.toContain('NO provisioned infrastructure')
      expect(sent).toContain('record what you could not run in could_not_verify')
      expect(removeFor(result.worktree!, repo).removed).toBe(true)
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a structured create expands env placeholders and overlays process env', () => {
    const { repo } = scratchRepo()
    const script = join(repo, 'scripts', 'create-with-env')
    const received = join(repo, 'received-env')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    writeFileSync(script, `#!/bin/sh
printf '%s\n' "$CREATE_NAME|$CREATE_SEED|$CREATE_BASE|$DEV308_PARENT|$DEV308_OVERRIDE" > "${received}"
path="$PWD/.claude/worktrees/$CREATE_NAME"
${hermeticGitCommand} worktree add -b "$1" "$path" HEAD >/dev/null
printf '%s\n' "$path"
`)
    chmodSync(script, 0o755)
    const previousParent = process.env.DEV308_PARENT
    const previousOverride = process.env.DEV308_OVERRIDE
    process.env.DEV308_PARENT = 'inherited'
    process.env.DEV308_OVERRIDE = 'old'
    try {
      const worktree = createWithTool({
        branch: 'task/{id}',
        create: {
          command: 'scripts/create-with-env', args: ['{branch}'],
          env: {
            CREATE_NAME: 'value with {name}', CREATE_SEED: 'seed={seed}',
            CREATE_BASE: '{base}', DEV308_OVERRIDE: 'new {key}',
          },
        },
      }, repo, 308, 'full', 'DEV-308', 'HEAD')
      expect(worktree.path).toBe(realpathSync(join(repo, '.claude', 'worktrees', 'value with orch-308')))
      expect(readFileSync(received, 'utf8')).toBe(
        `value with orch-308|seed=full|${worktree.base}|inherited|new DEV-308\n`,
      )
    } finally {
      if (previousParent === undefined) delete process.env.DEV308_PARENT
      else process.env.DEV308_PARENT = previousParent
      if (previousOverride === undefined) delete process.env.DEV308_OVERRIDE
      else process.env.DEV308_OVERRIDE = previousOverride
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('the path is read from stdout, whatever the tool says on stderr afterwards', () => {
    // One project's shape: path on stdout, progress on stderr, and the progress
    // printed last. Joining the streams put a progress line where the path
    // should be and sent run 735 to a directory nothing had created.
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    const custom = join(repo, 'elsewhere', 'technical_sto_993_orch_735')
    try {
      process.chdir(tree)
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" HEAD >/dev/null && ` +
            `echo "${custom}" && ` +
            `echo 'Database cloned.' >&2 && echo 'task status not written' >&2`),
        },
        process.cwd(),
        735,
      )
      expect(w.path).toBe(custom)
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a tool that prints its path is believed, not second-guessed', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    const custom = join(repo, 'elsewhere', 'custom-657')
    try {
      process.chdir(tree)
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" HEAD >/dev/null && ` +
            `echo "${custom}"`),
        },
        process.cwd(),
        657,
      )
      expect(w.path).toBe(custom)
      expect(existsSync(join(repo, '.claude', 'worktrees', 'orch-657'))).toBe(false)
    } finally {
      process.chdir(here)
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
              [process.execPath, new URL('cli.ts', import.meta.url).pathname, 'stop', String(id)],
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
