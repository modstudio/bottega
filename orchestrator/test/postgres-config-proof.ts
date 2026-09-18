import { beforeAll, expect, test } from 'bun:test'
import {
  RECORD_ACTOR_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_READER_ROLE,
} from '../../shared/record/schema.ts'
import { asSpace, succeeds } from './fixtures/postgres-rls.ts'

const USER_B = '01990000-0000-7000-8000-000000000020'
const DEK_A = '01990000-0000-7000-8000-0000000000da'
const DEK_B = '01990000-0000-7000-8000-0000000000db'

type ConfigProofInput = {
  spaceA: string
  spaceB: string
  userA: string
}

export function registerHostedConfigProofs({ spaceA, spaceB, userA }: ConfigProofInput): void {
  beforeAll(() => {
    succeeds(
      'postgres',
      'postgres',
      `INSERT INTO "user" (id, email, name, created_at)
         VALUES ('${USER_B}', 'other@example.test', 'Other', now());
       INSERT INTO secret_dek (id, space_id, version, created_at) VALUES
         ('${DEK_A}', '${spaceA}', 1, now()),
         ('${DEK_B}', '${spaceB}', 1, now());
       INSERT INTO config_entry
         (id, space_id, user_id, key, environment, value, row_version, updated_at)
       VALUES
         ('01990000-0000-7000-8000-000000000201', '${spaceA}', NULL, 'wide', 'default', 'wide-a', 1, now()),
         ('01990000-0000-7000-8000-000000000202', '${spaceA}', '${userA}', 'user-x', 'default', 'x-a', 1, now()),
         ('01990000-0000-7000-8000-000000000203', '${spaceA}', '${USER_B}', 'user-y', 'default', 'y-a', 1, now()),
         ('01990000-0000-7000-8000-000000000204', '${spaceB}', NULL, 'wide', 'default', 'wide-b', 1, now());
       INSERT INTO config_secret
         (id, space_id, user_id, key, environment, dek_id, row_version, envelope, updated_at)
       VALUES
         ('01990000-0000-7000-8000-000000000211', '${spaceA}', NULL, 'wide', 'default', '${DEK_A}', 1, decode('01', 'hex'), now()),
         ('01990000-0000-7000-8000-000000000212', '${spaceA}', '${userA}', 'user-x', 'default', '${DEK_A}', 1, decode('02', 'hex'), now()),
         ('01990000-0000-7000-8000-000000000213', '${spaceA}', '${USER_B}', 'user-y', 'default', '${DEK_A}', 1, decode('03', 'hex'), now()),
         ('01990000-0000-7000-8000-000000000214', '${spaceB}', NULL, 'wide', 'default', '${DEK_B}', 1, decode('04', 'hex'), now());
       INSERT INTO secret_dek_wrap
         (space_id, dek_id, recipient_key_id, sender_key_id, enc, ciphertext, created_at)
       VALUES
         ('${spaceA}', '${DEK_A}', 'AAAAAAAAAAAAAAAAAAAAAA', 'CCCCCCCCCCCCCCCCCCCCCC', decode('01', 'hex'), decode('02', 'hex'), now()),
         ('${spaceB}', '${DEK_B}', 'BBBBBBBBBBBBBBBBBBBBBB', 'DDDDDDDDDDDDDDDDDDDDDD', decode('03', 'hex'), decode('04', 'hex'), now());
       INSERT INTO machine_public_key
         (space_id, key_id, public_key, label, created_at)
       VALUES
         ('${spaceA}', 'AAAAAAAAAAAAAAAAAAAAAA', decode(repeat('00', 32), 'hex'), 'machine-a', now()),
         ('${spaceB}', 'BBBBBBBBBBBBBBBBBBBBBB', decode(repeat('11', 32), 'hex'), 'machine-b', now());`,
    )
  })

  test('record roles are nonsuperuser without BYPASSRLS and only owner owns tables', () => {
    const facts = succeeds(
      'postgres',
      'postgres',
      `SELECT r.rolname, r.rolsuper, r.rolbypassrls,
         EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'project' AND c.relowner = r.oid)
       FROM pg_roles r
       WHERE r.rolname IN ('${RECORD_OWNER_ROLE}', '${RECORD_ACTOR_ROLE}', '${RECORD_READER_ROLE}')
       ORDER BY r.rolname;`,
    )
    expect(facts.split('\n')).toEqual([
      `${RECORD_ACTOR_ROLE}|f|f|f`,
      `${RECORD_OWNER_ROLE}|f|f|t`,
      `${RECORD_READER_ROLE}|f|f|f`,
    ])
  })

  test('hosted secret table grants stay narrow', () => {
    const facts = succeeds(
      'postgres',
      'postgres',
      `SELECT
        has_table_privilege('${RECORD_ACTOR_ROLE}', 'config_secret', 'SELECT'),
        has_table_privilege('${RECORD_ACTOR_ROLE}', 'config_secret', 'DELETE'),
        has_table_privilege('${RECORD_ACTOR_ROLE}', 'secret_dek', 'SELECT'),
        has_table_privilege('${RECORD_ACTOR_ROLE}', 'secret_dek', 'UPDATE'),
        has_table_privilege('${RECORD_ACTOR_ROLE}', 'secret_dek', 'DELETE'),
        has_table_privilege('${RECORD_ACTOR_ROLE}', 'secret_dek_wrap', 'DELETE'),
        has_table_privilege('${RECORD_READER_ROLE}', 'config_secret', 'SELECT'),
        has_table_privilege('${RECORD_READER_ROLE}', 'secret_dek', 'SELECT'),
        has_table_privilege('${RECORD_READER_ROLE}', 'secret_dek_wrap', 'SELECT');`,
    )
    expect(facts).toBe('t|t|t|t|f|t|f|f|f')
  })

  test('record reader gets insufficient privilege for every secret-bearing table', () => {
    for (const table of ['config_secret', 'secret_dek', 'secret_dek_wrap']) {
      const result = asSpace(
        RECORD_READER_ROLE,
        'reader-password',
        spaceA,
        `\\set VERBOSITY verbose
         SELECT * FROM ${table};`,
      )
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('42501')
      expect(result.stderr).toContain(`permission denied for table ${table}`)
    }
  })

  test('record reader can read space-wide config in its own space', () => {
    const result = asSpace(
      RECORD_READER_ROLE,
      'reader-password',
      spaceA,
      'SELECT key, value FROM config_entry ORDER BY key;',
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('wide|wide-a')
  })

  test('record actor cannot see config records from another space', () => {
    for (const table of [
      'config_entry',
      'config_secret',
      'secret_dek',
      'secret_dek_wrap',
      'machine_public_key',
    ]) {
      const result = asSpace(
        RECORD_ACTOR_ROLE,
        'actor-password',
        spaceB,
        `SET app.user_id = '${userA}';
         SELECT count(*) FROM ${table} WHERE space_id = '${spaceA}';`,
      )
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toBe('0')
    }
  })

  test('record actor sees and updates only its user and space-wide config rows', () => {
    for (const table of ['config_entry', 'config_secret']) {
      const visible = asSpace(
        RECORD_ACTOR_ROLE,
        'actor-password',
        spaceA,
        `SET app.user_id = '${userA}';
         SELECT key FROM ${table} ORDER BY key;`,
      )
      expect(visible.code, visible.stderr).toBe(0)
      expect(visible.stdout.split('\n')).toEqual(['user-x', 'wide'])

      const otherUserUpdate = asSpace(
        RECORD_ACTOR_ROLE,
        'actor-password',
        spaceA,
        `SET app.user_id = '${userA}';
         UPDATE ${table} SET row_version = row_version + 1
         WHERE key = 'user-y' RETURNING key;`,
      )
      expect(otherUserUpdate.code, otherUserUpdate.stderr).toBe(0)
      expect(otherUserUpdate.stdout).toBe('')

      const spaceWideUpdate = asSpace(
        RECORD_ACTOR_ROLE,
        'actor-password',
        spaceA,
        `SET app.user_id = '${userA}';
         UPDATE ${table} SET row_version = row_version + 1
         WHERE key = 'wide' RETURNING key;`,
      )
      expect(spaceWideUpdate.code, spaceWideUpdate.stderr).toBe(0)
      expect(spaceWideUpdate.stdout).toBe('wide')
    }
  })
}
