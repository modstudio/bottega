import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId, PLATFORM_SPACE_ID, PLATFORM_SPACE_NAME } from './postgres-schema.ts'

const container = process.env.ORCH_TEST_POSTGRES_CONTAINER
const migration = readFileSync(
  join(import.meta.dir, '..', 'postgres', 'migrations', '0000_substrate.sql'),
  'utf8',
)
const SPACE_A = '01990000-0000-7000-8000-00000000000a'
const SPACE_B = '01990000-0000-7000-8000-00000000000b'
const USER_A = '01990000-0000-7000-8000-000000000010'
const PROJECT_A = '01990000-0000-7000-8000-00000000001a'
const PROJECT_A2 = '01990000-0000-7000-8000-00000000002a'
const PROJECT_B = '01990000-0000-7000-8000-00000000001b'

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

  test('seeds only the fixed platform space', () => {
    expect(PLATFORM_SPACE_NAME).toBe(PLATFORM_SLUG)
    expect(migration).toContain(
      `VALUES ('${PLATFORM_SPACE_ID}', '${PLATFORM_SPACE_NAME}', '2026-09-09T00:00:00Z')`,
    )
    expect(migration.match(/^INSERT INTO /gm)).toHaveLength(1)
  })

  test('tenanted tables force RLS and keep read and write policies separate', () => {
    for (const table of ['space', 'membership', 'project', 'seq']) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)
      expect(migration).toContain(`CREATE POLICY "${table}_space_select"`)
      expect(migration).toContain(`CREATE POLICY "${table}_space_insert"`)
      expect(migration).toContain(`CREATE POLICY "${table}_space_update"`)
      expect(migration).toContain(`CREATE POLICY "${table}_space_delete"`)
    }
  })

  test('machine belongs to a user and seq has the fully qualified key', () => {
    const machineDdl = migration.match(/CREATE TABLE "machine" \([\s\S]*?\n\);/)?.[0]
    expect(machineDdl).toContain('"user_id" uuid NOT NULL')
    expect(machineDdl).not.toContain('"space_id"')
    expect(migration).toContain('PRIMARY KEY("space_id","project_id","name")')
  })
})

const realPostgres = container ? describe : describe.skip
realPostgres('RLS proof against real Postgres', () => {
  beforeAll(() => {
    const roleSetup = psql(
      'postgres',
      'postgres',
      `
      CREATE ROLE record_owner LOGIN PASSWORD 'owner-password' NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE tenant_actor LOGIN PASSWORD 'tenant-password' NOSUPERUSER NOBYPASSRLS;
      GRANT CREATE ON SCHEMA public TO record_owner;
    `,
    )
    expect(roleSetup.code, roleSetup.stderr).toBe(0)

    const applied = psql('record_owner', 'owner-password', migration)
    expect(applied.code, applied.stderr).toBe(0)

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
        ('${PROJECT_B}', '${SPACE_B}', 'beta', ARRAY['DEV'], now());
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
      DROP TABLE IF EXISTS membership, machine, seq, project, "user", space CASCADE;
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
