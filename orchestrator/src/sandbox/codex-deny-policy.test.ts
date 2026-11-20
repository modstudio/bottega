import { expect, test } from 'bun:test'
import { isAbsolute, relative, sep } from 'node:path'
import { decideCodexLiteralDenyRead } from './codex-deny-policy.ts'

function atOrBelow(path: string, ancestor: string): boolean {
  const rel = relative(ancestor, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function expectSafeCodexDenies(denies: readonly string[], protectedPaths: readonly string[]): void {
  expect(denies.some((deny) => /[*?[]/.test(deny))).toBe(false)
  for (const path of protectedPaths) {
    expect(denies.filter((deny) => atOrBelow(path, deny))).toEqual([])
  }
}

test('writer denies literal siblings without denying cwd or writable-root ancestors', () => {
  const cwd = '/projects/proj/.claude/worktrees/own'
  const protectedPaths = [
    cwd,
    '/projects/proj/.git/objects',
    '/projects/proj/.git/refs/heads',
    '/state/runs/own/scratch',
  ]
  const denies = decideCodexLiteralDenyRead({
    denyRead: ['/projects', '/state', `${cwd}/declared.secret`],
    protectedPaths,
    opaquePaths: ['/projects/proj/.git'],
    directoryListings: {
      '/projects': ['other', 'proj'],
      '/projects/proj': ['.claude', '.git', 'README'],
      '/projects/proj/.claude': ['worktrees'],
      '/projects/proj/.claude/worktrees': ['own', 'sib'],
      '/projects/proj/.git': ['config', 'objects', 'refs'],
      '/projects/proj/.git/refs': ['heads', 'tags'],
      '/state': ['orchestrator.db', 'runs'],
      '/state/runs': ['other', 'own'],
      '/state/runs/own': ['runtime', 'scratch'],
    },
  })

  expectSafeCodexDenies(denies, protectedPaths)
  expect(denies).toEqual(
    expect.arrayContaining([
      '/projects/other',
      '/projects/proj/README',
      '/projects/proj/.claude/worktrees/sib',
      '/state/orchestrator.db',
      '/state/runs/other',
      `${cwd}/declared.secret`,
    ]),
  )
  expect(denies.some((deny) => deny.startsWith('/projects/proj/.git/'))).toBe(false)

  // Mutation probe: restoring the original projects-root deny violates the invariant.
  expect(() => expectSafeCodexDenies([...denies, '/projects'], protectedPaths)).toThrow()
})
