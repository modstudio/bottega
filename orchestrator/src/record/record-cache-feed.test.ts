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
import { decodeRecordCursor } from './record-cursor.ts'

const cursor = (value: string) =>
  db()
    .query(
      "INSERT INTO schema_meta(key,value) VALUES ('record_change_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(value)
const spaces = (values: string[]) => {
  const value = JSON.stringify(values)
  db()
    .query(
      "INSERT INTO schema_meta(key,value) VALUES ('record_change_spaces',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(value)
  db()
    .query(
      "INSERT INTO schema_meta(key,value) VALUES ('record_change_pull_spaces',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(value)
}
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
const project = (name = 'feed-project') => {
  const id = newRecordId()
  db()
    .query("INSERT INTO project(record_id,name,path,settings) VALUES (?,?,?, '{}')")
    .run(id, name, `/tmp/${name}`)
  return { id, name }
}
const subjectRow = (id: string, projectName: string) => ({
  id,
  project: projectName,
  name: `Subject ${id}`,
  definition: 'Feed subject.',
  position: 0,
  parentId: null,
  retiredAt: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
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

test('a resolved doc fallback clears the orphan count and applies the child', async () => {
  const parent = newRecordId()
  const child = newRecordId()
  cursor('resolved-before')
  spaces(['space-a'])
  let request = 0
  const client = feedClient(async () =>
    request++ === 0
      ? {
          changes: [
            {
              table: 'doc',
              id: child,
              space: 'space-a',
              op: 'upsert',
              row: { ...docRow(child), parentId: parent },
            },
          ],
          cursor: 'resolved-after',
          lag: 0,
          more: false,
        }
      : empty('resolved-after'),
  )
  client.listDocs = async () => ({
    items: [docRow(parent), { ...docRow(child), parentId: parent }],
    nextCursor: null,
  })
  installRecordApiClient(client)

  expect(await pullRecordCache(db())).toMatchObject({ orphans: 0 })
  expect(db().query('SELECT parent_record_id FROM doc WHERE record_id=?').get(child)).toEqual({
    parent_record_id: parent,
  })
})

test('a failed doc fallback remains pending and is retried on the next sync', async () => {
  const parent = newRecordId()
  const child = newRecordId()
  cursor('pending-before')
  spaces(['space-a'])
  let request = 0
  const failing = feedClient(async () =>
    request++ === 0
      ? {
          changes: [
            {
              table: 'doc',
              id: child,
              space: 'space-a',
              op: 'upsert',
              row: { ...docRow(child), parentId: parent },
            },
          ],
          cursor: 'pending-after',
          lag: 0,
          more: false,
        }
      : empty('pending-after'),
  )
  failing.listDocs = async () => ({
    items: [{ ...docRow(child), parentId: parent }],
    nextCursor: null,
  })
  installRecordApiClient(failing)
  await expect(pullRecordCache(db())).rejects.toThrow('could not resolve document parent links')
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_cursor'").get(),
  ).toEqual({ value: 'pending-after' })
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_fallbacks'").get(),
  ).toEqual({ value: '["doc:space-a"]' })

  const retry = feedClient(async () => empty('pending-after'))
  retry.listDocs = async () => ({
    items: [docRow(parent), { ...docRow(child), parentId: parent }],
    nextCursor: null,
  })
  installRecordApiClient(retry)
  await pullRecordCache(db())

  expect(db().query('SELECT parent_record_id FROM doc WHERE record_id=?').get(child)).toEqual({
    parent_record_id: parent,
  })
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_fallbacks'").get(),
  ).toEqual({ value: '[]' })
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

test('non-owned docs and subjects, including tombstones, are skipped while the cursor advances', async () => {
  const registered = project()
  const doc = newRecordId()
  const subject = newRecordId()
  const tombstone = newRecordId()
  db()
    .query(
      `INSERT INTO doc(record_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,space_id)
       VALUES (?,'global',NULL,?,'Owned','Body','demand','["technical"]','a','a','space-a')`,
    )
    .run(tombstone, `owned-${tombstone}`)
  cursor('owned-before')
  spaces(['space-a', 'space-b'])
  let request = 0
  installRecordApiClient(
    feedClient(async () =>
      request++ === 0
        ? {
            changes: [
              { table: 'doc', id: doc, space: 'space-b', op: 'upsert', row: docRow(doc) },
              {
                table: 'subject',
                id: subject,
                space: 'space-b',
                op: 'upsert',
                row: subjectRow(subject, registered.name),
              },
              { table: 'doc', id: tombstone, space: 'space-b', op: 'delete' },
            ],
            cursor: 'owned-after',
            lag: 0,
            more: false,
          }
        : empty('owned-after'),
    ),
  )
  expect(await pullRecordCache(db())).toMatchObject({ skippedDocs: 1, skippedSubjects: 1 })
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(doc)).toBeNull()
  expect(db().query('SELECT 1 FROM subject WHERE id=?').get(subject)).toBeNull()
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(tombstone)).not.toBeNull()
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_cursor'").get(),
  ).toEqual({
    value: 'owned-after',
  })
})

test('move tombstones do not delete rows already upserted into another space', async () => {
  const doc = newRecordId()
  const workflow = newRecordId()
  db()
    .query(
      `INSERT INTO doc(record_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,space_id)
       VALUES (?,'global',NULL,?,'Moved','Body','demand','["technical"]','a','a','space-b')`,
    )
    .run(doc, `feed-${doc}`)
  db()
    .query(
      "INSERT INTO workflow(record_id,space_id,slug,generation,created_at) VALUES (?,'space-b',?,1,'a')",
    )
    .run(workflow, `workflow-${workflow}`)
  cursor('move-before')
  spaces(['space-a', 'space-b'])
  let request = 0
  installRecordApiClient(
    feedClient(
      async () =>
        request++ === 0
          ? {
              changes: [
                { table: 'doc', id: doc, space: 'space-b', op: 'upsert', row: docRow(doc) },
                { table: 'doc', id: doc, space: 'space-a', op: 'delete' },
                {
                  table: 'workflow',
                  id: workflow,
                  space: 'space-b',
                  op: 'upsert',
                  row: {
                    id: workflow,
                    spaceId: 'space-b',
                    slug: `workflow-${workflow}`,
                    generation: 1,
                    createdAt: 'a',
                  },
                },
                { table: 'workflow', id: workflow, space: 'space-a', op: 'delete' },
              ],
              cursor: 'move-after',
              lag: 0,
              more: false,
            }
          : empty('move-after'),
      async () => ({
        ...identity,
        activeSpaceId: 'space-b',
        memberships: [
          ...identity.memberships,
          {
            space_id: 'space-b',
            name: 'Space B',
            slug: 'space-b',
            role: 'member',
            permission: 'write',
          },
        ],
      }),
    ),
  )

  await pullRecordCache(db())
  expect(db().query('SELECT space_id FROM doc WHERE record_id=?').get(doc)).toEqual({
    space_id: 'space-b',
  })
  expect(db().query('SELECT space_id FROM workflow WHERE record_id=?').get(workflow)).toEqual({
    space_id: 'space-b',
  })
})

test('hosted feed upserts attach space ownership to existing null-space docs and subjects', async () => {
  const registered = project()
  const doc = newRecordId()
  const subject = newRecordId()
  db()
    .query(
      `INSERT INTO doc(record_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at)
       VALUES (?,'global',NULL,?,'Local','Body','demand','["technical"]','a','a')`,
    )
    .run(doc, `feed-${doc}`)
  db()
    .query(
      `INSERT INTO subject(id,project_record_id,name,definition,position,created_at,updated_at)
       VALUES (?,?,?,?,0,'a','a')`,
    )
    .run(subject, registered.id, `Subject ${subject}`, 'Local subject.')
  cursor('null-before')
  spaces(['space-a'])
  let request = 0
  installRecordApiClient(
    feedClient(async () =>
      request++ === 0
        ? {
            changes: [
              { table: 'doc', id: doc, space: 'space-a', op: 'upsert', row: docRow(doc) },
              {
                table: 'subject',
                id: subject,
                space: 'space-a',
                op: 'upsert',
                row: subjectRow(subject, registered.name),
              },
            ],
            cursor: 'null-after',
            lag: 0,
            more: false,
          }
        : empty('null-after'),
    ),
  )
  await pullRecordCache(db())
  expect(db().query('SELECT space_id FROM doc WHERE record_id=?').get(doc)).toEqual({
    space_id: 'space-a',
  })
  expect(db().query('SELECT space_id FROM subject WHERE id=?').get(subject)).toEqual({
    space_id: 'space-a',
  })
})

test('purge deletes child rows first and keeps a hosted parent referenced by a local row', async () => {
  const registered = project()
  const parent = newRecordId()
  const child = newRecordId()
  const local = newRecordId()
  const subject = newRecordId()
  const freeParent = newRecordId()
  const freeChild = newRecordId()
  db()
    .query(
      `INSERT INTO subject(id,project_record_id,name,definition,position,created_at,updated_at,space_id)
       VALUES (?,?,?,?,0,'a','a','lost-space')`,
    )
    .run(subject, registered.id, 'Related', 'Related subject.')
  db()
    .query(
      `INSERT INTO doc(record_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,parent_record_id,space_id)
       VALUES (?,'global',NULL,?,'Parent','Body','demand','["technical"]','a','a',NULL,'lost-space'),
              (?,'global',NULL,?,'Child','Body','demand','["technical"]','a','a',?,'lost-space'),
              (?,'global',NULL,?,'Local','Body','demand','["technical"]','a','a',?,NULL)`,
    )
    .run(
      parent,
      `parent-${parent}`,
      child,
      `child-${child}`,
      parent,
      local,
      `local-${local}`,
      parent,
    )
  db()
    .query(
      `INSERT INTO doc(record_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,parent_record_id,space_id)
       VALUES (?,'global',NULL,?,'Free parent','Body','demand','["technical"]','a','a',NULL,'lost-space'),
              (?,'global',NULL,?,'Free child','Body','demand','["technical"]','a','a',?,'lost-space')`,
    )
    .run(freeParent, `free-parent-${freeParent}`, freeChild, `free-child-${freeChild}`, freeParent)
  db()
    .query('INSERT INTO doc_related_subject(record_id,doc_record_id,subject_id) VALUES (?,?,?)')
    .run(newRecordId(), child, subject)
  cursor('purge-before')
  spaces(['lost-space'])
  installRecordApiClient(feedClient(async () => empty('purge-before')))
  const result = await pullRecordCache(db())
  expect(result.purgeKept).toBe(1)
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(parent)).not.toBeNull()
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(child)).toBeNull()
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(local)).not.toBeNull()
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(freeParent)).toBeNull()
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(freeChild)).toBeNull()
  expect(db().query('SELECT 1 FROM subject WHERE id=?').get(subject)).toBeNull()
})

