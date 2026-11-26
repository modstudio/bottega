import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { registerLaunchAgentRefreshCommand } from './launch-agent-refresh.ts'

test('hidden refresh flag maps to the long-running restart dependency', async () => {
  for (const [argv, expected] of [
    [['launch-agents', 'refresh'], false],
    [['launch-agents', 'refresh', '--restart-long-running'], true],
  ] as const) {
    const requests: boolean[] = []
    const program = new Command().exitOverride()
    registerLaunchAgentRefreshCommand(
      program,
      { log: () => {} },
      async (_platform, _presentation, deps) => {
        requests.push(deps?.restartLongRunning === true)
      },
    )

    await program.parseAsync([...argv], { from: 'user' })
    expect(requests).toEqual([expected])
  }
})
