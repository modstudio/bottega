import { expect, test } from 'bun:test'
import {
  type FloorEvidencePorts,
  invokeFloorEvidencePort,
  MAX_FLOOR_EVIDENCE_REPLAY_ROUNDS,
  withReplayedFloorEvidence,
} from './workflow-floor-evidence-replay.ts'

test('external floor evidence misses once and then replays the recorded result', () => {
  let calls = 0
  const ports: FloorEvidencePorts = {
    readTask: (key) => {
      calls += 1
      return { key, status: 'done', statusCategory: 'done', commentIds: [] }
    },
  }
  const result = withReplayedFloorEvidence(ports, (replay) =>
    replay.readTask!('DEV-1141', { fresh: true }),
  )
  expect(result.key).toBe('DEV-1141')
  expect(calls).toBe(1)
})

test('recorded floor evidence errors are rethrown without calling the port again', () => {
  const refusal = new Error('tracker unavailable')
  let calls = 0
  expect(() =>
    withReplayedFloorEvidence(
      {
        readTask: () => {
          calls += 1
          throw refusal
        },
      },
      (replay) => replay.readTask!('DEV-1141', { fresh: true }),
    ),
  ).toThrow(refusal)
  expect(calls).toBe(1)
})

test('different floor evidence arguments are separate misses', () => {
  const calls: string[] = []
  const result = withReplayedFloorEvidence(
    {
      readTask: (key) => {
        calls.push(key)
        return { key, status: 'done', statusCategory: 'done', commentIds: [] }
      },
    },
    (replay) => [
      replay.readTask!('DEV-1141', { fresh: true }).key,
      replay.readTask!('DEV-1142', { fresh: true }).key,
    ],
  )
  expect(result).toEqual(['DEV-1141', 'DEV-1142'])
  expect(calls).toEqual(['DEV-1141', 'DEV-1142'])
})

test('inline default ports use the same miss and replay path', () => {
  let calls = 0
  const result = withReplayedFloorEvidence({}, (replay) =>
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

test('the replay round bound refuses and names the port still missing', () => {
  let round = 0
  expect(() =>
    withReplayedFloorEvidence(
      {
        resolveTreeCommit: (worktree) => worktree,
      },
      (replay) => replay.resolveTreeCommit!(`/tmp/tree-${round++}`),
    ),
  ).toThrow(
    `floor evidence replay exhausted after ${MAX_FLOOR_EVIDENCE_REPLAY_ROUNDS} rounds; still missing resolveTreeCommit`,
  )
})
