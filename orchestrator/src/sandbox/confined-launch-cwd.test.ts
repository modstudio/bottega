import { describe, expect, test } from 'bun:test'
import { type ConfinedLaunchMode, confinedLaunchCwd } from './confined-launch-cwd.ts'
import type { launchSandboxProbe } from './confinement-probe-launch.ts'
import { launchCommand } from './confinement-probe-launch.ts'

const paths = {
  worktreePath: '/runs/worker-tree',
  isolatedDirectory: '/runs/isolated',
  callerCwd: '/projects/caller',
}

test('confined launch cwd follows the claim tree mode', () => {
  const cases: [ConfinedLaunchMode, string | null, string][] = [
    ['attach', paths.worktreePath, paths.worktreePath],
    ['create', paths.worktreePath, paths.worktreePath],
    ['isolate', null, paths.isolatedDirectory],
    ['caller', paths.worktreePath, paths.worktreePath],
    ['caller', null, paths.callerCwd],
  ]
  for (const [mode, worktreePath, expected] of cases) {
    expect(confinedLaunchCwd(mode, worktreePath, paths.isolatedDirectory, paths.callerCwd)).toBe(
      expected,
    )
  }
})

describe('confinement probe command cell', () => {
  test('launches from the fixture worktree chosen for create mode', async () => {
    const fixtureWorktree = '/tmp/confinement-fixture/tree'
    const expectedCwd = confinedLaunchCwd(
      'create',
      fixtureWorktree,
      '/tmp/confinement-fixture/isolated',
      '/projects/main-checkout',
    )
    let observedCwd: string | undefined
    const launcher = (async (_profile, _executable, _argv, _environment, _scratchDir, options) => {
      observedCwd = options?.cwd
      return { exitCode: 0, stderr: '' } as Awaited<ReturnType<typeof launchSandboxProbe>>
    }) satisfies typeof launchSandboxProbe

    await launchCommand(
      {} as Parameters<typeof launchCommand>[0],
      ['platform', 'task', 'show'],
      {},
      '/tmp/confinement-fixture/scratch',
      expectedCwd,
      undefined,
      launcher,
    )

    expect(observedCwd).toBe(fixtureWorktree)
  })
})
