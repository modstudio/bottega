import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { migratePostgres } from './postgres-migrate.ts'
import {
  newRecordId,
  PLATFORM_OPERATOR_USER_ID,
  PLATFORM_SPACE_ID,
  PLATFORM_SPACE_NAME,
} from './postgres-schema.ts'
import { syncRecord } from './record-sync.ts'
import { RUN_RECORD_PAYLOAD_COLUMNS } from './run-outbox.ts'

const container = process.env.ORCH_TEST_POSTGRES_CONTAINER
const ownerUrl = process.env.ORCH_TEST_POSTGRES_OWNER_URL
const migrationsFolder = join(import.meta.dir, '..', 'postgres', 'migrations')
const postgresSchema = ['postgres-schema.ts', 'postgres-schema-run.ts']
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
const PROJECT_A = '01990000-0000-7000-8000-00000000001a'
const PROJECT_A2 = '01990000-0000-7000-8000-00000000002a'
const PROJECT_B = '01990000-0000-7000-8000-00000000001b'
const PLATFORM_PROJECT = '01990000-0000-7000-8000-00000000001c'
const MACHINE_A = '01990000-0000-7000-8000-000000000019'
const RUN_A = '01990000-0000-7000-8000-00000000003a'
const RUN_B = '01990000-0000-7000-8000-00000000003b'

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
    for (const table of ['space', 'membership', 'project', 'run', 'seq']) {
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

const realPostgres = container && ownerUrl ? describe : describe.skip
realPostgres('RLS proof against real Postgres', () => {
  beforeAll(async () => {
    const roleSetup = psql(
      'postgres',
      'postgres',
      `
      CREATE ROLE record_owner LOGIN PASSWORD 'owner-password' NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE tenant_actor LOGIN PASSWORD 'tenant-password' NOSUPERUSER NOBYPASSRLS;
      GRANT CREATE ON DATABASE postgres TO record_owner;
      GRANT CREATE ON SCHEMA public TO record_owner;
    `,
    )
    expect(roleSetup.code, roleSetup.stderr).toBe(0)

    await migratePostgres(ownerUrl!)

    succeeds(
      'postgres',
      'postgres',
      `
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tenant_actor;
      INSERT INTO space (id, name, created_at) VALUES
        ('${SPACE_A}', 'space-a', now()), ('${SPACE_B}', 'space-b', now());
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
    `,
    )

    if (process.env.ORCH_TEST_POSTGRES_FALSIFY === 'drop-project-select') {
      const dropped = psql(
        'record_owner',
        'owner-password',
        'DROP POLICY project_space_select ON project;',
      )
      expect(dropped.code, dropped.stderr).toBe(0)
    }
  })

  afterAll(() => {
    if (!container) return
    psql(
      'postgres',
      'postgres',
      `
      DROP TABLE IF EXISTS run, membership, machine, seq, project, "user", space CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      REVOKE CREATE ON DATABASE postgres FROM record_owner;
      REVOKE CREATE ON SCHEMA public FROM record_owner;
      DROP ROLE IF EXISTS tenant_actor;
      DROP ROLE IF EXISTS record_owner;
    `,
    )
  })

  test('proof role neither owns tables nor holds BYPASSRLS', () => {
    const facts = succeeds(
      'postgres',
      'postgres',
      `
      SELECT r.rolsuper, r.rolbypassrls,
        EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'project' AND c.relowner = r.oid)
      FROM pg_roles r WHERE r.rolname = 'tenant_actor';
    `,
    )
    expect(facts).toBe('f|f|f')
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
      'record_owner',
      'owner-password',
      SPACE_A,
      `INSERT INTO seq (space_id, project_id, name, next)
       VALUES ('${SPACE_A}', '${PROJECT_A}', NULL, 1);`,
    )
    expect(inserted.code).not.toBe(0)
    expect(inserted.stderr).toContain('null value in column "name"')
  })

  test('tenant roles cannot read Drizzle migration metadata', () => {
    const result = psql(
      'tenant_actor',
      'tenant-password',
      'SELECT count(*) FROM drizzle.__drizzle_migrations;',
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('permission denied for schema drizzle')
  })

  test('same-space SELECT remains visible', () => {
    const result = asSpace(
      'tenant_actor',
      'tenant-password',
      SPACE_A,
      `SELECT name FROM project WHERE id = '${PROJECT_A}';`,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.split('\n').at(-1)).toBe('alpha')
  })

  test('cross-space SELECT returns nothing', () => {
    const result = asSpace(
      'tenant_actor',
      'tenant-password',
      SPACE_A,
      `SELECT name FROM project WHERE id = '${PROJECT_B}';`,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.split('\n').at(-1)).toBe('')
  })

  test('cross-space run SELECT returns nothing', () => {
    const result = asSpace(
      'tenant_actor',
      'tenant-password',
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
      recordUrl: ownerUrl!,
      local,
      identity: { id: MACHINE_A, name: 'proof-machine' },
      now: () => '2026-09-15T01:01:00.000Z',
    })
    expect(result).toEqual({ pushed: 1, failed: 0, pending: 0, configured: true })
    const read = asSpace(
      'tenant_actor',
      'tenant-password',
      PLATFORM_SPACE_ID,
      `SELECT id FROM run WHERE id='${recordId}';`,
    )
    expect(read.code, read.stderr).toBe(0)
    expect(read.stdout.split('\n').at(-1)).toBe(recordId)
    local.close()
  })

  test('cross-space write is refused', () => {
    const result = asSpace(
      'tenant_actor',
      'tenant-password',
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
      'record_owner',
      'owner-password',
      SPACE_A,
      'SELECT name FROM project ORDER BY name;',
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.split('\n')).toEqual(['alpha', 'alpha-two'])
  })

  test('same prefix is allowed in separate projects', () => {
    const rows = asSpace(
      'tenant_actor',
      'tenant-password',
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
