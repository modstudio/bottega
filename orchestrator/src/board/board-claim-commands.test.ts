import { expect, spyOn, test } from 'bun:test'
import { Command } from 'commander'
import { registerBoardClaimCommands } from './board-claim-commands.ts'

async function parseReleaseTask(argv: string[]): Promise<{
  calls: { key: string; project: string }[]
  printed: unknown[]
}> {
  const calls: { key: string; project: string }[] = []
  const lines: string[] = []
  const log = spyOn(console, 'log').mockImplementation((value) => lines.push(String(value)))
  try {
    const program = new Command().exitOverride()
    registerBoardClaimCommands(program.command('board'), () => 0, {
      releaseTask: async (key, project) => {
        calls.push({ key, project })
        return { claims: [] }
      },
    })
    await program.parseAsync(['node', 'orch', 'board', 'claim', 'release-task', ...argv])
  } finally {
    log.mockRestore()
  }
  return { calls, printed: lines.map((line) => JSON.parse(line)) }
}

test('board claim release-task runs without --json and still accepts it', async () => {
  const withoutFlag = await parseReleaseTask(['DEV-1566', '--project', 'sample-project'])
  expect(withoutFlag.calls).toEqual([{ key: 'DEV-1566', project: 'sample-project' }])
  expect(withoutFlag.printed).toEqual([{ claims: [] }])

  const withFlag = await parseReleaseTask(['DEV-1566', '--project', 'sample-project', '--json'])
  expect(withFlag.calls).toEqual([{ key: 'DEV-1566', project: 'sample-project' }])
  expect(withFlag.printed).toEqual([{ claims: [] }])
})