test('a blocked tombstone is counted without pinning the feed cursor', async () => {
  const parent = newRecordId()
  const child = newRecordId()
  db()
    .query(
      `INSERT INTO doc(record_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,parent_record_id,space_id)
       VALUES (?,'global',NULL,?,'Parent','Body','demand','["technical"]','a','a',NULL,'space-a'),
              (?,'global',NULL,?,'Child','Body','demand','["technical"]','a','a',?,NULL)`,
    )
    .run(parent, `parent-${parent}`, child, `child-${child}`, parent)
  cursor('blocked-before')
  spaces(['space-a'])
  let request = 0
  installRecordApiClient(
    feedClient(async () =>
      request++ === 0
        ? {
            changes: [{ table: 'doc', id: parent, space: 'space-a', op: 'delete' }],
            cursor: 'blocked-after',
            lag: 0,
            more: false,
          }
        : empty('blocked-after'),
    ),
  )
  expect(await pullRecordCache(db())).toMatchObject({ deletesBlocked: 1 })
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(parent)).not.toBeNull()
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_cursor'").get(),
  ).toEqual({
    value: 'blocked-after',
  })
})

test('an empty live-space set leaves remembered spaces untouched and reports a warning', async () => {
  const hosted = newRecordId()
  cursor('empty-before')
  spaces(['remembered-space'])
  db()
    .query(
      `INSERT INTO doc(record_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,space_id)
       VALUES (?,'global',NULL,?,'Hosted','Body','demand','["technical"]','a','a','remembered-space')`,
    )
    .run(hosted, `hosted-${hosted}`)
  let changes = 0
  installRecordApiClient(
    feedClient(
      async () => {
        changes++
        return empty('empty-before')
      },
      async () => ({ ...identity, activeSpaceId: null, memberships: [] }),
    ),
  )
  const result = await pullRecordCache(db())
  expect(result.purgeWarning).toContain('not purged')
  expect(changes).toBe(0)
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(hosted)).not.toBeNull()
})

