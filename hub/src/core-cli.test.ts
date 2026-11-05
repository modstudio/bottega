import { expect, spyOn, test } from 'bun:test'
import type { CollectLegResult } from './collect.ts'
import { collectOneShot } from './core-cli.ts'

const result: CollectLegResult[] = [{ source: 'runs', ok: true, durationMs: 0 }]

test('one-shot collection selects incremental work unless a rebuild window is explicit', async () => {
  const calls: string[] = []
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    await collectOneShot(undefined, undefined, 'runs', {
      incremental: async (only) => {
        calls.push(`incremental:${only ?? ''}`)
        return result
      },
      rebuild: async () => {
        calls.push('rebuild')
        return result
      },
    })
    await collectOneShot(undefined, '2026-11-01T00:00:00.000Z', 'runs', {
      incremental: async () => {
        calls.push('incremental')
        return result
      },
      rebuild: async (since, only) => {
        calls.push(`rebuild:${since}:${only ?? ''}`)
        return result
      },
    })
  } finally {
    log.mockRestore()
  }
  expect(calls).toEqual(['incremental:runs', 'rebuild:2026-11-01T00:00:00.000Z:runs'])
})
