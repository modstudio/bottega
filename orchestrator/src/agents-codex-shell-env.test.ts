import { describe, expect, test } from 'bun:test'
import { BUILTIN_AGENTS } from './agents.ts'

const shellSets = (argv: string[]) =>
  argv.flatMap((arg, index) =>
    argv[index - 1] === '-c' && arg.startsWith('shell_environment_policy.set.') ? [arg] : [],
  )

describe('codex worker shell environment', () => {
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

  test('a run with no recipe allocations sets nothing', () => {
    const argv = BUILTIN_AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/out' })
    expect(shellSets(argv)).toEqual([])
  })
})
