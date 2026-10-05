import { expect, test } from 'bun:test'
import { type BoardSessionContext, boardNoticeMatches } from './board-routing.ts'
import type { BoardTag, BoardTagKind } from './board-tags.ts'

const tag = (kind: BoardTagKind, value: string): BoardTag => ({ kind, value, origin: 'sender' })
const context = (input: {
  taskKeys?: string[]
  changedPaths?: string[]
  topics?: string[]
}): BoardSessionContext => ({
  taskKeys: new Set(input.taskKeys),
  changedPaths: new Set(input.changedPaths),
  topics: new Set(input.topics),
})

test('an untagged notice matches every session', () => {
  expect(boardNoticeMatches([], context({}))).toBeTrue()
})

test('a task tag matches a session task key', () => {
  expect(
    boardNoticeMatches([tag('task', 'DEV-968')], context({ taskKeys: ['DEV-968'] })),
  ).toBeTrue()
})

test('a path glob matches a changed path', () => {
  expect(
    boardNoticeMatches(
      [tag('path', 'orchestrator/src/board/**')],
      context({ changedPaths: ['orchestrator/src/board/board-service.ts'] }),
    ),
  ).toBeTrue()
})

test('a path glob does not match an unrelated changed path', () => {
  expect(
    boardNoticeMatches(
      [tag('path', 'hub/web/**')],
      context({ changedPaths: ['orchestrator/src/board/board-service.ts'] }),
    ),
  ).toBeFalse()
})

test('a topic tag matches a known session topic', () => {
  expect(boardNoticeMatches([tag('topic', 'gate')], context({ topics: ['gate'] }))).toBeTrue()
})

test('topic-only notices match when session topics are unknown', () => {
  expect(
    boardNoticeMatches([tag('topic', 'gate'), tag('topic', 'infra')], context({ topics: [] })),
  ).toBeTrue()
})

test('any matching tag is sufficient', () => {
  expect(
    boardNoticeMatches(
      [tag('task', 'DEV-OTHER'), tag('path', 'shared/**')],
      context({ changedPaths: ['shared/brand.ts'] }),
    ),
  ).toBeTrue()
})
