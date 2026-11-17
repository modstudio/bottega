import { beforeEach, expect, test } from 'bun:test'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import {
  boardClaimList,
  boardClaimRelease,
  boardClaimReleaseTask,
  boardClaimTake,
} from './board-operations.ts'

const destinationResolver = async (_client: unknown, project?: string | null) => ({
  destinationSpaceId: project ? `space:${project}` : 'space:personal',
})

const env = {
  CLAUDE_CODE_SESSION_ID: 'board-route-session',
  BOTTEGA_RECORD_API_URL: 'https://record.test',
}
const noRecordEnv = {
  [CONFIG_HOME_ENV]: '/definitely-missing-config',
  [HARNESS_ENV_FILE_ENV]: '',
}

beforeEach(() => {
  db().query('DELETE FROM schema_meta WHERE key=?').run(BOARD_HOSTED_ADOPTED_KEY)
  db().query('DELETE FROM board_claim').run()
  db()
    .query(
      "INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(16))),'board-route-project','/tmp/board-route-project','{}')",
    )
    .run()
  db()
    .query(
      "INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(16))),'board-route-architect',?,'{}')",
    )
    .run(process.cwd())
})

test('manual task claim take and release direct callers to the cursor verbs', async () => {
  const clock = Date.parse('2026-10-05T12:00:00Z')
  await expect(
    boardClaimTake(
      { subject: 'task:DEV-1', project: 'board-route-project' },
      { env: noRecordEnv, clock },
    ),
  ).rejects.toThrow('workflow compose … --arg key=DEV-1')

  const claim = await boardClaimTake(
    { subject: 'task:DEV-1', project: 'board-route-project' },
    {
      env: noRecordEnv,
      clock,
      taskCursorAuthority: { mode: 'take', session: 'cursor-session' },
      cwd: '/tmp/board-route-project',
    },
  )
  await expect(
    boardClaimRelease(claim.recordId, { env: noRecordEnv, clock: clock + 1 }),
  ).rejects.toThrow('workflow next to the end or workflow abandon')
})

test('release-task normalizes a task subject before releasing a local claim', async () => {
  const clock = Date.parse('2026-10-05T12:00:00Z')
  const claim = await boardClaimTake(
    { subject: 'task:DEV-1', project: 'board-route-project' },
    {
      env: noRecordEnv,
      clock,
      taskCursorAuthority: { mode: 'take', session: 'cursor-session' },
      cwd: '/tmp/board-route-project',
    },
  )
  await expect(
    boardClaimReleaseTask('task:DEV-1', 'board-route-project', {
      env: noRecordEnv,
      clock: clock + 1,
    }),
  ).resolves.toEqual({ released: 1 })
  await expect(
    boardClaimList('board-route-project', true, { env: noRecordEnv, clock: clock + 1 }),
  ).resolves.toEqual({
    claims: [expect.objectContaining({ recordId: claim.recordId, closeReason: 'task-closed' })],
  })
})

test('the uncovered read authority lists claims for a foreign registered project', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const listedProjects: string[] = []
  const client = {
    ...createMemoryRecordApiClient(),
    listBoardClaims: async (project: string) => {
      listedProjects.push(project)
      return { claims: [] }
    },
  }
  const context = {
    env,
    cwd: process.cwd(),
    client,
    destinationResolver,
  }

  await expect(boardClaimList('board-route-project', true, context)).rejects.toThrow(
    'architect session belongs to project board-route-architect',
  )
  await expect(
    boardClaimList('board-route-project', true, {
      ...context,
      taskCursorAuthority: { mode: 'coverage-read', session: null },
    }),
  ).resolves.toEqual({ claims: [] })
  expect(listedProjects).toEqual(['board-route-project'])
})
