import { describe, expect, test } from 'bun:test'
import { BUILTIN_AGENTS } from './agents.ts'

const shellSets = (argv: string[]) =>
  argv.flatMap((arg, index) =>
    argv[index - 1] === '-c' && arg.startsWith('shell_environment_policy.set.') ? [arg] : [],
  )

const codexPermissionProfile = {
  filesystem: { denyRead: ['/state'], allowRead: ['/state/runs/this-run'] },
  writableRoots: ['/repo', '/run/scratch'],
}

describe('codex worker shell environment', () => {
  test('first turns and resumes disable native project docs', () => {
    const first = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      codexPermissionProfile,
    })
    const resumed = BUILTIN_AGENTS.codex!.resumeArgv!({
      prompt: 'ruling',
      out: '/tmp/out',
      session: 'thread',
      codexPermissionProfile,
    })
    expect(first).toContain('project_doc_max_bytes=0')
    expect(resumed).toContain('project_doc_max_bytes=0')
    expect(resumed.indexOf('project_doc_max_bytes=0')).toBeLessThan(resumed.indexOf('resume'))
  })

  test('an explicit workspace-write network option reaches Codex', () => {
    const argv = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      sandbox: 'workspace-write',
      sandboxWorkspaceWriteNetworkAccess: true,
      write: true,
      codexPermissionProfile,
    })
    expect(argv).toContain('permissions.bottega.network.enabled=true')
    expect(argv).toContain('--approve-for-me')
    expect(argv).not.toContain('-s')
  })

  test('no-repository jobs limit workspace-write to the isolate and scratch', () => {
    const repositoryReader = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      sandbox: 'workspace-write',
      write: true,
      codexPermissionProfile,
    })
    const noRepositoryJob = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      sandbox: 'workspace-write',
      writableRoots: ['/runs/42/scratch'],
      codexPermissionProfile,
      recipeEnvironment: {
        TMPDIR: '/runs/42/scratch/tmp',
        TMP: '/runs/42/scratch/tmp',
        TEMP: '/runs/42/scratch/tmp',
      },
    })
    expect(repositoryReader).toContain('--approve-for-me')
    expect(repositoryReader).not.toContain('-s')
    expect(noRepositoryJob).not.toContain('--approve-for-me')
    expect(noRepositoryJob).not.toContain('-s')
    expect(noRepositoryJob.join(' ')).not.toContain('sandbox_workspace_write')
    expect(shellSets(noRepositoryJob)).toEqual([
      'shell_environment_policy.set.TMPDIR="/runs/42/scratch/tmp"',
      'shell_environment_policy.set.TMP="/runs/42/scratch/tmp"',
      'shell_environment_policy.set.TEMP="/runs/42/scratch/tmp"',
    ])
    expect(noRepositoryJob).not.toContain('permissions.bottega.network.enabled=true')
    expect(repositoryReader.join(' ')).not.toContain('sandbox_workspace_write')
    expect(shellSets(repositoryReader)).not.toContainEqual(
      expect.stringMatching(/^shell_environment_policy\.set\.(?:TMPDIR|TMP|TEMP)=/),
    )
  })

  test('MCP writers continue to use approval without an explicit sandbox', () => {
    const argv = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      mcp: true,
      sandbox: 'workspace-write',
      write: true,
      codexPermissionProfile,
    })
    expect(argv).toContain('--approve-for-me')
    expect(argv).not.toContain('-s')
  })

  test('recipe allocation values are set in the tool shell, not only the process environment', () => {
    const argv = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      recipeEnvironment: { BOTTEGA_INDEX: '1', BOTTEGA_PORTS_HUB: '21003' },
      codexPermissionProfile,
    })
    expect(shellSets(argv)).toEqual([
      'shell_environment_policy.set.BOTTEGA_INDEX="1"',
      'shell_environment_policy.set.BOTTEGA_PORTS_HUB="21003"',
    ])
  })

  test('the registered main checkout is pinned in the tool shell', () => {
    const argv = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      recipeEnvironment: { BOTTEGA_MAIN_CHECKOUT: '/projects/app' },
      codexPermissionProfile,
    })
    expect(shellSets(argv)).toEqual([
      'shell_environment_policy.set.BOTTEGA_MAIN_CHECKOUT="/projects/app"',
    ])
  })

  test('a run with no recipe allocations sets nothing', () => {
    const argv = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      codexPermissionProfile,
    })
    expect(shellSets(argv)).toEqual([])
  })

  test('a read-only repository run does not override Git object storage', () => {
    const argv = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      sandbox: 'workspace-write',
      write: true,
      writableRoots: ['/repo/.git/objects'],
      codexPermissionProfile,
      ...{
        gitObjectEnvironment: {
          GIT_OBJECT_DIRECTORY: '/repo/.git/worktrees/reader/objects',
          GIT_ALTERNATE_OBJECT_DIRECTORIES: '/repo/.git/objects',
        },
      },
    })
    expect(shellSets(argv)).not.toContainEqual(expect.stringContaining('GIT_OBJECT_DIRECTORY'))
    expect(shellSets(argv)).not.toContainEqual(
      expect.stringContaining('GIT_ALTERNATE_OBJECT_DIRECTORIES'),
    )
  })
})
