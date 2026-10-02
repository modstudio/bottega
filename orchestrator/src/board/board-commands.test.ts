import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { registerBoardCommands } from './board-commands.ts'
import { postNotice } from './board-service.ts'

test('board status CLI refuses worker callers', async () => {
  const posted = postNotice(
    { audience: 'operator', title: 'CLI status guard', body: 'Workers cannot inspect status.' },
    {},
  )
  const program = new Command().exitOverride()
  registerBoardCommands(program)
  process.env.ORCH_RUN_ID = 'cli-board-worker'
  try {
    await expect(
      program.parseAsync(['node', 'orch', 'board', 'status', String(posted.id)]),
    ).rejects.toThrow(/workers cannot use the architect notice board/)
  } finally {
    delete process.env.ORCH_RUN_ID
  }
})
