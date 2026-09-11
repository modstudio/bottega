import { describe, expect, test } from "bun:test"
import { rmSync, readFileSync, writeFileSync, realpathSync, mkdirSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { createArgv, createWithTool, declaredCreate, fill, fillTool, hermeticGitCommand, preflight, seedArgv, upsertProject, worktreeDescribeFixture } from "../test/fixture.ts"
describe('worktree template decisions', () => {
const { fromRoot, scratchRepo } = worktreeDescribeFixture()
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

})
