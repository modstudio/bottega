import { describe, expect, test } from 'bun:test'
import { type ConfinedLaunchMode, confinedLaunchCwd } from './confined-launch-cwd.ts'
import { launchCommand } from './confinement-filesystem-probe.ts'
import type { launchSandboxProbe } from './confinement-probe-launch.ts'

const paths = {
  worktreePath: '/runs/worker-tree',
  isolatedDirectory: '/runs/isolated',
  callerCwd: '/projects/caller',
}

test('confined launch cwd follows the claim tree mode', () => {
  const cases: [ConfinedLaunchMode, string][] = [
    ['attach', paths.worktreePath],
    ['create', paths.worktreePath],
    ['isolate', paths.isolatedDirectory],
    ['caller', paths.callerCwd],
  ]
  for (const [mode, expected] of cases) {
    expect(confinedLaunchCwd({ mode, ...paths })).toBe(expected)
  }
})

describe('confinement probe command cell', () => {
  test('launches from the fixture worktree chosen for create mode', async () => {
    const fixtureWorktree = '/tmp/confinement-fixture/tree'
    const expectedCwd = confinedLaunchCwd({
      mode: 'create',
      worktreePath: fixtureWorktree,
      isolatedDirectory: '/tmp/confinement-fixture/isolated',
      callerCwd: '/projects/main-checkout',
    })
    let observedCwd: string | undefined
    const launcher = (async (_profile, _executable, _argv, _environment, _scratchDir, options) => {
      observedCwd = options.cwd
      return { exitCode: 0, stderr: '' } as Awaited<ReturnType<typeof launchSandboxProbe>>
    }) satisfies typeof launchSandboxProbe

    await launchCommand(
      {} as Parameters<typeof launchCommand>[0],
      ['bottega', 'task', 'show'],
      {},
      '/tmp/confinement-fixture/scratch',
      expectedCwd,
      undefined,
      launcher,
    )

    expect(observedCwd).toBe(fixtureWorktree)
  })
})
