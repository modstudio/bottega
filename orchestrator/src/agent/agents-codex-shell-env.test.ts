import { describe, expect, test } from 'bun:test'
import { BUILTIN_AGENTS } from './agents.ts'

const shellSets = (argv: string[]) =>
  argv.flatMap((arg, index) =>
    argv[index - 1] === '-c' && arg.startsWith('shell_environment_policy.set.') ? [arg] : [],
  )

describe('codex worker shell environment', () => {
  test('first turns and resumes disable native project docs', () => {
    const first = BUILTIN_AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/out' })
    const resumed = BUILTIN_AGENTS.codex!.resumeArgv!({
      prompt: 'ruling',
      out: '/tmp/out',
      session: 'thread',
    })
    expect(first).toContain('project_doc_max_bytes=0')
    expect(resumed).toContain('project_doc_max_bytes=0')
    expect(resumed.indexOf('project_doc_max_bytes=0')).toBeLessThan(resumed.indexOf('resume'))
  })

  test('a flagged read-only run opens workspace-write network access for Docker', () => {
    const argv = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      sandbox: 'workspace-write',
      sandboxWorkspaceWriteNetworkAccess: true,
    })
    expect(argv).toContain('sandbox_workspace_write.network_access=true')
    expect(argv).toContain('workspace-write')
  })

  test('recipe allocation values are set in the tool shell, not only the process environment', () => {
    const argv = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      recipeEnvironment: { ORCH_INDEX: '1', ORCH_PORTS_HUB: '21003' },
    })
    expect(shellSets(argv)).toEqual([
      'shell_environment_policy.set.ORCH_INDEX="1"',
      'shell_environment_policy.set.ORCH_PORTS_HUB="21003"',
    ])
  })

  test('the registered main checkout is pinned in the tool shell', () => {
    const argv = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      recipeEnvironment: { ORCH_MAIN_CHECKOUT: '/projects/app' },
    })
    expect(shellSets(argv)).toEqual([
      'shell_environment_policy.set.ORCH_MAIN_CHECKOUT="/projects/app"',
    ])
  })

  test('a run with no recipe allocations sets nothing', () => {
    const argv = BUILTIN_AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/out' })
    expect(shellSets(argv)).toEqual([])
  })

  test('a read-only repository run does not override Git object storage', () => {
    const argv = BUILTIN_AGENTS.codex!.argv({
      prompt: 'p',
      out: '/tmp/out',
      sandbox: 'workspace-write',
      write: true,
      writableRoots: ['/repo/.git/objects'],
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
