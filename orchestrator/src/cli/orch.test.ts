import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
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
    expect(await runCliEntryForTest(['ask-server'], throwingEntry)).toBe(1)
    expect(readAskServerFailure(scratchDir)).toBe('this store may not be opened')
  })
})

test('an ask-server failure reached through its public path is recorded the same way', async () => {
  await withScratch(async (scratchDir) => {
    expect(
      await runCliEntryForTest([], throwingEntry, {
        ownerPath: ['mcp', 'ask-server'],
        publicPath: ['mcp', 'ask-server'],
      }),
    ).toBe(1)
    expect(readAskServerFailure(scratchDir)).toBe('this store may not be opened')
  })
})

test('a failure on any other invocation leaves no ask-server artifact behind', async () => {
  await withScratch(async (scratchDir) => {
    expect(await runCliEntryForTest(['board', 'list'], throwingEntry)).toBe(1)
    expect(readAskServerFailure(scratchDir)).toBeNull()
  })
})

test('a store refusal at CLI startup prints only the refusal', async () => {
  const refusal = `refusing to open a store behind this binary's migration journal: 0999_x\ncleared by: ${PLATFORM_SLUG} machine update`
  const stderr: string[] = []
  const error = spyOn(console, 'error').mockImplementation((value) => stderr.push(String(value)))
  try {
    expect(
      await runCliEntryForTest(['board', 'list'], async () => {
        throw new Error(refusal)
      }),
    ).toBe(1)
    expect(stderr.join('\n')).toContain(refusal)
    expect(stderr.join('\n')).not.toMatch(/^\s+at /m)
  } finally {
    error.mockRestore()
  }
})
