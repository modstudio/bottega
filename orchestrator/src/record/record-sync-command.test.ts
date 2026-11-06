import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from '../board/board-mode.ts'
import { db } from '../database/db.ts'
import {
  blockedOutboxLines,
  projectRegisterLines,
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
      boardAdoption: {
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
      },
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

test('sync presentation reports project register counts and every skip reason', () => {
  expect(
    projectRegisterLines({
      updated: 2,
      retired: 1,
      unretired: 1,
      skipped: 1,
      warnings: [
        'project old-name cannot mirror hosted name new-name because it collides with local project new-name',
      ],
    }),
  ).toEqual([
    'project register: 2 updated, 1 retired, 1 un-retired, 1 skipped',
    'project register skipped: project old-name cannot mirror hosted name new-name because it collides with local project new-name',
  ])
})

test('sync presentation reports released run payloads skipped by backfill', async () => {
  const output: string[] = []
  await syncCommand(
    { backfill: true },
    { log: (line) => output.push(line) },
    {
      sync: async () =>
        ({
          configured: false,
          pushed: 0,
          failed: 0,
          pending: 0,
          quarantined: [],
          blocked: [],
          backfill: {
            enqueued: 0,
            refreshedLinks: 0,
            refreshedNumbers: 0,
            refreshedRoots: 0,
            skippedReleased: 2,
            skippedLive: 1,
            questions: { enqueued: 0 },
            scores: 0,
            reviews: { enqueuedReviews: 0, enqueuedReads: 0 },
            landingEvidence: {
              enqueuedLandings: 0,
              enqueuedOverrides: 0,
              enqueuedCarries: 0,
              enqueuedContentions: 0,
              enqueuedFlakes: 0,
              enqueuedPullRequestCi: 0,
            },
            releases: { enqueued: 0 },
          },
        }) as never,
      boardAdoption: {
        database: db(),
        hostedConfigured: () => false,
        signedIn: () => false,
      } as never,
    },
  )

  expect(output[0]).toContain('skipped-released 2, skipped-live 1')
})

test('sync presentation reports only nonzero record-cache misses and its purge warning', async () => {
  const output: string[] = []
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
          orphans: 2,
          deletesBlocked: 1,
          purgeKept: 3,
          skippedDocs: 4,
          skippedSubjects: 0,
          purgeWarning: 'memberships unavailable',
        }) as never,
      boardAdoption: {
        database: db(),
        hostedConfigured: () => false,
        signedIn: () => false,
      } as never,
    },
  )
  expect(output).toContain('record cache orphans: 2')
  expect(output).toContain('record cache deletes blocked: 1')
  expect(output).toContain('record cache purge rows kept: 3')
  expect(output).toContain('record cache docs skipped: 4')
  expect(output.some((line) => line.includes('subjects skipped'))).toBe(false)
  expect(output).toContain('record cache purge warning: memberships unavailable')
})
