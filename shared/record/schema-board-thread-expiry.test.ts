import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { BOARD_STANDING_DEFAULT_EXPIRY_MS } from '../board-duration.ts'
import { RECORD_ACTOR_ROLE } from './schema.ts'

const migrationsFolder = join(fileURLToPath(new URL('.', import.meta.url)), 'migrations')
const extendFunction = 'public.board_message_extend_thread_expiry'

const spaceId = '01990000-0000-7000-8000-000000001380'
const projectId = '01990000-0000-7000-8000-000000001381'
const authorUserId = '01990000-0000-7000-8000-000000001382'
const replyUserId = '01990000-0000-7000-8000-000000001383'
const otherUserId = '01990000-0000-7000-8000-000000001386'
const authorMembershipId = '01990000-0000-7000-8000-000000001384'
const replyMembershipId = '01990000-0000-7000-8000-000000001385'
const otherMembershipId = '01990000-0000-7000-8000-000000001387'
const ids = {
  live: '01990000-0000-7000-8000-000000001390',
  liveReply: '01990000-0000-7000-8000-000000001391',
  noReply: '01990000-0000-7000-8000-000000001392',
  other: '01990000-0000-7000-8000-000000001393',
  otherReply: '01990000-0000-7000-8000-000000001394',
  withdrawn: '01990000-0000-7000-8000-000000001395',
  withdrawnReply: '01990000-0000-7000-8000-000000001396',
  expired: '01990000-0000-7000-8000-000000001397',
  expiredReply: '01990000-0000-7000-8000-000000001398',
  clamped: '01990000-0000-7000-8000-000000001399',
  clampedReply: '01990000-0000-7000-8000-000000001400',
  later: '01990000-0000-7000-8000-000000001401',
  laterReply: '01990000-0000-7000-8000-000000001402',
  beyond: '01990000-0000-7000-8000-000000001403',
  beyondReply: '01990000-0000-7000-8000-000000001404',
} as const

async function applyMigration(transaction: Transaction, migration: MigrationMeta) {
  for (const statement of migration.sql) await transaction.exec(statement)
  await transaction.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash,created_at,name) VALUES ($1,$2,$3)',
    [migration.hash, migration.folderMillis, migration.name],
  )
}

function seedSql(): string {
  const root = (id: string, expiry: string, withdrawn = 'NULL') => `
    INSERT INTO board_message (
      id, author_user_id, kind, purpose, audience, title, body, ack_required, expires_at,
      created_at, withdrawn_at, scope_project_ids
    ) VALUES (
      '${id}', '${authorUserId}', 'notice', 'information', 'project:thread-expiry',
      'Thread expiry proof', 'body', false, ${expiry}, now(), ${withdrawn},
      ARRAY['${projectId}']::uuid[]
    );`
  const reply = (id: string, rootId: string, author = replyUserId) => `
    INSERT INTO board_message (
      id, author_user_id, kind, purpose, thread_root_id, audience, title, body, ack_required,
      ack_deadline, expires_at, created_at, scope_project_ids
    ) VALUES (
      '${id}', '${author}', 'reply', NULL, '${rootId}', NULL, NULL, 'reply', false,
      NULL, NULL, now(), ARRAY['${projectId}']::uuid[]
    );`
  return `
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${spaceId}','Thread expiry','thread-expiry',now());
    INSERT INTO "user" (id,email,name,created_at) VALUES
      ('${authorUserId}','thread-expiry-author@example.test','Author',now()),
      ('${replyUserId}','thread-expiry-replier@example.test','Replier',now()),
      ('${otherUserId}','thread-expiry-other@example.test','Other',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at) VALUES
      ('${authorMembershipId}','${spaceId}','${authorUserId}','member','write',now()),
      ('${replyMembershipId}','${spaceId}','${replyUserId}','member','write',now()),
      ('${otherMembershipId}','${spaceId}','${otherUserId}','member','write',now());
    INSERT INTO project (id,space_id,name,created_at)
    VALUES ('${projectId}','${spaceId}','thread-expiry',now());
    ${root(ids.live, "now() + interval '1 hour'")}
    ${reply(ids.liveReply, ids.live)}
    ${root(ids.noReply, "now() + interval '1 hour'")}
    ${root(ids.other, "now() + interval '1 hour'")}
    ${reply(ids.otherReply, ids.other, otherUserId)}
    ${root(ids.withdrawn, "now() + interval '1 hour'", 'now()')}
    ${reply(ids.withdrawnReply, ids.withdrawn)}
    ${root(ids.expired, "now() - interval '1 hour'")}
    ${reply(ids.expiredReply, ids.expired)}
    ${root(ids.clamped, "now() + interval '1 hour'")}
    ${reply(ids.clampedReply, ids.clamped)}
    ${root(ids.later, "now() + interval '2 hours'")}
    ${reply(ids.laterReply, ids.later)}
    ${root(ids.beyond, "now() + interval '8 days'")}
    ${reply(ids.beyondReply, ids.beyond)}
  `
}

