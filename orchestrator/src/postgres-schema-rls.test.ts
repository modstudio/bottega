import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { db } from './db.ts'
import { migratePostgres } from './postgres-migrate.ts'
import {
  newRecordId,
  PLATFORM_OPERATOR_USER_ID,
  PLATFORM_SPACE_ID,
  PLATFORM_SPACE_NAME,
  RECORD_ACTOR_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_READER_ROLE,
} from './postgres-schema.ts'
import { bearerHeaders, recordAuth } from './record-auth.ts'
import { signInCommand, signUpCommand, whoamiCommand } from './record-auth-command.ts'
import { syncRecord } from './record-sync.ts'
import { RUN_RECORD_PAYLOAD_COLUMNS } from './run-outbox.ts'

const container = process.env.ORCH_TEST_POSTGRES_CONTAINER
const ownerUrl = process.env.ORCH_RECORD_MIGRATE_URL
const actorUrl = process.env.ORCH_RECORD_URL
const migrationsFolder = join(import.meta.dir, '..', 'postgres', 'migrations')
const postgresSchema = [
  'postgres-schema.ts',
  'postgres-schema-auth.ts',
  'postgres-schema-run.ts',
  'postgres-schema-review.ts',
  'postgres-schema-landing.ts',
]
  .map((file) => readFileSync(join(import.meta.dir, file), 'utf8'))
  .join('\n')
const migration = readdirSync(migrationsFolder, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((folder) => existsSync(join(migrationsFolder, folder, 'migration.sql')))
  .sort()
  .map((folder) => readFileSync(join(migrationsFolder, folder, 'migration.sql'), 'utf8'))
  .join('\n')
const SPACE_A = '01990000-0000-7000-8000-00000000000a'
const SPACE_B = '01990000-0000-7000-8000-00000000000b'
const USER_A = '01990000-0000-7000-8000-000000000010'
const AUTH_EMAIL_A = 'auth-a@example.test'
const AUTH_EMAIL_B = 'auth-b@example.test'
const AUTH_EMAIL_REPAIR = 'auth-repair@example.test'
const AUTH_PASSWORD = 'correct-horse-battery-staple'
const PROJECT_A = '01990000-0000-7000-8000-00000000001a'
const PROJECT_A2 = '01990000-0000-7000-8000-00000000002a'
const PROJECT_B = '01990000-0000-7000-8000-00000000001b'
const PLATFORM_PROJECT = '01990000-0000-7000-8000-00000000001c'
const MACHINE_A = '01990000-0000-7000-8000-000000000019'
const RUN_A = '01990000-0000-7000-8000-00000000003a'
const RUN_B = '01990000-0000-7000-8000-00000000003b'
const REVIEW_A = '01990000-0000-7000-8000-00000000004a'
const REVIEW_B = '01990000-0000-7000-8000-00000000004b'

type PsqlResult = { code: number; stdout: string; stderr: string }

function psql(user: string, password: string, source: string): PsqlResult {
  if (!container) throw new Error('ORCH_TEST_POSTGRES_CONTAINER is required')
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      '-e',
      `PGPASSWORD=${password}`,
      container,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      user,
      '-d',
      'postgres',
      '-X',
      '-A',
      '-t',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { stdin: new Blob([source]), stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  }
}

function succeeds(user: string, password: string, source: string): string {
  const result = psql(user, password, source)
  if (result.code !== 0) throw new Error(result.stderr)
  return result.stdout
}

function asSpace(user: string, password: string, spaceId: string, statement: string): PsqlResult {
  return psql(user, password, `SET app.space_id = '${spaceId}';\n${statement}`)
}

describe('Postgres substrate shape', () => {
  test('uses application-minted UUIDv7 ids and declares no id default', () => {
    const generated = newRecordId()
    expect(generated[14]).toBe('7')
    expect(['8', '9', 'a', 'b']).toContain(generated[19]!.toLowerCase())
    expect(migration).not.toMatch(/"id" uuid DEFAULT/i)
  })

  test('seeds the fixed platform space and stand-in operator', () => {
    expect(PLATFORM_SPACE_NAME).toBe(PLATFORM_SLUG)
    expect(migration).toContain(
      `VALUES ('${PLATFORM_SPACE_ID}', '${PLATFORM_SPACE_NAME}', '2026-09-09T00:00:00Z')`,
    )
    expect(migration).toContain(`'${PLATFORM_OPERATOR_USER_ID}'`)
    expect(migration).toContain(`'operator@${PLATFORM_SLUG}.local'`)
    expect(migration.match(/^INSERT INTO /gm)).toHaveLength(3)
  })

  test('tenanted tables force RLS and keep read and write policies separate', () => {
    for (const table of [
      'space',
      'membership',
      'project',
      'run',
      'review',
      'review_lens',
      'review_finding',
      'landing',
      'landing_override',
      'landing_review_carry',
      'contention',
      'test_flake',
      'seq',
      'invitation',
    ]) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)
      expect(migration).toContain(`CREATE POLICY "${table}_space_select"`)
      expect(migration).toContain(`CREATE POLICY "${table}_space_insert"`)
      expect(migration).toContain(`CREATE POLICY "${table}_space_update"`)
      expect(migration).toContain(`CREATE POLICY "${table}_space_delete"`)
    }
  })

  test('every schema-first RLS table is forced in migrations', () => {
    const enabled = new Set(
      [...migration.matchAll(/ALTER TABLE "([^"]+)" ENABLE ROW LEVEL SECURITY/g)].map(
        (match) => match[1],
      ),
    )
    const forced = new Set(
      [...migration.matchAll(/ALTER TABLE "([^"]+)" FORCE ROW LEVEL SECURITY/g)].map(
        (match) => match[1],
      ),
    )
    const withRls = new Set(
      [...postgresSchema.matchAll(/pgTable\.withRLS\(\s*['"]([^'"]+)['"]/g)].map(
        (match) => match[1],
      ),
    )

    expect([...enabled].sort()).toEqual([...forced].sort())
    expect([...withRls].sort()).toEqual([...forced].sort())
  })

  test('machine belongs to a user and seq has the fully qualified key', () => {
    const machineDdl = migration.match(/CREATE TABLE "machine" \([\s\S]*?\n\);/)?.[0]
    expect(machineDdl).toContain('"user_id" uuid NOT NULL')
    expect(machineDdl).not.toContain('"space_id"')
    expect(migration).toContain('PRIMARY KEY("space_id","project_id","name")')
  })
})

