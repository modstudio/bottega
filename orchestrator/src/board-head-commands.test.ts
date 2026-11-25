import { expect, test } from 'bun:test'
import { boardHeadHookShouldAct, boardHeadJudgeCommand } from './board-head-commands.ts'

test('board-head hook pre-check is narrow to production orchestrator board content', () => {
  expect(
    boardHeadHookShouldAct(
      '/repo/orchestrator/src/board/candidate.ts',
      "database.query('UPDATE board_message SET title=?')",
    ),
  ).toBeTrue()
  expect(
    boardHeadHookShouldAct(
      '/repo/orchestrator/src/run/candidate.ts',
      "import { insertRootMessage } from '../board/board-store.ts'",
    ),
  ).toBeTrue()
  expect(
    boardHeadHookShouldAct(
      '/repo/orchestrator/src/board/candidate.test.ts',
      "database.query('INSERT INTO board_message VALUES (?)')",
    ),
  ).toBeFalse()
  expect(
    boardHeadHookShouldAct('/repo/hub/src/candidate.ts', 'const board_message = 1'),
  ).toBeFalse()
  expect(
    boardHeadHookShouldAct('/repo/orchestrator/src/run/candidate.ts', 'const safe = 1'),
  ).toBeFalse()
})

test('board-head judge refuses an unheaded proposed file and accepts a headed one', () => {
  const file = '/repo/orchestrator/src/board/candidate.ts'
  const payload = (content: string) =>
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content } })

  expect(
    boardHeadJudgeCommand(
      payload(
        "export function write(database) { database.query('UPDATE board_message SET title=?') }",
      ),
    ),
  ).toEqual({
    status: 'refused',
    findings: [
      {
        rule: 'local-board-sql-requires-head',
        dependency: expect.stringContaining(
          'orchestrator/src/board/candidate.ts:1: local board_message write',
        ),
      },
    ],
  })
  expect(
    boardHeadJudgeCommand(
      payload(`export function write(database) {
        requireLocalBoardWrite('notice post', process.env, database)
        database.query('UPDATE board_message SET title=?')
      }`),
    ),
  ).toEqual({ status: 'ok', findings: [] })
})
