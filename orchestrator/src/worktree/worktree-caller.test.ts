import { describe, expect, test } from 'bun:test'
import { readOnlyBaseResolutionDirectory, shouldAssertCallerAncestry } from './worktree-caller.ts'

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
