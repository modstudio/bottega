import { expect, test } from 'bun:test'
import {
  BOARD_MAX_PATH_TAGS,
  BOARD_TOPICS,
  inferredBoardTags,
  senderBoardTags,
} from './board-tags.ts'

test('sender tags remove exact duplicates before enforcing their bounds', () => {
  expect(
    senderBoardTags({ paths: Array(BOARD_MAX_PATH_TAGS + 1).fill('orchestrator/src/**') }),
  ).toHaveLength(1)
})

test('invalid paths and unknown topics are refused with remedies', () => {
  expect(() => senderBoardTags({ paths: ['../outside'] })).toThrow(/remove that segment/)
  expect(() => senderBoardTags({ topics: ['unknown'] })).toThrow(BOARD_TOPICS.join(', '))
})

test('inference adds current task and valid quoted paths only after a sender tag', () => {
  const sender = senderBoardTags({ topics: ['gate'] })
  expect(
    inferredBoardTags(
      'Use `orchestrator/src/board/**`, not `../outside/file` or `single-token`.',
      sender,
      'DEV-968',
    ),
  ).toEqual([
    { kind: 'task', value: 'DEV-968', origin: 'inferred' },
    { kind: 'path', value: 'orchestrator/src/board/**', origin: 'inferred' },
  ])
  expect(inferredBoardTags('See `orchestrator/src/board/**`.', [], 'DEV-968')).toEqual([])
})
