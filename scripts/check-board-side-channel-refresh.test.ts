import { expect, test } from 'bun:test'
import { boardSideChannelRefreshViolations } from './check-board-side-channel-refresh.ts'

const violations = (body: string) =>
  boardSideChannelRefreshViolations(
    `async function claimRunBoardNotices() {\n${body}\n}`,
    'board-delivery.ts',
    ['claimRunBoardNotices'],
  )

test.each([
  ["if (refreshed.status !== 'success') throw new Error('stopped')", 2],
  ["const stopped = refreshed.status !== 'success'\nif (stopped) throw new Error('stopped')", 3],
  [
    "switch (refreshed.status) {\n  case 'success': break\n  default: throw new Error('stopped')\n}",
    4,
  ],
  ["rows.map(() => { throw new Error('stopped') })", 2],
])('a throw in a side channel is refused for each control-flow shape', (body, line) => {
  expect(violations(body)).toEqual([
    { file: 'board-delivery.ts', functionName: 'claimRunBoardNotices', line },
  ])
})

test('a side channel without a throw passes', () => {
  expect(violations("return { notices: [], warning: 'stopped' }")).toEqual([])
})

test('an absent expected side channel is refused', () => {
  expect(
    boardSideChannelRefreshViolations('function anotherFunction() {}', 'board-delivery.ts', [
      'claimRunBoardNotices',
    ]),
  ).toEqual([{ file: 'board-delivery.ts', functionName: 'claimRunBoardNotices', line: 1 }])
})
