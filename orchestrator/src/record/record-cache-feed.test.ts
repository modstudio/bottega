import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  identity,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import type { RecordApiClient } from './record-api-client.ts'
import type { RecordChangePage } from './record-api-client-changes.ts'
import { pullRecordCache } from './record-cache.ts'

const cursor = (value: string) =>
  db()
    .query(
      "INSERT INTO schema_meta(key,value) VALUES ('record_change_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(value)
const spaces = (values: string[]) =>
  db()
    .query(
      "INSERT INTO schema_meta(key,value) VALUES ('record_change_spaces',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(JSON.stringify(values))
const empty = (at: string): RecordChangePage => ({
  changes: [],
  cursor: at,
  lag: 0,
  more: false,
})
const docRow = (id: string) => ({
  id,
  scope: 'global',
  subject: null,
  owner: null,
  slug: `feed-${id}`,
  title: 'Feed document',
  body: 'Body',
  delivery: 'demand',
  audiences: ['technical'],
  parentId: null,
  position: 0,
  relatedSubjects: [],
  sourceFiles: [],
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
  deletedAt: null,
})

function feedClient(
  listChanges: RecordApiClient['listChanges'],
  whoami: RecordApiClient['whoami'] = async () => identity,
): RecordApiClient {
  return { ...createMemoryRecordApiClient(), whoami, listChanges }
}

test('record cache applies a page and an idle sync costs whoami plus one changes request', async () => {
  const id = newRecordId()
  cursor('before')
  spaces(['space-a'])
  let requests = 0
  const pages = [
    {
      changes: [{ table: 'doc', id, space: 'space-a', op: 'upsert' as const, row: docRow(id) }],
      cursor: 'after',
      lag: 0,
      more: false,
    },
    empty('after'),
  ]
  installRecordApiClient(feedClient(async () => pages[requests++]!))
  const applied = await pullRecordCache(db())
  expect(applied).toMatchObject({ docs: 1, changes: 1, orphans: 0, reset: false })
  expect(db().query('SELECT space_id FROM doc WHERE record_id=?').get(id)).toEqual({
    space_id: 'space-a',
  })

  let whoami = 0
  requests = 0
  installRecordApiClient(
    feedClient(
      async () => {
        requests++
        return empty('after')
      },
      async () => {
        whoami++
        return identity
      },
    ),
  )
  expect(await pullRecordCache(db())).toMatchObject({ changes: 0 })
  expect({ requests, whoami }).toEqual({ requests: 1, whoami: 1 })
})

test('record cache compare-and-set skips a stale page', async () => {
  const id = newRecordId()
  cursor('requested')
  spaces(['space-a'])
  let request = 0
  installRecordApiClient(
    feedClient(async () => {
      if (request++ === 0) {
        cursor('advanced-elsewhere')
        return {
          changes: [{ table: 'doc', id, space: 'space-a', op: 'upsert' as const, row: docRow(id) }],
          cursor: 'stale-page',
          lag: 0,
          more: false,
        }
      }
      return empty('advanced-elsewhere')
    }),
  )
  expect(await pullRecordCache(db())).toMatchObject({ docs: 0, changes: 0 })
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(id)).toBeNull()
})

test('record cache advances past an orphan and runs that family keyset fallback', async () => {
  cursor('before-orphan')
  spaces(['space-a'])
  let request = 0
  let fallback = 0
  const client = feedClient(async () =>
    request++ === 0
      ? {
          changes: [
            {
              table: 'workflow_version',
              id: newRecordId(),
              space: 'space-a',
              op: 'upsert' as const,
              row: {
                id: newRecordId(),
                spaceId: 'space-a',
                ownerId: newRecordId(),
                updatedAt: '2026-11-05T00:00:00.000Z',
              },
            },
          ],
          cursor: 'after-orphan',
          lag: 0,
          more: false,
        }
      : empty('after-orphan'),
  )
  client.listWorkflowCatalogue = async () => {
    fallback++
    return { items: [], nextCursor: null }
  }
  installRecordApiClient(client)
  expect(await pullRecordCache(db())).toMatchObject({ changes: 0, orphans: 1 })
  expect(fallback).toBeGreaterThan(0)
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_cursor'").get(),
  ).toEqual({ value: 'after-orphan' })
})

test('record cache resets on 410 and purges only hosted rows from a lost space', async () => {
  const hosted = newRecordId()
  const local = newRecordId()
  const run = newRecordId()
  cursor('expired')
  spaces(['lost-space'])
  db()
    .query(
      `INSERT INTO doc (record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences,space_id)
     VALUES (?,'global',NULL,?,'Hosted','Body','demand','a','a','["technical"]','lost-space'),
            (?,'global',NULL,?,'Local','Body','demand','a','a','["technical"]',NULL)`,
    )
    .run(hosted, `hosted-${hosted}`, local, `local-${local}`)
  db()
    .query(
      `INSERT INTO run (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,probe)
     VALUES (99123,?,'a','agent','implement','sha',1,'prompt','ok',1)`,
    )
    .run(run)
  let changes = 0
  installRecordApiClient(
    feedClient(
      async () => {
        changes++
        return { reset: { cursor: 'horizon', tables: ['doc'] } }
      },
      async () => ({
        ...identity,
        memberships: [
          ...identity.memberships,
          {
            space_id: 'joined-space',
            name: 'Joined',
            slug: 'joined',
            role: 'member',
            permission: 'write',
          },
        ],
      }),
    ),
  )
  const reset = await pullRecordCache(db())
  expect(reset.reset).toBe(true)
  expect(changes).toBe(1)
  expect(db().query('SELECT record_id FROM doc WHERE record_id=?').get(hosted)).toBeNull()
  expect(db().query('SELECT record_id FROM doc WHERE record_id=?').get(local)).not.toBeNull()
  expect(db().query('SELECT record_id FROM run WHERE record_id=?').get(run)).not.toBeNull()
})
