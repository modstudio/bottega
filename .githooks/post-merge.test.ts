import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hook = join(import.meta.dir, 'post-merge')

type RunOptions = {
  changed?: string[]
  linked?: boolean
  fail?: 'orch' | 'hub' | 'bun'
}

function executable(path: string, source: string): void {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

function run(options: RunOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'post-merge-'))
  try {
    const root = join(dir, 'checkout')
    const commands = join(dir, 'commands')
    const fakeBin = join(dir, 'fake-bin')
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(fakeBin)
    writeFileSync(commands, '')
    for (const packageDir of ['.', 'hub', 'hub/web']) {
      mkdirSync(join(root, packageDir), { recursive: true })
      writeFileSync(join(root, packageDir, 'package.json'), '{}\n')
    }

    executable(join(fakeBin, 'git'), `#!/bin/sh
case "$1 $2" in
  "rev-parse --git-dir") printf '%s\\n' "\${FAKE_GIT_DIR}" ;;
  "rev-parse --git-common-dir") printf '%s\\n' "\${FAKE_COMMON_DIR}" ;;
  "rev-parse --show-toplevel") printf '%s\\n' "\${FAKE_ROOT}" ;;
  "rev-parse --verify") exit 0 ;;
  "diff --name-only") printf '%s' "\${FAKE_CHANGED}" ;;
  *) exit 1 ;;
esac
`)
    executable(join(root, 'bin', 'orch'), `#!/bin/sh
printf 'orch %s ORCH_DB=%s ORCH_DEPTH=%s\\n' "$*" "\${ORCH_DB-unset}" "\${ORCH_DEPTH-unset}" >>"\${COMMAND_LOG}"
[ "\${FAIL_COMMAND}" != orch ]
`)
    executable(join(root, 'bin', 'hub'), `#!/bin/sh
printf 'hub %s\\n' "$*" >>"\${COMMAND_LOG}"
[ "\${FAIL_COMMAND}" != hub ]
`)
    executable(join(fakeBin, 'bun'), `#!/bin/sh
printf 'bun %s in %s\\n' "$*" "$PWD" >>"\${COMMAND_LOG}"
[ "\${FAIL_COMMAND}" != bun ]
`)

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      COMMAND_LOG: commands,
      FAIL_COMMAND: options.fail ?? '',
      FAKE_ROOT: root,
      FAKE_CHANGED: options.changed?.join('\n') ?? '',
      FAKE_GIT_DIR: options.linked ? '.git/worktrees/fixture' : '.git',
      FAKE_COMMON_DIR: '.git',
      ORCH_DB: '/wrong/live-store.db',
      ORCH_DEPTH: '1',
    }
    const spawned = Bun.spawnSync(['sh', hook], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      code: spawned.exitCode,
      stdout: spawned.stdout.toString(),
      stderr: spawned.stderr.toString(),
      commands: readFileSync(commands, 'utf8'),
      root,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a merge with no relevant changes is fast and silent', () => {
  const result = run({ changed: ['README.md'] })
  expect(result.code).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
  expect(result.commands).toBe('')
})

test('migration changes use both existing migration commands without linked-worktree overrides', () => {
  const result = run({ changed: ['orchestrator/migrations/0018_example.sql'] })
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.commands).toBe(
    'orch migrate ORCH_DB=unset ORCH_DEPTH=unset\n' +
    'hub migrate\n',
  )
})

test('each changed package manifest installs in its own directory', () => {
  const result = run({ changed: ['package.json', 'hub/package.json', 'hub/web/package.json'] })
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.commands).toBe(
    `bun install --silent in ${result.root}\n` +
    `bun install --silent in ${result.root}/hub\n` +
    `bun install --silent in ${result.root}/hub/web\n`,
  )
})

test('a linked worktree does nothing', () => {
  const result = run({
    changed: ['orchestrator/migrations/0018_example.sql', 'package.json'],
    linked: true,
  })
  expect(result.code).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
  expect(result.commands).toBe('')
})

test('a failed migration reports recovery and never fails the merge', () => {
  const result = run({ changed: ['hub/migrations/0018_example.sql'], fail: 'orch' })
  expect(result.code).toBe(0)
  expect(result.stderr).toContain(
    `post-merge: orchestrator migration failed; run by hand: cd '${result.root}' && ./bin/orch migrate`,
  )
  expect(result.commands).toContain('hub migrate\n')
})

test('a failed install reports recovery and never fails the merge', () => {
  const result = run({ changed: ['hub/web/package.json'], fail: 'bun' })
  expect(result.code).toBe(0)
  expect(result.stderr).toContain(
    `post-merge: package install failed; run by hand: cd '${result.root}/hub/web' && bun install --silent`,
  )
})
