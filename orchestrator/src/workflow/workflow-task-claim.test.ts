import { beforeEach, describe, expect, test } from 'bun:test'
import { boardClaimList } from '../board/board-operations.ts'
import { db } from '../database/db.ts'
import {
  decideTaskCursorClaim,
  followTaskCursorClaim,
  type TaskCursorClaimPorts,
} from './workflow-task-claim.ts'

const input = {
  project: 'claim-cursor-project',
  taskKey: 'DEV-2387',
  session: 'session-a',
} as const

beforeEach(() => {
  db().query('DELETE FROM board_claim').run()
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,settings)
       VALUES (lower(hex(randomblob(4))) || '-0000-7000-8000-' || lower(hex(randomblob(6))),?,?, '{}')`,
    )
    .run('claim-cursor-project', process.cwd())
})

describe('task cursor claim decision', () => {
  test('an owner verb takes or renews the owner claim', () => {
    expect(decideTaskCursorClaim({ ...input, verb: 'advance' })).toEqual({
      action: 'take',
      project: 'claim-cursor-project',
      key: 'DEV-2387',
      session: 'session-a',
    })
  })

  test('closing verbs release the claim, including without a harness session', () => {
    for (const verb of ['finish', 'abandon'] as const)
      expect(decideTaskCursorClaim({ ...input, session: null, verb })).toEqual({
        action: 'release',
        project: 'claim-cursor-project',
        key: 'DEV-2387',
      })
  })

  test('keyless cursors do not touch task claims', () => {
    expect(decideTaskCursorClaim({ ...input, taskKey: null, verb: 'compose' })).toEqual({
      action: 'none',
    })
  })
})

test('a rejecting take propagates', async () => {
  const ports: TaskCursorClaimPorts = {
    take: async () => {
      throw new Error('claim refused')
    },
    release: async () => ({ released: 0 }),
  }
  await expect(followTaskCursorClaim({ ...input, verb: 'compose' }, ports)).rejects.toThrow(
    'claim refused',
  )
})

test('the local adapter moves a compose claim and finish leaves none live', async () => {
  await followTaskCursorClaim({ ...input, verb: 'compose' })
  await followTaskCursorClaim({ ...input, session: 'session-b', verb: 'compose' })

  const moved = await boardClaimList('claim-cursor-project', true, { env: {} })
  expect(moved.claims).toHaveLength(2)
  expect(moved.claims[0]).toMatchObject({
    holder: 'session-a',
    closeReason: 'taken-over',
  })
  expect(moved.claims[1]).toMatchObject({ holder: 'session-b', live: true })

  await followTaskCursorClaim({ ...input, session: 'session-b', verb: 'finish' })
  expect((await boardClaimList('claim-cursor-project', false, { env: {} })).claims).toEqual([])
})

test('the local adapter releases a claim on session-less abandon', async () => {
  await followTaskCursorClaim({ ...input, verb: 'compose' })
  await followTaskCursorClaim({ ...input, session: null, verb: 'abandon' })

  expect((await boardClaimList('claim-cursor-project', false, { env: {} })).claims).toEqual([])
})
