import { describe, expect, test } from 'bun:test'
import { readerScratchReleaseDecision } from './reader-scratch-release.ts'

const dirtyTerminalReader = {
  readOnlyJob: true,
  terminal: true,
  cloneDirty: true,
}

describe('reader scratch release decision', () => {
  test('archives dirty terminal reader scratch and releases after archive success', () => {
    expect(readerScratchReleaseDecision({ ...dirtyTerminalReader, archiveSucceeded: null })).toBe(
      'archive-then-release',
    )
    expect(readerScratchReleaseDecision({ ...dirtyTerminalReader, archiveSucceeded: true })).toBe(
      'release',
    )
  })

  test('keeps dirty terminal reader scratch when its archive failed', () => {
    expect(readerScratchReleaseDecision({ ...dirtyTerminalReader, archiveSucceeded: false })).toBe(
      'keep',
    )
  })

  test('keeps a dirty writing worktree under the existing policy', () => {
    expect(
      readerScratchReleaseDecision({
        ...dirtyTerminalReader,
        readOnlyJob: false,
        archiveSucceeded: true,
      }),
    ).toBe('keep')
  })

  test('keeps a live reader clone', () => {
    expect(
      readerScratchReleaseDecision({
        ...dirtyTerminalReader,
        terminal: false,
        archiveSucceeded: true,
      }),
    ).toBe('keep')
  })
})
