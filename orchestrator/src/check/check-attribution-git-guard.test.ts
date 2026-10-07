import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dir } from '../../test/preload.ts'
import { applyMigrations } from '../database/migrations.ts'

const hook = resolve(import.meta.dir, '../../hooks/git-guard.py')
const fixtureRoots: string[] = []
type Decision = {
  permissionDecision: 'allow' | 'ask'
  permissionDecisionReason: string
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(dir, 'git-guard-'))
  fixtureRoots.push(root)
  const project = join(root, 'project')
  const worktree = join(project, '.claude', 'worktrees', 'DEV-1165')
  const outside = join(root, 'outside')
  mkdirSync(worktree, { recursive: true })
  mkdirSync(outside)

  const databasePath = join(root, 'orch.db')
  const database = new Database(databasePath, { create: true })
  applyMigrations(database)
  database
    .query('INSERT INTO project (name,path,settings) VALUES (?,?,?)')
    .run(
      'fixture',
      project,
      JSON.stringify({ trunk: 'landing', productionBranch: 'production-live' }),
    )
  database.close()
  return { databasePath, outside, project, worktree }
}

function invoke(databasePath: string, cwd: string, command: string) {
  const result = Bun.spawnSync(['python3', hook], {
    env: { ...process.env, ORCH_DB: databasePath },
    stdin: Buffer.from(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd })),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: '',
  })
  const output = result.stdout.toString().trim()
  return output ? (JSON.parse(output).hookSpecificOutput as Decision) : null
}

