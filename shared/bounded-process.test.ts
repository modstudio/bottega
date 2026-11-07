import { expect, test } from 'bun:test'
import { startBoundedSyncBytes } from './bounded-process.ts'
import { BoundExceededError, CALL_BUDGETS } from './call-budgets.ts'

test('byte sync output is unchanged and remains output-bounded', () => {
  const bytes = startBoundedSyncBytes(
    [process.execPath, '-e', 'process.stdout.write(Uint8Array.from([0xff, 0xfe, 0x00, 0x61]))'],
    { budget: 'git-plumbing' },
  )
  expect([...bytes.stdout]).toEqual([0xff, 0xfe, 0x00, 0x61])

  expect(() =>
    startBoundedSyncBytes(
      [
        process.execPath,
        '-e',
        `process.stdout.write(new Uint8Array(${CALL_BUDGETS['git-plumbing'].outputBytes * 2}))`,
      ],
      { budget: 'git-plumbing' },
    ),
  ).toThrow(BoundExceededError)
})
