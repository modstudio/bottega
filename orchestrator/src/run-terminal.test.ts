import { describe, expect, test } from 'bun:test'
import { shouldCheckpointAtTerminal } from './run-terminal.ts'

describe('terminal checkpoint decision', () => {
  test('rejects omitting an ok writing turn from terminal checkpointing', () => {
    expect(
      shouldCheckpointAtTerminal({
        writesJob: true,
        hasWorktree: true,
        launchKey: 'DEV-623',
        status: 'ok',
      }),
    ).toBe(true)
  })

  test('rejects checkpointing a read-only turn', () => {
    expect(
      shouldCheckpointAtTerminal({
        writesJob: false,
        hasWorktree: true,
        launchKey: 'DEV-623',
        status: 'ok',
      }),
    ).toBe(false)
  })
})