function invokeMany(
  databasePath: string,
  invocations: Array<{ cwd: string; command: string }>,
): Array<Decision | null> {
  const runner = `
import importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location("git_guard", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
results = []
stdout = sys.stdout
for payload in json.load(sys.stdin):
    sys.stdin = io.StringIO(json.dumps(payload))
    sys.stdout = io.StringIO()
    module.main()
    output = sys.stdout.getvalue()
    results.append(json.loads(output)["hookSpecificOutput"] if output else None)
sys.stdout = stdout
json.dump(results, sys.stdout)
`
  const payloads = invocations.map(({ cwd, command }) => ({
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
  }))
  const result = Bun.spawnSync(['python3', '-c', runner, hook], {
    env: { ...process.env, ORCH_DB: databasePath },
    stdin: Buffer.from(JSON.stringify(payloads)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: '',
  })
  return JSON.parse(result.stdout.toString()) as Array<Decision | null>
}

describe('git guard', () => {
  test('allows git directly and through workflow exec in a registered worktree', () => {
    const { databasePath, outside, worktree } = fixture()
    expect(invoke(databasePath, worktree, 'git status')?.permissionDecision).toBe('allow')
    expect(
      invoke(
        databasePath,
        outside,
        `/usr/local/bin/orch workflow exec -- git -C ${worktree} status`,
      )?.permissionDecision,
    ).toBe('allow')
    expect(
      invoke(databasePath, outside, `orch workflow exec --cwd ${worktree} -- git status`)
        ?.permissionDecision,
    ).toBe('allow')
  })

  test('asks for force pushes directly and through workflow exec', () => {
    const { databasePath, project, worktree } = fixture()
    expect(
      invoke(databasePath, worktree, 'git push --force origin feature:feature')?.permissionDecision,
    ).toBe('ask')
    expect(
      invoke(
        databasePath,
        worktree,
        'orch workflow exec -- git push --force origin feature:feature',
      )?.permissionDecision,
    ).toBe('ask')
    const clustered = ['-fu', '-uf', '-ff'].flatMap((flag) =>
      [worktree, project].map((cwd) => ({
        cwd,
        command: `git push ${flag} origin feature:feature`,
      })),
    )
    expect(
      invokeMany(databasePath, clustered).map((decision) => decision?.permissionDecision),
    ).toEqual(['ask', 'ask', 'ask', 'ask', 'ask', 'ask'])
  })

  test('honors both workflow exec cwd forms and rejects ambiguous cwd flags', () => {
    const { databasePath, outside, project, worktree } = fixture()
    expect(
      invoke(databasePath, worktree, `orch workflow exec --cwd=${project} -- git reset --hard`),
    ).toBeNull()
    expect(
      invoke(databasePath, outside, `orch workflow exec --cwd=${worktree} -- git reset --hard`)
        ?.permissionDecision,
    ).toBe('allow')
    expect(
      invoke(
        databasePath,
        outside,
        `orch workflow exec --cwd ${worktree} --cwd=${project} -- git status`,
      ),
    ).toBeNull()
    expect(invoke(databasePath, outside, 'orch workflow exec --cwd -- git status')).toBeNull()
  })

  test('does not allow repository-redirection options based on the worktree cwd', () => {
    const { databasePath, project, worktree } = fixture()
    const redirected = [
      '-c user.name=test',
      '-c=user.name=test',
      '--config-env user.name=HOME',
      '--config-env=user.name=HOME',
      `--git-dir ${join(project, '.git')}`,
      `--git-dir=${join(project, '.git')}`,
      `--work-tree ${project}`,
      `--work-tree=${project}`,
      '--namespace test',
      '--namespace=test',
      '--exec-path /tmp',
      '--exec-path=/tmp',
      '--super-prefix nested/',
      '--super-prefix=nested/',
      '--bare',
    ]
    const decisions = invokeMany(databasePath, [
      ...redirected.map((options) => ({ cwd: worktree, command: `git ${options} status` })),
      {
        cwd: worktree,
        command: `git --git-dir=${join(project, '.git')} push --force origin feature:feature`,
      },
    ])
    expect(decisions.slice(0, -1)).toEqual(redirected.map(() => null))
    expect(decisions.at(-1)?.permissionDecision).toBe('ask')
  })

  test('recognizes git launched by absolute path', () => {
    const { databasePath, worktree } = fixture()
    expect(
      invoke(databasePath, worktree, '/usr/bin/git push --force origin feature:feature')
        ?.permissionDecision,
    ).toBe('ask')
    expect(invoke(databasePath, worktree, '/usr/bin/git status')?.permissionDecision).toBe('allow')
  })

  test('allows scoped cleanup only for ordinary named branches', () => {
    const { databasePath, worktree } = fixture()
    expect(
      invoke(databasePath, worktree, 'git push --force-with-lease origin feature:feature')
        ?.permissionDecision,
    ).toBe('allow')
    expect(
      invoke(databasePath, worktree, 'git push --delete origin hotfix/x')?.permissionDecision,
    ).toBe('allow')
    for (const branch of ['landing', 'production-live']) {
      expect(
        invoke(databasePath, worktree, `git push --delete origin ${branch}`)?.permissionDecision,
      ).toBe('ask')
    }
  })

  test('allows only listed worktree subcommands without program options', () => {
    const { databasePath, outside, worktree } = fixture()
    const commands = [
      'git status',
      'git commit',
      'git rebase main',
      'git config user.name test',
      'git remote -v',
      'git x',
      'git rebase --exec true main',
      'git rebase -x true main',
      'git fetch --upload-pack=true origin',
      'git grep -O less pattern',
      'git diff --ext-diff',
      'git log --output=/tmp/log',
    ]
    const decisions = invokeMany(databasePath, [
      ...commands.map((command) => ({ cwd: worktree, command })),
      { cwd: outside, command: `git -C ${worktree} status` },
    ])
    expect(decisions.map((decision) => decision?.permissionDecision ?? null)).toEqual([
      'allow',
      'allow',
      'allow',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'allow',
    ])
  })

  test('withholds scoped push allow for remote helpers but still asks on force', () => {
    const { databasePath, worktree } = fixture()
    const decisions = invokeMany(databasePath, [
      {
        cwd: worktree,
        command: 'git push --force-with-lease origin feature:feature',
      },
      {
        cwd: worktree,
        command: 'git push --force-with-lease --receive-pack=true origin feature:feature',
      },
      {
        cwd: worktree,
        command: 'git push --force --receive-pack=true origin feature:feature',
      },
    ])
    expect(decisions.map((decision) => decision?.permissionDecision ?? null)).toEqual([
      'allow',
      null,
      'ask',
    ])
  })

  test('falls through outside registered worktrees and for ambiguous commands', () => {
    const { databasePath, outside, worktree } = fixture()
    expect(
      invokeMany(databasePath, [
        { cwd: outside, command: 'git status' },
        { cwd: worktree, command: 'orch workflow exec -- printf nope' },
        { cwd: worktree, command: 'git status && git clean -fd' },
      ]),
    ).toEqual([null, null, null])
  })
})
