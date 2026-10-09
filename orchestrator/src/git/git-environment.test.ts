import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { resolveDispatchBase } from '../dispatch/dispatch-commands.ts'
import {
  contentTree,
  isWorktreeRelativeRef,
  resolveBase,
  withTemporaryGitIndex,
} from './git-environment.ts'

afterEach(() => mock.restore())

function spawnResult(stdout = '', exitCode = 0): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(exitCode === 0 ? '' : 'failed'),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

describe('git environment', () => {
  test('temporary index seeds HEAD and binds the three git invocation behaviors', () => {
    // Production break watched fail: remove GIT_INDEX_FILE from the helper's bound environment.
    const cwd = mkdtempSync(join(tmpdir(), 'temporary-index-git-'))
    let temporary = ''
    const commands: string[] = []
    spyOn(Bun, 'spawnSync').mockImplementation(((
      command: string[],
      options?: { env?: NodeJS.ProcessEnv },
    ) => {
      commands.push(command.slice(1).join(' '))
      const index = String(options?.env?.GIT_INDEX_FILE)
      temporary = dirname(index)
      expect(existsSync(temporary)).toBeTrue()
      if (command[1] === 'optional') return spawnResult('', 1)
      if (command[1] === 'raw') return spawnResult('raw\n')
      return spawnResult(' value \n')
    }) as typeof Bun.spawnSync)

    try {
      const result = withTemporaryGitIndex(cwd, ({ git, gitOk, gitRaw }) => ({
        throwing: git(['value']),
        optional: gitOk(['optional']),
        raw: gitRaw(['raw']),
      }))

      expect(commands).toEqual(['read-tree HEAD', 'value', 'optional', 'raw'])
      expect(result).toEqual({ throwing: 'value', optional: null, raw: 'raw\n' })
      expect(existsSync(temporary)).toBeFalse()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('temporary index directory is removed when its action throws', () => {
    // Production break watched fail: remove the helper's finally block.
    const cwd = mkdtempSync(join(tmpdir(), 'temporary-index-failure-'))
    let temporary = ''
    spyOn(Bun, 'spawnSync').mockImplementation(((
      _command: string[],
      options?: { env?: NodeJS.ProcessEnv },
    ) => {
      temporary = dirname(String(options?.env?.GIT_INDEX_FILE))
      return spawnResult()
    }) as typeof Bun.spawnSync)

    try {
      expect(() =>
        withTemporaryGitIndex(cwd, () => {
          throw new Error('action failed')
        }),
      ).toThrow('action failed')
      expect(existsSync(temporary)).toBeFalse()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('content tree keeps its git failure wording', () => {
    // Production break watched fail: omit the helper's failureContext from its throwing binding.
    const cwd = mkdtempSync(join(tmpdir(), 'content-tree-errors-'))
    const failures = [
      ['read-tree HEAD', 'git read-tree HEAD failed while measuring content tree: failed'],
      ['add -A .', 'git add -A . failed while measuring content tree: failed'],
      ['write-tree', 'git write-tree failed while measuring content tree: failed'],
    ]
    try {
      for (const [failedCommand, message] of failures) {
        const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) =>
          spawnResult(
            '',
            command.slice(1).join(' ') === failedCommand ? 1 : 0,
          )) as typeof Bun.spawnSync)
        expect(() => contentTree(cwd)).toThrow(message)
        spawn.mockRestore()
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('classifies only HEAD and @ revision expressions as worktree-relative', () => {
    for (const ref of ['HEAD', 'HEAD~1', 'HEAD^', '@', '@~2', 'HEAD@{1}']) {
      expect(isWorktreeRelativeRef(ref)).toBeTrue()
    }
    for (const ref of [
      'HEADING',
      'feature/HEAD',
      '0123456789abcdef0123456789abcdef01234567',
      'origin/main',
    ]) {
      expect(isWorktreeRelativeRef(ref)).toBeFalse()
    }
  })

  test('resolves HEAD in a linked worktree and branch names in the main checkout', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'resolve-base-worktree-'))
    const main = join(fixture, 'main')
    const tree = join(fixture, 'tree')
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnFixtureGitSync(args, { cwd })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    try {
      git(fixture, 'init', '--quiet', '-b', 'main', main)
      git(main, 'config', 'user.name', 'Fixture')
      git(main, 'config', 'user.email', 'fixture@example.com')
      writeFileSync(join(main, 'file.txt'), 'base\n')
      git(main, 'add', 'file.txt')
      git(main, 'commit', '--quiet', '-m', 'base')
      const mainHead = git(main, 'rev-parse', 'HEAD')
      git(main, 'worktree', 'add', '--quiet', '-b', 'change', tree)
      writeFileSync(join(tree, 'file.txt'), 'changed\n')
      git(tree, 'commit', '--quiet', '-am', 'change')
      const treeHead = git(tree, 'rev-parse', 'HEAD')

      expect(resolveBase(tree, 'HEAD')).toBe(treeHead)
      expect(resolveBase(tree, 'main')).toBe(mainHead)
      const resolveForDispatch = (cwd: string, ref: string) => {
        expect([tree, main]).toContain(cwd)
        expect(['HEAD', 'main']).toContain(ref)
        return cwd === tree && ref === 'HEAD' ? treeHead : mainHead
      }
      expect(resolveDispatchBase(tree, 'HEAD', resolveForDispatch, isWorktreeRelativeRef)).toBe(
        treeHead,
      )
      expect(resolveDispatchBase(tree, 'main', resolveForDispatch, isWorktreeRelativeRef)).toBe(
        'main',
      )
      expect(resolveDispatchBase(main, 'HEAD', resolveForDispatch, isWorktreeRelativeRef)).toBe(
        mainHead,
      )
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
