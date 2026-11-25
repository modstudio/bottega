import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import { boardHeadHookShouldAct, boardHeadJudgeCommand } from './board-head-commands.ts'

const checkout = resolve(import.meta.dir, '../..')

function registeredDatabase() {
  const database = new Database(':memory:')
  database.run(
    'CREATE TABLE project (record_id TEXT PRIMARY KEY, name TEXT, path TEXT, stack TEXT, canon INTEGER, settings TEXT, retired_at TEXT)',
  )
  database.run('INSERT INTO project VALUES (?,?,?,?,?,?,NULL)', [
    'project',
    PLATFORM_SLUG,
    checkout,
    'bun',
    1,
    '{}',
  ])
  return database
}

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
  const file = resolve(checkout, 'orchestrator/src/board/candidate.ts')
  const payload = (content: string) =>
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content } })

  expect(
    boardHeadJudgeCommand(
      payload(
        "export function write(database) { database.query('UPDATE board_message SET title=?') }",
      ),
      registeredDatabase,
    ),
  ).toEqual({
    status: 'refused',
    findings: [
      {
        rule: 'local-board-sql-requires-head',
        dependency: expect.stringContaining(
          `${file} (orchestrator/src/board/candidate.ts:1: local board_message write`,
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
      registeredDatabase,
    ),
  ).toEqual({ status: 'ok', findings: [] })
})

test('board-head judge leaves a matching foreign checkout unchecked', () => {
  const file = '/tmp/other-project/orchestrator/src/board/candidate.ts'
  expect(
    boardHeadJudgeCommand(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: {
          file_path: file,
          content: "database.query('UPDATE board_message SET title=?')",
        },
      }),
      registeredDatabase,
    ),
  ).toEqual({
    status: 'unchecked',
    findings: [],
    reason: `candidate ${file} is not inside a registered ${PLATFORM_NAME} checkout`,
  })
})