const realPostgres = container && ownerUrl && actorUrl ? describe : describe.skip
realPostgres('RLS proof against real Postgres', () => {
  const cliOutput: string[] = []
  let authUserA = ''
  let authUserB = ''
  let authSpaceA = ''
  let authSpaceB = ''
  let repairSpace = ''
  let tokenA = ''
  let tokenB = ''
  const authProjectA = newRecordId()
  const authProjectB = newRecordId()
  const authRunA = newRecordId()
  const authRunB = newRecordId()

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = 'postgres-harness-secret-at-least-thirty-two-characters'
    await migratePostgres()

    succeeds(
      'postgres',
      'postgres',
      `
      INSERT INTO space (id, name, slug, created_at) VALUES
        ('${SPACE_A}', 'space-a', 'space-a', now()), ('${SPACE_B}', 'space-b', 'space-b', now());
      INSERT INTO "user" (id, email, name, created_at)
        VALUES ('${USER_A}', 'owner@example.test', 'Owner', now());
      INSERT INTO membership (id, space_id, user_id, role, permission, created_at)
        VALUES ('01990000-0000-7000-8000-000000000011', '${SPACE_A}', '${USER_A}', 'member', 'write', now());
      INSERT INTO project (id, space_id, name, key_prefixes, created_at) VALUES
        ('${PROJECT_A}', '${SPACE_A}', 'alpha', ARRAY['DEV'], now()),
        ('${PROJECT_A2}', '${SPACE_A}', 'alpha-two', ARRAY['DEV'], now()),
        ('${PROJECT_B}', '${SPACE_B}', 'beta', ARRAY['DEV'], now()),
        ('${PLATFORM_PROJECT}', '${PLATFORM_SPACE_ID}', '${PLATFORM_SLUG}', ARRAY['DEV'], now());
      INSERT INTO machine (id, user_id, name, registered_at, last_seen)
        VALUES ('${MACHINE_A}', '${USER_A}', 'proof-machine', now(), now());
      INSERT INTO run (
        id, space_id, project_id, machine_id, local_id, started_at, agent, job,
        prompt_sha, prompt_bytes, prompt_head, probe, status, turn, no_failover,
        automatic_failover, work_preserved, created_at, updated_at
      ) VALUES
        ('${RUN_A}', '${SPACE_A}', '${PROJECT_A}', '${MACHINE_A}', 1, now(), 'proof', 'proof',
         'a', 1, 'a', false, 'ok', 1, false, false, false, now(), now()),
        ('${RUN_B}', '${SPACE_B}', '${PROJECT_B}', '${MACHINE_A}', 2, now(), 'proof', 'proof',
         'b', 1, 'b', false, 'ok', 1, false, false, false, now(), now());
      INSERT INTO seq (space_id, project_id, name, next) VALUES
        ('${SPACE_A}', '${PROJECT_A}', 'task:DEV', 446),
        ('${SPACE_A}', '${PROJECT_A}', 'dev', 21),
        ('${SPACE_A}', '${PROJECT_A2}', 'task:DEV', 12),
        ('${SPACE_B}', '${PROJECT_B}', 'task:DEV', 9);
      INSERT INTO review
        (id, space_id, project_id, machine_id, local_id, recorded_at, created_at, updated_at)
      VALUES
        ('${REVIEW_A}', '${SPACE_A}', '${PROJECT_A}', '${MACHINE_A}', 1, now(), now(), now()),
        ('${REVIEW_B}', '${SPACE_B}', '${PROJECT_B}', '${MACHINE_A}', 2, now(), now(), now());
      INSERT INTO review_lens
        (id, space_id, review_id, run_id, machine_id, local_id, lens, agent,
         standards_read, files_covered, commands_run, could_not_verify, mcp_tools, docs_read,
         substitutes, created_at, updated_at)
      VALUES
        ('01990000-0000-7000-8000-00000000005a', '${SPACE_A}', '${REVIEW_A}', '${RUN_A}', '${MACHINE_A}', 1,
         'craft', 'proof', '[]', '[]', '[]', '[]', '[]', '[]', '[]', now(), now()),
        ('01990000-0000-7000-8000-00000000005b', '${SPACE_B}', '${REVIEW_B}', '${RUN_B}', '${MACHINE_A}', 2,
         'craft', 'proof', '[]', '[]', '[]', '[]', '[]', '[]', '[]', now(), now());
      INSERT INTO review_finding
        (id, space_id, review_id, review_lens_id, machine_id, local_id, ordinal, severity,
         location, evidence, proposed_correction, created_at, updated_at)
      VALUES
        ('01990000-0000-7000-8000-00000000006a', '${SPACE_A}', '${REVIEW_A}', '01990000-0000-7000-8000-00000000005a', '${MACHINE_A}', 1, 1, 'major', 'a', 'a', 'a', now(), now()),
        ('01990000-0000-7000-8000-00000000006b', '${SPACE_B}', '${REVIEW_B}', '01990000-0000-7000-8000-00000000005b', '${MACHINE_A}', 2, 1, 'major', 'b', 'b', 'b', now(), now());
      INSERT INTO landing
        (id, space_id, project_id, machine_id, local_id, branch, status, started_at, created_at, updated_at)
      VALUES
        ('01990000-0000-7000-8000-00000000007a', '${SPACE_A}', '${PROJECT_A}', '${MACHINE_A}', 1, 'a', 'landed', now(), now(), now()),
        ('01990000-0000-7000-8000-00000000007b', '${SPACE_B}', '${PROJECT_B}', '${MACHINE_A}', 2, 'b', 'landed', now(), now(), now());
      INSERT INTO landing_override
        (id, space_id, project_id, machine_id, local_id, branch, tip, tree, reason, at, created_at, updated_at)
      VALUES
        ('01990000-0000-7000-8000-00000000008a', '${SPACE_A}', '${PROJECT_A}', '${MACHINE_A}', 1, 'a', 'tip', 'tree', 'reason', now(), now(), now()),
        ('01990000-0000-7000-8000-00000000008b', '${SPACE_B}', '${PROJECT_B}', '${MACHINE_A}', 2, 'b', 'tip', 'tree', 'reason', now(), now(), now());
      INSERT INTO landing_review_carry
        (id, space_id, project_id, machine_id, local_id, branch, tip, tree, review_id,
         reviewed_commit, reviewed_tree, patch_id, old_base, new_base, at, created_at, updated_at)
      VALUES
        ('01990000-0000-7000-8000-00000000009a', '${SPACE_A}', '${PROJECT_A}', '${MACHINE_A}', 1, 'a', 'tip', 'tree', '${REVIEW_A}', 'commit', 'tree', 'patch', 'old', 'new', now(), now(), now()),
        ('01990000-0000-7000-8000-00000000009b', '${SPACE_B}', '${PROJECT_B}', '${MACHINE_A}', 2, 'b', 'tip', 'tree', '${REVIEW_B}', 'commit', 'tree', 'patch', 'old', 'new', now(), now(), now());
      INSERT INTO contention
        (id, space_id, machine_id, local_id, at, resource_kind, resource_key, event_kind, created_at, updated_at)
      VALUES
        ('01990000-0000-7000-8000-00000000010a', '${SPACE_A}', '${MACHINE_A}', 1, now(), 'lock', 'a', 'wait', now(), now()),
        ('01990000-0000-7000-8000-00000000010b', '${SPACE_B}', '${MACHINE_A}', 2, now(), 'lock', 'b', 'wait', now(), now());
      INSERT INTO test_flake
        (id, space_id, project_id, machine_id, local_id, test, file, load_at_failure, at, created_at, updated_at)
      VALUES
        ('01990000-0000-7000-8000-00000000011a', '${SPACE_A}', '${PROJECT_A}', '${MACHINE_A}', 1, 'a', 'a.ts', '{}', now(), now(), now()),
        ('01990000-0000-7000-8000-00000000011b', '${SPACE_B}', '${PROJECT_B}', '${MACHINE_A}', 2, 'b', 'b.ts', '{}', now(), now(), now());
    `,
    )

    if (process.env.ORCH_TEST_POSTGRES_FALSIFY === 'revoke-project-select') {
      const revoked = psql(
        RECORD_OWNER_ROLE,
        'owner-password',
        `REVOKE SELECT ON project FROM ${RECORD_ACTOR_ROLE};`,
      )
      expect(revoked.code, revoked.stderr).toBe(0)
    }

    const storedToken = () =>
      db()
        .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='record_session'")
        .get()!.value
    await signUpCommand(AUTH_EMAIL_A, 'Auth A', async () => AUTH_PASSWORD, {
      log: (value) => cliOutput.push(value),
    })
    tokenA = storedToken()
    const first = await recordAuth(actorUrl!).api.getSession({ headers: bearerHeaders(tokenA) })
    if (!first?.session.activeOrganizationId) throw new Error('first signup has no active space')
    authUserA = first.user.id
    authSpaceA = first.session.activeOrganizationId

    await signUpCommand(AUTH_EMAIL_B, 'Auth B', async () => AUTH_PASSWORD, {
      log: (value) => cliOutput.push(value),
    })
    tokenB = storedToken()
    const second = await recordAuth(actorUrl!).api.getSession({ headers: bearerHeaders(tokenB) })
    if (!second?.session.activeOrganizationId) throw new Error('second signup has no active space')
    authUserB = second.user.id
    authSpaceB = second.session.activeOrganizationId

    const repair = await recordAuth(actorUrl!).api.signUpEmail({
      body: { email: AUTH_EMAIL_REPAIR, name: 'Auth Repair', password: AUTH_PASSWORD },
    })
    if (!repair.token) throw new Error('repair signup has no bearer token')
    const repairSession = await recordAuth(actorUrl!).api.getSession({
      headers: bearerHeaders(repair.token),
    })
    if (!repairSession?.session.activeOrganizationId)
      throw new Error('repair signup has no active space')
    repairSpace = repairSession.session.activeOrganizationId

    succeeds(
      'postgres',
      'postgres',
      `INSERT INTO project (id,space_id,name,key_prefixes,created_at) VALUES
        ('${authProjectA}','${authSpaceA}','auth-a-project',ARRAY['AA'],now()),
        ('${authProjectB}','${authSpaceB}','auth-b-project',ARRAY['BB'],now());
       INSERT INTO run (
         id,space_id,project_id,machine_id,local_id,started_at,agent,job,prompt_sha,
         prompt_bytes,prompt_head,probe,status,turn,no_failover,automatic_failover,
         work_preserved,created_at,updated_at
       ) VALUES
        ('${authRunA}','${authSpaceA}','${authProjectA}','${MACHINE_A}',101,now(),'proof','proof','a',1,'a',false,'ok',1,false,false,false,now(),now()),
        ('${authRunB}','${authSpaceB}','${authProjectB}','${MACHINE_A}',102,now(),'proof','proof','b',1,'b',false,'ok',1,false,false,false,now(),now());`,
    )
  })

  afterAll(() => {
    delete process.env.BETTER_AUTH_SECRET
    if (!container) return
    psql(
      'postgres',
      'postgres',
      `
      DROP TABLE IF EXISTS invitation, verification, account, session, test_flake, contention, landing_review_carry, landing_override, landing, review_finding, review_lens, review, run, membership, machine, seq, project, "user", space CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
    `,
    )
  })

  test('CLI sign-up creates one owner membership and bearer identity is not interchangeable', async () => {
    expect(cliOutput).toEqual([`signed up ${AUTH_EMAIL_A}`, `signed up ${AUTH_EMAIL_B}`])
    const facts = succeeds(
      'postgres',
      'postgres',
      `SELECT u.email, count(m.id), min(m.role), min(m.permission)
       FROM "user" u JOIN membership m ON m.user_id=u.id
       WHERE u.id IN ('${authUserA}', '${authUserB}')
       GROUP BY u.email ORDER BY u.email;`,
    )
    expect(facts.split('\n')).toEqual([
      `${AUTH_EMAIL_A}|1|owner|write`,
      `${AUTH_EMAIL_B}|1|owner|write`,
    ])
    const auth = recordAuth(actorUrl!)
    expect((await auth.api.getSession({ headers: bearerHeaders(tokenA) }))?.user.id).toBe(authUserA)
    expect((await auth.api.getSession({ headers: bearerHeaders(tokenB) }))?.user.id).toBe(authUserB)
  })

  test('sign-in repairs a missing personal space before making it active', async () => {
    succeeds(
      'postgres',
      'postgres',
      `DELETE FROM membership WHERE space_id='${repairSpace}';
       DELETE FROM space WHERE id='${repairSpace}';`,
    )
    const output: string[] = []
    await signInCommand(AUTH_EMAIL_REPAIR, async () => AUTH_PASSWORD, {
      log: (value) => output.push(value),
    })
    expect(output).toEqual([`signed in ${AUTH_EMAIL_REPAIR}`])
    const repaired = succeeds(
      'postgres',
      'postgres',
      `SELECT s.id=m.space_id, m.role, m.permission
       FROM "user" u JOIN membership m ON m.user_id=u.id JOIN space s ON s.id=m.space_id
       WHERE u.email='${AUTH_EMAIL_REPAIR}';`,
    )
    expect(repaired).toBe('t|owner|write')
  })

  test('signed-in users see their memberships and spaces but not another space records', () => {
    const visible = psql(
      RECORD_ACTOR_ROLE,
      'actor-password',
      `SET app.user_id='${authUserB}'; SET app.space_id='${authSpaceB}';
       SELECT count(*) FROM membership WHERE user_id='${authUserB}';
       SELECT count(*) FROM space WHERE id='${authSpaceB}';
       SELECT count(*) FROM project WHERE id='${authProjectA}';
       SELECT count(*) FROM run WHERE id='${authRunA}';`,
    )
    expect(visible.code, visible.stderr).toBe(0)
    expect(visible.stdout.split('\n')).toEqual(['1', '1', '0', '0'])
  })

  test('CLI whoami prints the user, active space, and only that user memberships', async () => {
    db()
      .query(
        `INSERT INTO schema_meta (key,value) VALUES ('record_session',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(tokenB)
    const output: string[] = []
    await whoamiCommand({ log: (value) => output.push(value) })
    const shown = JSON.parse(output[0]!) as {
      user: { id: string }
      activeSpaceId: string
      memberships: { space_id: string }[]
    }
    expect(shown.user.id).toBe(authUserB)
    expect(shown.activeSpaceId).toBe(authSpaceB)
    expect(shown.memberships.map((row) => row.space_id)).toEqual([authSpaceB])
  })

  test('record roles are nonsuperuser without BYPASSRLS and only owner owns tables', () => {
    const facts = succeeds(
      'postgres',
      'postgres',
      `
      SELECT r.rolname, r.rolsuper, r.rolbypassrls,
        EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'project' AND c.relowner = r.oid)
      FROM pg_roles r
      WHERE r.rolname IN ('${RECORD_OWNER_ROLE}', '${RECORD_ACTOR_ROLE}', '${RECORD_READER_ROLE}')
      ORDER BY r.rolname;
    `,
    )
    expect(facts.split('\n')).toEqual([
      `${RECORD_ACTOR_ROLE}|f|f|f`,
      `${RECORD_OWNER_ROLE}|f|f|t`,
      `${RECORD_READER_ROLE}|f|f|f`,
    ])
  })

  test('user-scoped table grants stay narrow', () => {
    const facts = succeeds(
      'postgres',
      'postgres',
      `SELECT
        has_table_privilege('${RECORD_ACTOR_ROLE}', 'machine', 'SELECT'),
        has_table_privilege('${RECORD_ACTOR_ROLE}', 'machine', 'INSERT'),
        has_table_privilege('${RECORD_ACTOR_ROLE}', 'machine', 'UPDATE'),
        has_table_privilege('${RECORD_ACTOR_ROLE}', 'machine', 'DELETE'),
        has_table_privilege('${RECORD_ACTOR_ROLE}', '"user"', 'SELECT'),
        has_table_privilege('${RECORD_ACTOR_ROLE}', '"user"', 'INSERT'),
        has_table_privilege('${RECORD_ACTOR_ROLE}', '"user"', 'UPDATE'),
        has_table_privilege('${RECORD_ACTOR_ROLE}', '"user"', 'DELETE'),
        has_table_privilege('${RECORD_READER_ROLE}', 'machine', 'SELECT'),
        has_table_privilege('${RECORD_READER_ROLE}', '"user"', 'SELECT');`,
    )
    expect(facts).toBe('t|t|t|f|t|t|t|f|t|t')
  })

  test('the seq primary key columns are not nullable', () => {
    const columns = succeeds(
      'postgres',
      'postgres',
      `
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'seq'
        AND column_name IN ('space_id', 'project_id', 'name')
      ORDER BY ordinal_position;
    `,
    )
    expect(columns.split('\n')).toEqual(['space_id|NO', 'project_id|NO', 'name|NO'])

    const inserted = asSpace(
      RECORD_OWNER_ROLE,
      'owner-password',
      SPACE_A,
      `INSERT INTO seq (space_id, project_id, name, next)
       VALUES ('${SPACE_A}', '${PROJECT_A}', NULL, 1);`,
    )
    expect(inserted.code).not.toBe(0)
    expect(inserted.stderr).toContain('null value in column "name"')
  })

  test('record actor cannot create tables', () => {
    const result = psql(RECORD_ACTOR_ROLE, 'actor-password', 'CREATE TABLE actor_table (id int);')
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('permission denied for schema public')
  })

  test('record actor cannot read Drizzle migration metadata', () => {
    const result = psql(
      RECORD_ACTOR_ROLE,
      'actor-password',
      'SELECT count(*) FROM drizzle.__drizzle_migrations;',
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('permission denied for schema drizzle')
  })

  test('PUBLIC has no table privilege', () => {
    expect(
      succeeds(
        'postgres',
        'postgres',
        `SELECT has_table_privilege('public_probe', 'project', 'SELECT');`,
      ),
    ).toBe('f')
    const result = asSpace(
      'public_probe',
      'public-password',
      SPACE_A,
      `SELECT name FROM public.project WHERE id = '${PROJECT_A}';`,
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('permission denied for schema public')
  })

  test('record reader can read its space and cannot insert', () => {
    const read = asSpace(
      RECORD_READER_ROLE,
      'reader-password',
      SPACE_A,
      `SELECT name FROM project WHERE id = '${PROJECT_A}';`,
    )
    expect(read.code, read.stderr).toBe(0)
    expect(read.stdout).toBe('alpha')

    const write = asSpace(
      RECORD_READER_ROLE,
      'reader-password',
      SPACE_A,
      `INSERT INTO project (id, space_id, name, created_at)
       VALUES ('01990000-0000-7000-8000-00000000002c', '${SPACE_A}', 'reader-write', now());`,
    )
    expect(write.code).not.toBe(0)
    expect(write.stderr).toContain('permission denied for table project')
  })

  test('tables created later inherit actor and reader grants', () => {
    succeeds(
      RECORD_OWNER_ROLE,
      'owner-password',
      'CREATE TABLE grant_inheritance_probe (id int); INSERT INTO grant_inheritance_probe VALUES (1);',
    )
    const actor = psql(
      RECORD_ACTOR_ROLE,
      'actor-password',
      'SELECT id FROM grant_inheritance_probe;',
    )
    expect(actor.code, actor.stderr).toBe(0)
    expect(actor.stdout).toBe('1')
    const reader = psql(
      RECORD_READER_ROLE,
      'reader-password',
      'SELECT id FROM grant_inheritance_probe;',
    )
    expect(reader.code, reader.stderr).toBe(0)
    expect(reader.stdout).toBe('1')
    succeeds(RECORD_OWNER_ROLE, 'owner-password', 'DROP TABLE grant_inheritance_probe;')
  })

  test('same-space SELECT remains visible', () => {
    const result = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      SPACE_A,
      `SELECT name FROM project WHERE id = '${PROJECT_A}';`,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.split('\n').at(-1)).toBe('alpha')
  })

  test('cross-space SELECT returns nothing', () => {
    const result = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      SPACE_A,
      `SELECT name FROM project WHERE id = '${PROJECT_B}';`,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.split('\n').at(-1)).toBe('')
  })

  test('cross-space review graph reads return nothing', () => {
    for (const [table, id] of [
      ['review', REVIEW_B],
      ['review_lens', '01990000-0000-7000-8000-00000000005b'],
      ['review_finding', '01990000-0000-7000-8000-00000000006b'],
    ]) {
      const result = asSpace(
        RECORD_ACTOR_ROLE,
        'actor-password',
        SPACE_A,
        `SELECT id FROM ${table} WHERE id = '${id}';`,
      )
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toBe('')
    }
  })

  test('cross-space landing evidence reads return nothing', () => {
    for (const [table, id] of [
      ['landing', '01990000-0000-7000-8000-00000000007b'],
      ['landing_override', '01990000-0000-7000-8000-00000000008b'],
      ['landing_review_carry', '01990000-0000-7000-8000-00000000009b'],
      ['contention', '01990000-0000-7000-8000-00000000010b'],
      ['test_flake', '01990000-0000-7000-8000-00000000011b'],
    ]) {
      const result = asSpace(
        RECORD_ACTOR_ROLE,
        'actor-password',
        SPACE_A,
        `SELECT id FROM ${table} WHERE id = '${id}';`,
      )
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toBe('')
    }
  })

  test('cross-space run SELECT returns nothing', () => {
    const result = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      SPACE_A,
      `SELECT id FROM run WHERE id = '${RUN_B}';`,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.split('\n').at(-1)).toBe('')
  })

  test('sync round trip writes a run readable by the tenant role', async () => {
    const local = new Database(':memory:')
    local.exec(`CREATE TABLE outbox (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL,
      created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT
    )`)
    const values = Object.fromEntries(RUN_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]))
    const recordId = newRecordId()
    Object.assign(values, {
      id: recordId,
      spaceId: PLATFORM_SPACE_ID,
      projectName: PLATFORM_SLUG,
      machineId: MACHINE_A,
      localId: 99,
      startedAt: '2026-09-15T01:00:00.000Z',
      finishedAt: '2026-09-15T01:01:00.000Z',
      agent: 'codex',
      job: 'probe',
      promptSha: 'prompt',
      promptBytes: 6,
      promptHead: 'prompt',
      probe: true,
      status: 'ok',
      turn: 1,
      noFailover: false,
      automaticFailover: false,
      workPreserved: false,
      createdAt: '2026-09-15T01:00:00.000Z',
      updatedAt: '2026-09-15T01:01:00.000Z',
    })
    local
      .query(
        `INSERT INTO outbox (id, kind, record_id, payload, created_at)
         VALUES (1, 'run', ?, ?, ?)`,
      )
      .run(recordId, JSON.stringify(values), String(values.createdAt))
    const result = await syncRecord({
      recordUrl: actorUrl!,
      local,
      identity: { id: MACHINE_A, name: 'proof-machine' },
      principal: { userId: PLATFORM_OPERATOR_USER_ID, spaceId: PLATFORM_SPACE_ID },
      now: () => '2026-09-15T01:01:00.000Z',
    })
    expect(result).toEqual({ pushed: 1, failed: 0, pending: 0, configured: true })
    const read = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      PLATFORM_SPACE_ID,
      `SELECT id FROM run WHERE id='${recordId}';`,
    )
    expect(read.code, read.stderr).toBe(0)
    expect(read.stdout.split('\n').at(-1)).toBe(recordId)

    await expect(
      syncRecord({
        recordUrl: ownerUrl!,
        local,
        identity: { id: MACHINE_A, name: 'proof-machine' },
        principal: { userId: PLATFORM_OPERATOR_USER_ID, spaceId: PLATFORM_SPACE_ID },
      }),
    ).rejects.toThrow(
      `record sync refuses ${RECORD_OWNER_ROLE} credentials; set ORCH_RECORD_URL to the ${RECORD_ACTOR_ROLE} connection`,
    )
    local.close()
  })

  test('cross-space write is refused', () => {
    const result = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      SPACE_A,
      `
      INSERT INTO project (id, space_id, name, created_at)
      VALUES ('01990000-0000-7000-8000-00000000002b', '${SPACE_B}', 'intruder', now());
    `,
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('violates row-level security policy')
  })

  test('the table owner is still confined by FORCE ROW LEVEL SECURITY', () => {
    const result = asSpace(
      RECORD_OWNER_ROLE,
      'owner-password',
      SPACE_A,
      'SELECT name FROM project ORDER BY name;',
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.split('\n')).toEqual(['alpha', 'alpha-two'])
  })

  test('same prefix is allowed in separate projects', () => {
    const rows = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      SPACE_A,
      'SELECT project_id, name, next FROM seq ORDER BY next;',
    )
    expect(rows.code, rows.stderr).toBe(0)
    expect(rows.stdout.split('\n')).toEqual([
      `${PROJECT_A2}|task:DEV|12`,
      `${PROJECT_A}|dev|21`,
      `${PROJECT_A}|task:DEV|446`,
    ])
  })
})