async function createRecordDatabase(): Promise<PGlite> {
  const database = new PGlite()
  await database.exec(`
    CREATE ROLE record_owner LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE record_actor LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE record_auth LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE record_public NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE record_reader LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT record_public TO record_actor WITH INHERIT FALSE, SET TRUE;
    GRANT CREATE ON DATABASE postgres TO record_owner;
    ALTER SCHEMA public OWNER TO record_owner;
    SET ROLE record_owner;
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY, hash text NOT NULL, created_at bigint, name text
    );
  `)
  await database.transaction(async (transaction) => {
    for (const migration of readMigrationFiles({ migrationsFolder })) {
      await applyMigration(transaction, migration)
    }
  })
  await database.exec(`RESET ROLE;${seedSql()}`)
  return database
}

async function bindReplier(database: PGlite) {
  await database.exec(`
    SET ROLE ${RECORD_ACTOR_ROLE};
    SELECT set_config('app.user_id','${replyUserId}',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SELECT set_config('app.space_ids','${spaceId}',false);
  `)
}

async function resetSession(database: PGlite) {
  await database.exec(`
    RESET ROLE;
    SELECT set_config('app.user_id','',false);
    SELECT set_config('app.space_id','',false);
    SELECT set_config('app.space_ids','',false);
  `)
}

async function messageState(database: PGlite, id: string) {
  const rows = await database.query<{ expires_at: Date; revision: string }>(
    'SELECT expires_at, revision FROM board_message WHERE id = $1',
    [id],
  )
  expect(rows.rows).toHaveLength(1)
  return rows.rows[0]!
}

async function extend(database: PGlite, id: string, expiry: string): Promise<boolean> {
  const rows = await database.query<{ extended: boolean }>(
    `SELECT ${extendFunction}($1::uuid, $2::timestamptz) AS extended`,
    [id, expiry],
  )
  return rows.rows[0]!.extended
}

let database: PGlite

beforeAll(async () => {
  database = await createRecordDatabase()
})

afterAll(async () => {
  if (database) await database.close()
})

test('a reply author extends a live root and advances its revision', async () => {
  await bindReplier(database)
  try {
    const before = await messageState(database, ids.live)
    const requested = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    expect(await extend(database, ids.live, requested)).toBeTrue()
    const after = await messageState(database, ids.live)
    expect(new Date(after.expires_at).toISOString()).toBe(requested)
    expect(BigInt(after.revision) > BigInt(before.revision)).toBeTrue()
  } finally {
    await resetSession(database)
  }
})

test('an actor with no reply on the root changes nothing', async () => {
  await bindReplier(database)
  try {
    const requested = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    for (const id of [ids.noReply, ids.other]) {
      const before = await messageState(database, id)
      expect(await extend(database, id, requested)).toBeFalse()
      expect(await messageState(database, id)).toEqual(before)
    }
  } finally {
    await resetSession(database)
  }
})

test('withdrawn and expired roots cannot be extended', async () => {
  await bindReplier(database)
  try {
    const requested = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    for (const id of [ids.withdrawn, ids.expired]) {
      const before = await messageState(database, id)
      expect(await extend(database, id, requested)).toBeFalse()
      expect(await messageState(database, id)).toEqual(before)
    }
  } finally {
    await resetSession(database)
  }
})

test('an expiry beyond the standing bound is clamped without raising', async () => {
  await bindReplier(database)
  try {
    expect(await extend(database, ids.clamped, '2099-01-01T00:00:00.000Z')).toBeTrue()
    const state = await messageState(database, ids.clamped)
    const remaining = new Date(state.expires_at).getTime() - Date.now()
    expect(remaining).toBeGreaterThan(BOARD_STANDING_DEFAULT_EXPIRY_MS - 1_000)
    expect(remaining).toBeLessThanOrEqual(BOARD_STANDING_DEFAULT_EXPIRY_MS)
  } finally {
    await resetSession(database)
  }
})

test('expiry and revision do not move when the requested expiry is earlier', async () => {
  await bindReplier(database)
  try {
    const before = await messageState(database, ids.later)
    expect(
      await extend(database, ids.later, new Date(Date.now() + 60 * 60 * 1000).toISOString()),
    ).toBeTrue()
    expect(await messageState(database, ids.later)).toEqual(before)
  } finally {
    await resetSession(database)
  }
})

test('a root already beyond the standing bound accepts a later request without changing', async () => {
  await bindReplier(database)
  try {
    const before = await messageState(database, ids.beyond)
    expect(
      await extend(
        database,
        ids.beyond,
        new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString(),
      ),
    ).toBeTrue()
    expect(await messageState(database, ids.beyond)).toEqual(before)
  } finally {
    await resetSession(database)
  }
})
