import { beforeAll, expect, test } from 'bun:test'
import {
  RECORD_ACTOR_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_READER_ROLE,
} from '../../shared/record/schema.ts'
import {
  createDataKey,
  deleteConfigEntry,
  deleteConfigSecret,
  listConfigSecrets,
  machineKeyId,
  putConfigEntry,
  putConfigSecret,
  registerMachineKey,
  retireDataKey,
  revokeMachineKey,
} from '../src/record/record-config.ts'
import { asSpace, asSpaces, succeeds } from './fixtures/postgres-rls.ts'

const USER_B = '01990000-0000-7000-8000-000000000020'
const DEK_A = '01990000-0000-7000-8000-0000000000da'
const DEK_B = '01990000-0000-7000-8000-0000000000db'

type ConfigProofInput = {
  actorUrl: string
  spaceA: string
  spaceB: string
  userA: string
}

export function registerHostedConfigProofs({
  actorUrl,
  spaceA,
  spaceB,
  userA,
}: ConfigProofInput): void {
  const serviceTenant = {
    url: actorUrl,
    spaceId: spaceA,
    spaceIds: [spaceA, spaceB],
    userId: userA,
  }
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
    if (process.env.ORCH_TEST_POSTGRES_FALSIFY === 'grant-config-secret-reader-select') {
      succeeds('postgres', 'postgres', `GRANT SELECT ON config_secret TO ${RECORD_READER_ROLE};`)
    }
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
    const falsifiesReaderGrant =
      process.env.ORCH_TEST_POSTGRES_FALSIFY === 'grant-config-secret-reader-select'
    expect(facts).toBe(`t|t|t|t|f|t|${falsifiesReaderGrant ? 't' : 'f'}|f|f`)
  })

  test('secret actor policies are role-scoped and reader backstops are restrictive', () => {
    const facts = succeeds(
      'postgres',
      'postgres',
      `SELECT tablename,
         count(*) FILTER (WHERE policyname LIKE '%_actor_%'),
         bool_and(roles = ARRAY['${RECORD_ACTOR_ROLE}']::name[])
           FILTER (WHERE policyname LIKE '%_actor_%'),
         count(*) FILTER (
           WHERE policyname LIKE '%_reader_backstop'
             AND permissive = 'RESTRICTIVE'
             AND roles = ARRAY['${RECORD_READER_ROLE}']::name[]
             AND qual = 'false'
         )
       FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename IN ('config_secret', 'secret_dek', 'secret_dek_wrap')
       GROUP BY tablename
       ORDER BY tablename;`,
    )
    expect(facts.split('\n')).toEqual([
      'config_secret|4|t|1',
      'secret_dek|4|t|1',
      'secret_dek_wrap|4|t|1',
    ])
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
      if (
        table === 'config_secret' &&
        process.env.ORCH_TEST_POSTGRES_FALSIFY === 'grant-config-secret-reader-select'
      ) {
        expect(result.code, result.stderr).toBe(0)
        expect(result.stdout).toBe('')
      } else {
        expect(result.code).not.toBe(0)
        expect(result.stderr).toContain('42501')
        expect(result.stderr).toContain(`permission denied for table ${table}`)
      }
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

  test('secret reads use only the active space even with several memberships', () => {
    for (const table of ['config_secret', 'secret_dek', 'secret_dek_wrap']) {
      const result = asSpaces(
        RECORD_ACTOR_ROLE,
        'actor-password',
        spaceA,
        [spaceA, spaceB],
        `SET app.user_id = '${userA}';
         SELECT count(*) FROM ${table} WHERE space_id = '${spaceB}';`,
      )
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toBe('0')
    }
  })

  test('DEK references cannot cross spaces', () => {
    const statements = [
      `INSERT INTO config_secret
         (id, space_id, user_id, key, environment, dek_id, row_version, envelope, updated_at)
       VALUES
         ('01990000-0000-7000-8000-000000000221', '${spaceA}', NULL, 'cross-space',
          'default', '${DEK_B}', 1, decode('05', 'hex'), now());`,
      `INSERT INTO secret_dek_wrap
         (space_id, dek_id, recipient_key_id, sender_key_id, enc, ciphertext, created_at)
       VALUES
         ('${spaceA}', '${DEK_B}', 'EEEEEEEEEEEEEEEEEEEEEE', 'FFFFFFFFFFFFFFFFFFFFFF',
          decode('05', 'hex'), decode('06', 'hex'), now());`,
    ]
    for (const statement of statements) {
      const result = asSpace(
        RECORD_ACTOR_ROLE,
        'actor-password',
        spaceA,
        `\\set VERBOSITY verbose
         SET app.user_id = '${userA}';
         ${statement}`,
      )
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('23503')
    }
  })

  test('wrap identity permits two senders but rejects an exact duplicate', () => {
    const secondSender = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      spaceA,
      `INSERT INTO secret_dek_wrap
         (space_id, dek_id, recipient_key_id, sender_key_id, enc, ciphertext, created_at)
       VALUES
         ('${spaceA}', '${DEK_A}', 'AAAAAAAAAAAAAAAAAAAAAA', 'EEEEEEEEEEEEEEEEEEEEEE',
          decode('05', 'hex'), decode('06', 'hex'), now());
       SELECT count(*) FROM secret_dek_wrap
       WHERE dek_id = '${DEK_A}' AND recipient_key_id = 'AAAAAAAAAAAAAAAAAAAAAA';`,
    )
    expect(secondSender.code, secondSender.stderr).toBe(0)
    expect(secondSender.stdout).toBe('2')

    const duplicate = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      spaceA,
      `\\set VERBOSITY verbose
       INSERT INTO secret_dek_wrap
         (space_id, dek_id, recipient_key_id, sender_key_id, enc, ciphertext, created_at)
       VALUES
         ('${spaceA}', '${DEK_A}', 'AAAAAAAAAAAAAAAAAAAAAA', 'EEEEEEEEEEEEEEEEEEEEEE',
          decode('07', 'hex'), decode('08', 'hex'), now());`,
    )
    expect(duplicate.code).not.toBe(0)
    expect(duplicate.stderr).toContain('23505')
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

      const otherUserDelete = asSpace(
        RECORD_ACTOR_ROLE,
        'actor-password',
        spaceA,
        `SET app.user_id = '${userA}';
         DELETE FROM ${table} WHERE key = 'user-y' RETURNING key;`,
      )
      expect(otherUserDelete.code, otherUserDelete.stderr).toBe(0)
      expect(otherUserDelete.stdout).toBe('')

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

  test('record actor cannot insert another user config row', () => {
    const statements = [
      `INSERT INTO config_entry
         (id, space_id, user_id, key, environment, value, row_version, updated_at)
       VALUES
         ('01990000-0000-7000-8000-000000000231', '${spaceA}', '${USER_B}',
          'forged-user', 'default', 'forged', 1, now());`,
      `INSERT INTO config_secret
         (id, space_id, user_id, key, environment, dek_id, row_version, envelope, updated_at)
       VALUES
         ('01990000-0000-7000-8000-000000000232', '${spaceA}', '${USER_B}',
          'forged-user', 'default', '${DEK_A}', 1, decode('09', 'hex'), now());`,
    ]
    for (const statement of statements) {
      const result = asSpace(
        RECORD_ACTOR_ROLE,
        'actor-password',
        spaceA,
        `\\set VERBOSITY verbose
         SET app.user_id = '${userA}';
         ${statement}`,
      )
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('42501')
      expect(result.stderr).toContain('row-level security policy')
    }
  })

  test('config service lists secret metadata without envelope bytes', async () => {
    const items = await listConfigSecrets(serviceTenant)
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => !('envelope' in item))).toBe(true)
    expect(items.map((item) => item.key)).not.toContain('wide-b')
  })

  test('config service enforces row versions on entry and secret put and delete', async () => {
    const entry = await putConfigEntry({
      ...serviceTenant,
      key: 'service-entry',
      environment: 'test',
      scope: 'user',
      value: 'one',
      expectedRowVersion: null,
    })
    await expect(
      putConfigEntry({
        ...serviceTenant,
        key: entry.key,
        environment: entry.environment,
        scope: entry.scope,
        value: 'two',
        expectedRowVersion: 9,
      }),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      deleteConfigEntry({
        ...serviceTenant,
        key: entry.key,
        environment: entry.environment,
        scope: entry.scope,
        expectedRowVersion: 9,
      }),
    ).rejects.toMatchObject({ status: 409 })

    const secret = await putConfigSecret({
      ...serviceTenant,
      key: 'service-secret',
      environment: 'test',
      scope: 'space',
      dekId: DEK_A,
      envelope: Uint8Array.of(10, 11),
      expectedRowVersion: null,
    })
    await expect(
      putConfigSecret({
        ...serviceTenant,
        key: secret.key,
        environment: secret.environment,
        scope: secret.scope,
        dekId: DEK_A,
        envelope: Uint8Array.of(12),
        expectedRowVersion: 9,
      }),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      deleteConfigSecret({
        ...serviceTenant,
        key: secret.key,
        environment: secret.environment,
        scope: secret.scope,
        expectedRowVersion: 9,
      }),
    ).rejects.toMatchObject({ status: 409 })
  })

  test('config service refuses foreign and retired data keys for secret writes', async () => {
    const attempt = (dekId: string, key: string) =>
      putConfigSecret({
        ...serviceTenant,
        key,
        environment: 'test',
        scope: 'space',
        dekId,
        envelope: Uint8Array.of(1),
        expectedRowVersion: null,
      })
    await expect(attempt(DEK_B, 'foreign-dek')).rejects.toMatchObject({
      status: 422,
    })
    await retireDataKey({ ...serviceTenant, dekId: DEK_A })
    await expect(attempt(DEK_A, 'retired-dek')).rejects.toMatchObject({
      status: 422,
    })
  })

  test('config service refuses a non-consecutive data-key version', async () => {
    await expect(createDataKey({ ...serviceTenant, version: 7, wraps: [] })).rejects.toMatchObject({
      status: 409,
    })
  })

  test('machine registration verifies key ids and revocation atomically removes wraps', async () => {
    const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index)
    const keyId = await machineKeyId(publicKey)
    await expect(
      registerMachineKey({
        ...serviceTenant,
        keyId: 'ZZZZZZZZZZZZZZZZZZZZZZ',
        publicKey,
        label: 'bad',
      }),
    ).rejects.toMatchObject({ status: 422 })
    await registerMachineKey({
      ...serviceTenant,
      keyId,
      publicKey,
      label: 'service machine',
    })
    succeeds(
      'postgres',
      'postgres',
      `INSERT INTO secret_dek_wrap
        (space_id, dek_id, recipient_key_id, sender_key_id, enc, ciphertext, created_at)
       VALUES ('${spaceA}', '${DEK_A}', '${keyId}', 'CCCCCCCCCCCCCCCCCCCCCC',
         decode('10', 'hex'), decode('11', 'hex'), now());`,
    )
    await revokeMachineKey({ ...serviceTenant, keyId })
    const facts = succeeds(
      'postgres',
      'postgres',
      `SELECT revoked_at IS NOT NULL,
         (SELECT count(*) FROM secret_dek_wrap WHERE space_id='${spaceA}' AND recipient_key_id='${keyId}')
       FROM machine_public_key WHERE space_id='${spaceA}' AND key_id='${keyId}';`,
    )
    expect(facts).toBe('t|0')
  })
}
