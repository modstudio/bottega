import { describe, expect, test } from 'bun:test'
import {
  commandCreatedBranchMatches,
  leftoverRemedy,
  worktreeCreateVariables,
} from './worktree-create.ts'

describe('worktreeCreateVariables', () => {
  test('uses the default branch template and derives the worktree name', () => {
    expect(
      worktreeCreateVariables(undefined, undefined, '42', undefined, undefined, 'base-sha'),
    ).toEqual({
      branch: 'orch/42',
      name: 'orch-42',
      base: 'base-sha',
      seed: '',
      key: '',
      path: '',
    })
  })

  test('substitutes the run id and key throughout a project template', () => {
    expect(
      worktreeCreateVariables(
        '{key}-orch-{id}-{key}-{id}',
        undefined,
        '42',
        'DEV-736',
        'small',
        'base-sha',
      ),
    ).toMatchObject({
      branch: 'DEV-736-orch-42-DEV-736-42',
      key: 'DEV-736',
      seed: 'small',
    })
  })

  test('substitutes an absent key with the empty string', () => {
    expect(
      worktreeCreateVariables('{key}-orch-{id}', undefined, '42', undefined, undefined, 'base-sha')
        .branch,
    ).toBe('-orch-42')
  })

  test('uses an existing branch without applying the project template', () => {
    expect(
      worktreeCreateVariables(
        '{key}-orch-{id}',
        'kept/{key}/{id}',
        '42',
        'DEV-736',
        undefined,
        'base-sha',
      ).branch,
    ).toBe('kept/{key}/{id}')
  })
})

describe('leftoverRemedy', () => {
  const vars = worktreeCreateVariables(
    '{key}-orch-{id}',
    undefined,
    '42',
    'DEV-736',
    undefined,
    'base-sha',
  )

  test('names the branch and fills the project remove command', () => {
    expect(leftoverRemedy('bin/remove {branch} {path}', vars, '/tmp/orch-42')).toBe(
      '\nThe project created branch DEV-736-orch-42 and may have provisioned resources.\n' +
        'Remove them when you have inspected the tree:\n' +
        "  bin/remove 'DEV-736-orch-42' '/tmp/orch-42'",
    )
  })

  test('plainly states when the project declares no remove command', () => {
    const message = leftoverRemedy(undefined, vars, '/tmp/orch-42')

    expect(message).toContain('The project created branch DEV-736-orch-42')
    expect(message).toContain('  (project declares no remove command)')
  })

  test('never fills a continued branch into a branch-removing command', () => {
    const message = leftoverRemedy(
      'bin/remove {branch} {path}',
      { ...vars, branch: 'DEV-1843-existing' },
      '/tmp/orch-42',
      'DEV-1843-existing',
    )

    expect(message).toContain('existing branch DEV-1843-existing')
    expect(message).toContain('must be kept')
    expect(message).not.toContain("bin/remove 'DEV-1843-existing'")
  })

  test('fills the observed branch into a continued-create removal command', () => {
    const message = leftoverRemedy(
      'bin/remove {branch} {path}',
      { ...vars, branch: 'DEV-1843-existing' },
      '/tmp/orch-42',
      'DEV-1843-existing',
      'unexpected-branch',
    )

    expect(message).toContain("bin/remove 'unexpected-branch' '/tmp/orch-42'")
    expect(message).not.toContain("bin/remove 'DEV-1843-existing'")
  })

  test('does not fill a branch-removing command for a detached continued create', () => {
    const message = leftoverRemedy(
      'bin/remove {branch} {path}',
      { ...vars, branch: 'DEV-1843-existing' },
      '/tmp/orch-42',
      'DEV-1843-existing',
      null,
    )

    expect(message).toContain('tree is detached and must be inspected first')
    expect(message).not.toContain('bin/remove')
  })
})

describe('command-created existing branch postcondition', () => {
  test('accepts only the requested symbolic branch for an attached create', () => {
    expect(
      commandCreatedBranchMatches('DEV-1843-existing', false, 'refs/heads/DEV-1843-existing'),
    ).toBe(true)
    expect(commandCreatedBranchMatches('DEV-1843-existing', false, 'refs/heads/other')).toBe(false)
    expect(commandCreatedBranchMatches('DEV-1843-existing', false, null)).toBe(false)
  })
})
