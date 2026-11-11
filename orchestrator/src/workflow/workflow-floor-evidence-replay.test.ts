import { expect, test } from 'bun:test'
import {
  type FloorEvidencePorts,
  invokeFloorEvidencePort,
  MAX_FLOOR_EVIDENCE_REPLAY_ROUNDS,
  withReplayedFloorEvidenceAsync,
} from './workflow-floor-evidence-replay.ts'

test('external floor evidence misses once and then replays the recorded result', async () => {
  let calls = 0
  const ports: FloorEvidencePorts = {
    readTask: (key) => {
      calls += 1
      return { key, status: 'done', statusCategory: 'done', commentIds: [] }
    },
  }
  const result = await withReplayedFloorEvidenceAsync(ports, async (replay) =>
    replay.readTask!('DEV-1141', { fresh: true }),
  )
  expect(result.key).toBe('DEV-1141')
  expect(calls).toBe(1)
})

test('recorded floor evidence errors are rethrown without calling the port again', async () => {
  const refusal = new Error('tracker unavailable')
  let calls = 0
  await expect(
    withReplayedFloorEvidenceAsync(
      {
        readTask: () => {
          calls += 1
          throw refusal
        },
      },
      async (replay) => replay.readTask!('DEV-1141', { fresh: true }),
    ),
  ).rejects.toThrow(refusal)
  expect(calls).toBe(1)
})

test('different floor evidence arguments are separate misses', async () => {
  const calls: string[] = []
  const result = await withReplayedFloorEvidenceAsync(
    {
      readTask: (key) => {
        calls.push(key)
        return { key, status: 'done', statusCategory: 'done', commentIds: [] }
      },
    },
    async (replay) => [
      replay.readTask!('DEV-1141', { fresh: true }).key,
      replay.readTask!('DEV-1142', { fresh: true }).key,
    ],
  )
  expect(result).toEqual(['DEV-1141', 'DEV-1142'])
  expect(calls).toEqual(['DEV-1141', 'DEV-1142'])
})

test('inline default ports use the same miss and replay path', async () => {
  let calls = 0
  const result = await withReplayedFloorEvidenceAsync({}, async (replay) =>
    invokeFloorEvidencePort(
      replay,
      'resolveTreeCommit',
      () => {
        calls += 1
        return 'abc123'
      },
      '/tmp/tree',
    ),
  )
  expect(result).toBe('abc123')
  expect(calls).toBe(1)
})

test('the replay round bound refuses and names the port still missing', async () => {
  let round = 0
  await expect(
    withReplayedFloorEvidenceAsync(
      {
        resolveTreeCommit: (worktree) => worktree,
      },
      async (replay) => replay.resolveTreeCommit!(`/tmp/tree-${round++}`),
    ),
  ).rejects.toThrow(
    `floor evidence replay exhausted after ${MAX_FLOOR_EVIDENCE_REPLAY_ROUNDS} rounds; still missing resolveTreeCommit`,
  )
})
