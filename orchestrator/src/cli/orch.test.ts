import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAskServerFailure } from '../ask/ask-failure.ts'
import { runCliEntryForTest } from './orch.ts'

/** A CLI load that fails before any command action runs — a store this process may not open. */
const throwingEntry = async (): Promise<number> => {
  throw new Error('this store may not be opened')
}

async function withScratch(action: (scratchDir: string) => Promise<void>): Promise<void> {
  const scratchDir = mkdtempSync(join(tmpdir(), 'orch-cli-entry-'))
  const previous = process.env.BOTTEGA_SCRATCH
  process.env.BOTTEGA_SCRATCH = scratchDir
  try {
    await action(scratchDir)
  } finally {
    if (previous === undefined) delete process.env.BOTTEGA_SCRATCH
    else process.env.BOTTEGA_SCRATCH = previous
    rmSync(scratchDir, { recursive: true, force: true })
  }
}

test('the CLI entry records an ask-server startup failure where the run reads it', async () => {
  await withScratch(async (scratchDir) => {
    await expect(runCliEntryForTest(['ask-server'], throwingEntry)).rejects.toThrow(
      'this store may not be opened',
    )
    expect(readAskServerFailure(scratchDir)).toBe('this store may not be opened')
  })
})

test('an ask-server failure reached through its public path is recorded the same way', async () => {
  await withScratch(async (scratchDir) => {
    await expect(
      runCliEntryForTest([], throwingEntry, {
        ownerPath: ['mcp', 'ask-server'],
        publicPath: ['mcp', 'ask-server'],
      }),
    ).rejects.toThrow('this store may not be opened')
    expect(readAskServerFailure(scratchDir)).toBe('this store may not be opened')
  })
})

test('a failure on any other invocation leaves no ask-server artifact behind', async () => {
  await withScratch(async (scratchDir) => {
    await expect(runCliEntryForTest(['board', 'list'], throwingEntry)).rejects.toThrow(
      'this store may not be opened',
    )
    expect(readAskServerFailure(scratchDir)).toBeNull()
  })
})