test('a membership outside the mirrored cache spaces is neither pulled nor remembered', async () => {
  cursor('membership-before')
  spaces([])
  const pulled: string[] = []
  const client = feedClient(
    async () => empty('membership-before'),
    async () => ({
      ...identity,
      memberships: [
        ...identity.memberships,
        {
          space_id: 'membership-only',
          name: 'Membership only',
          slug: 'membership-only',
          role: 'member',
          permission: 'write',
        },
      ],
    }),
  )
  client.listDocs = async (_query, destination) => {
    pulled.push(destination!.destinationSpaceId!)
    return { items: [], nextCursor: null }
  }
  installRecordApiClient(client)

  await pullRecordCache(db())

  expect(pulled).toEqual(['space-a'])
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_spaces'").get(),
  ).toEqual({ value: '["space-a"]' })
})

test('switching the active space keeps an accessible old mirror and pulls the new space', async () => {
  const hosted = newRecordId()
  cursor('switch-before')
  spaces(['space-a'])
  db()
    .query(
      `INSERT INTO doc(record_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,space_id)
       VALUES (?,'global',NULL,?,'Hosted','Body','demand','["technical"]','a','a','space-a')`,
    )
    .run(hosted, `hosted-${hosted}`)
  db()
    .query("INSERT INTO schema_meta(key,value) VALUES ('record_docs_cursor:space-a',?)")
    .run(JSON.stringify({ at: '2026-11-05T00:00:00.000Z', id: hosted }))
  const pulled: string[] = []
  const client = feedClient(
    async () => empty('switch-before'),
    async () => ({
      ...identity,
      activeSpaceId: 'space-b',
      memberships: [
        ...identity.memberships,
        {
          space_id: 'space-b',
          name: 'Space B',
          slug: 'space-b',
          role: 'member',
          permission: 'write',
        },
      ],
    }),
  )
  client.listDocs = async (_query, destination) => {
    pulled.push(destination!.destinationSpaceId!)
    return { items: [], nextCursor: null }
  }
  installRecordApiClient(client)

  await pullRecordCache(db())

  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(hosted)).not.toBeNull()
  expect(pulled).toEqual(['space-b'])
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_spaces'").get(),
  ).toEqual({ value: '["space-a","space-b"]' })
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_docs_cursor:space-a'").get(),
  ).toEqual({ value: JSON.stringify({ at: '2026-11-05T00:00:00.000Z', id: hosted }) })

  pulled.length = 0
  const switchedBack = feedClient(
    async () => empty('switch-before'),
    async () => identity,
  )
  switchedBack.listDocs = async (input, destination) => {
    pulled.push(destination!.destinationSpaceId!)
    expect(decodeRecordCursor(input.cursor!)).toEqual({
      at: '2026-11-05T00:00:00.000Z',
      id: hosted,
    })
    return { items: [], nextCursor: null }
  }
  installRecordApiClient(switchedBack)

  await pullRecordCache(db())

  expect(pulled).toEqual(['space-a'])
})

test('purge clears keyset cursors so a later rejoin pulls from the start', async () => {
  cursor('rejoin-before')
  spaces(['lost-space'])
  db()
    .query("INSERT INTO schema_meta(key,value) VALUES ('record_docs_cursor:lost-space','old')")
    .run()
  installRecordApiClient(feedClient(async () => empty('rejoin-before')))
  await pullRecordCache(db())
  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_docs_cursor:lost-space'").get(),
  ).toBeNull()

  let firstCursor: unknown = 'not-called'
  const client = feedClient(
    async () => empty('rejoin-before'),
    async () => ({
      ...identity,
      activeSpaceId: 'lost-space',
      memberships: [
        {
          space_id: 'lost-space',
          name: 'Lost',
          slug: 'lost',
          role: 'member',
          permission: 'write',
        },
      ],
    }),
  )
  client.listDocs = async (input) => {
    firstCursor = input.cursor
    return { items: [], nextCursor: null }
  }
  installRecordApiClient(client)
  await pullRecordCache(db())
  expect(firstCursor).toBeUndefined()
})
