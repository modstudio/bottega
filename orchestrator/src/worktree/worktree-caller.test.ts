import { describe, expect, test } from 'bun:test'
import {
  otherWorktreePaths,
  readOnlyBaseResolutionDirectory,
  shouldAssertCallerAncestry,
} from './worktree-caller.ts'

const canonicalize = (path: string): string => `/canonical${path}`

describe('otherWorktreePaths', () => {
  test('lists an ordinary second worktree', () => {
    const porcelain = 'worktree /repo\nHEAD abc\n\nworktree /trees/second\nHEAD def\n'

    expect(otherWorktreePaths(porcelain, '/repo', canonicalize)).toEqual([
      '/canonical/trees/second',
    ])
  })

  test("excludes the caller's own entry", () => {
    const porcelain = 'worktree /repo\nHEAD abc\n'

    expect(otherWorktreePaths(porcelain, '/repo', canonicalize)).toEqual([])
  })

  test('tolerates a canonicalisation failure and returns the remaining entries', () => {
    const porcelain =
      'worktree /repo\nHEAD abc\n\nworktree /missing\nHEAD def\n\nworktree /trees/valid\nHEAD ghi\n'
    const canonicalizeUnlessMissing = (path: string): string => {
      if (path === '/missing') throw new Error('missing')
      return canonicalize(path)
    }

    expect(otherWorktreePaths(porcelain, '/repo', canonicalizeUnlessMissing)).toEqual([
      '/canonical/trees/valid',
    ])
  })

  test('treats prunable metadata the same for existing and missing paths', () => {
    const porcelain =
      'worktree /repo\nHEAD abc\n\nworktree /trees/existing\nprunable reason\n\nworktree /missing\nprunable reason\n'
    const canonicalizeUnlessMissing = (path: string): string => {
      if (path === '/missing') throw new Error('missing')
      return canonicalize(path)
    }

    expect(otherWorktreePaths(porcelain, '/repo', canonicalizeUnlessMissing)).toEqual([
      '/canonical/trees/existing',
    ])
  })
})

describe('readOnlyBaseResolutionDirectory', () => {
  test('uses the registered checkout after the caller worktree is gone', () => {
    expect(
      readOnlyBaseResolutionDirectory(
        '/projects/example/.claude/worktrees/orch-5330',
        true,
        '/projects/example',
      ),
    ).toBe('/projects/example')
  })

  test('uses a repo-named registered checkout when the caller is outside it', () => {
    expect(
      readOnlyBaseResolutionDirectory('/tmp/released-orch-5330', true, '/projects/example'),
    ).toBe('/projects/example')
  })

  test('keeps fresh dispatch resolution in the caller checkout', () => {
    expect(readOnlyBaseResolutionDirectory('/tmp/example', false, '/projects/example')).toBe(
      '/tmp/example',
    )
  })

  test('uses the caller checkout for an unregistered failover', () => {
    expect(readOnlyBaseResolutionDirectory('/tmp/example', true, null)).toBe('/tmp/example')
  })
})

describe('shouldAssertCallerAncestry', () => {
  test('carry into a potentially diverged tree asserts', () => {
    expect(shouldAssertCallerAncestry(true, false)).toBe(true)
  })

  test('no carry skips the assertion', () => {
    expect(shouldAssertCallerAncestry(false, false)).toBe(false)
  })

  test('resume skips the assertion', () => {
    expect(shouldAssertCallerAncestry(true, true)).toBe(false)
  })
})
