import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { automaticallyAdoptHostedBoard } from '../board/board-auto-adoption.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from '../board/board-mode.ts'
import { db } from '../database/db.ts'
import {
  blockedOutboxLines,
  quarantinedOutboxLines,
  quarantinedParentHeldLines,
  readOnlyDeferredLines,
  routingPoolLine,
  syncCommand,
} from './record-sync-command.ts'

test('sync adopts a zero-candidate local board with the configured record client', async () => {
  const output: string[] = []
  const baseClient = createMemoryRecordApiClient()
  await syncCommand(
    { backfill: false },
    { log: (line) => output.push(line) },
    {
      sync: async () =>
        ({
          configured: true,
          pushed: 0,
          failed: 0,
          pending: 0,
          quarantined: [],
          blocked: [],
        }) as never,
      automaticBoardAdoption: (presentation) =>
        automaticallyAdoptHostedBoard(presentation, {
          database: db(),
          client: {
            ...baseClient,
            whoami: async () => ({}) as never,
            listBoardChanges: async () => ({
              userId: '01990000-0000-7000-8000-000000000001',
              items: [],
              highestRevision: null,
            }),
          },
          hostedConfigured: () => true,
          signedIn: () => true,
        }),
    },
  )

  expect(
    db()
      .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
      .get(BOARD_HOSTED_ADOPTED_KEY),
  ).toEqual({ value: '1' })
  expect(output).toContain('board now uses the hosted record')
})

test('sync presentation names each quarantined row with its kind and error', () => {
  expect(
    quarantinedOutboxLines([
      {
        id: 28138,
        kind: 'score',
        recordId: 'record-id',
        error: "failure kind 'context' is not evidence",
        attempts: 149,
        quarantinedAt: '2026-09-28T00:00:00.000Z',
      },
    ]),
  ).toEqual(["quarantined 28138\tscore\tfailure kind 'context' is not evidence"])
})

test('sync presentation names a quarantined parent and its waiting rows', () => {
  expect(
    quarantinedParentHeldLines([
      { id: 48, kind: 'run', quarantinedAt: '2026-10-24T12:00:00.000Z', rows: 3 },
    ]),
  ).toEqual([
    `held: orch:48 run is quarantined at 2026-10-24T12:00:00.000Z; 3 rows wait on it; retry it with ${PLATFORM_SLUG} record outbox retry orch:48, or retire it with ${PLATFORM_SLUG} record outbox retire orch:48 --reason <text>`,
  ])
})

test('sync presentation names a row blocked by its retired parent', () => {
  expect(
    blockedOutboxLines([
      { id: 29153, kind: 'question', parentRecordId: '01990000-0000-7000-8000-parent' },
    ]),
  ).toEqual(['blocked 29153\tquestion\tretired parent 01990000-0000-7000-8000-parent'])
})

test('sync presentation reports read-only deferred rows by space', () => {
  // Production break watched: omit read-only deferred rows from sync presentation.
  expect(readOnlyDeferredLines([{ spaceId: 'space-a', rows: 2 }])).toEqual([
    'deferred 2\tread-only space space-a',
  ])
})

test('sync presentation reports routing pool fill progress and completion', () => {
  expect(routingPoolLine({ added: 500, updated: 0, caughtUp: false })).toBe(
    'routing pool: 500 added, 0 updated, filling',
  )
  expect(routingPoolLine({ added: 3, updated: 1, caughtUp: true })).toBe(
    'routing pool: 3 added, 1 updated, caught up',
  )
})
