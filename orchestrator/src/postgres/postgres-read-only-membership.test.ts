import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RECORD_ACTOR_ROLE } from '../../../shared/record/schema.ts'
import { asSpace, psql, succeeds } from '../../test/fixtures/postgres-rls.ts'
import { migratePostgres } from './postgres-migrate.ts'

const container = process.env.ORCH_TEST_POSTGRES_CONTAINER
const { ORCH_RECORD_MIGRATE_URL: ownerUrl, ORCH_RECORD_URL: actorUrl } = process.env
const SPACE = '01990000-0000-7000-8000-00000000100a'
const ADMIN_USER = '01990000-0000-7000-8000-000000001010'
const READ_USER = '01990000-0000-7000-8000-000000001013'
const PROJECT = '01990000-0000-7000-8000-00000000101a'

const realPostgres = container && ownerUrl && actorUrl ? describe : describe.skip
realPostgres('read-only membership proof against real Postgres', () => {
  beforeAll(async () => {
    await migratePostgres()
    succeeds(
      'postgres',
      'postgres',
      `
      INSERT INTO space (id, name, slug, created_at)
        VALUES ('${SPACE}', 'membership-policy', 'membership-policy', now());
      INSERT INTO "user" (id, email, name, created_at) VALUES
        ('${ADMIN_USER}', 'membership-admin@example.test', 'Membership admin', now()),
        ('${READ_USER}', 'membership-reader@example.test', 'Membership reader', now());
      INSERT INTO membership (id, space_id, user_id, role, permission, created_at) VALUES
        ('01990000-0000-7000-8000-000000001011', '${SPACE}', '${ADMIN_USER}', 'admin', 'write', now()),
        ('01990000-0000-7000-8000-000000001013', '${SPACE}', '${READ_USER}', 'member', 'read', now());
      INSERT INTO project (id, space_id, name, key_prefixes, created_at)
        VALUES ('${PROJECT}', '${SPACE}', 'membership-policy', ARRAY['POLICY'], now());
    `,
    )
  })

  afterAll(() => {
    succeeds(
      'postgres',
      'postgres',
      `DELETE FROM project WHERE space_id='${SPACE}';
       DELETE FROM membership WHERE space_id='${SPACE}';
       DELETE FROM "user" WHERE id IN ('${ADMIN_USER}', '${READ_USER}');
       DELETE FROM space WHERE id='${SPACE}';`,
    )
  })

  test('read membership can select tenant rows but cannot write project or hub rows', () => {
    // Production break watched: remove the write-membership predicate from tenantPolicies.
    const session = `SET app.space_id='${SPACE}'; SET app.user_id='${READ_USER}';`
    const read = psql(
      RECORD_ACTOR_ROLE,
      'actor-password',
      `${session} SELECT name FROM project WHERE id='${PROJECT}'; SELECT count(*) FROM hub_task;`,
    )
    expect(read.code, read.stderr).toBe(0)
    expect(read.stdout.split('\n')).toEqual(['membership-policy', '0'])
    for (const statement of [
      `INSERT INTO project (id,space_id,name,created_at) VALUES ('01990000-0000-7000-8000-00000000102d','${SPACE}','read-insert',now())`,
      `INSERT INTO hub_task (id,space_id,project_name,key,project,source,first_seen,last_seen,created_at,updated_at) VALUES ('01990000-0000-7000-8000-00000000102e','${SPACE}','membership-policy','POLICY-READ','membership-policy','local',now(),now(),now(),now())`,
    ]) {
      const refused = psql(RECORD_ACTOR_ROLE, 'actor-password', `${session} ${statement};`)
      expect(refused.code).not.toBe(0)
      expect(refused.stderr).toContain('row-level security policy')
    }
    for (const statement of [
      `UPDATE project SET name='read-update' WHERE id='${PROJECT}' RETURNING id`,
      `DELETE FROM project WHERE id='${PROJECT}' RETURNING id`,
    ]) {
      const hidden = psql(RECORD_ACTOR_ROLE, 'actor-password', `${session} ${statement};`)
      expect(hidden.code, hidden.stderr).toBe(0)
      expect(hidden.stdout).toBe('')
    }
  })

  test('write membership can insert, update, and delete tenant rows', () => {
    // Production break watched: make tenantPolicies reject every actor write.
    const result = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      SPACE,
      `INSERT INTO project (id,space_id,name,created_at) VALUES
        ('01990000-0000-7000-8000-00000000102f','${SPACE}','write-member',now());
       UPDATE project SET name='write-member-updated'
        WHERE id='01990000-0000-7000-8000-00000000102f';
       DELETE FROM project WHERE id='01990000-0000-7000-8000-00000000102f';`,
    )
    expect(result.code, result.stderr).toBe(0)
  })

  test('plain member cannot raise permission and admin can change another member', () => {
    // Production break watched: replace record_membership_admin with a same-space check.
    const member = psql(
      RECORD_ACTOR_ROLE,
      'actor-password',
      `SET app.space_id='${SPACE}'; SET app.user_id='${READ_USER}';
       UPDATE membership SET permission='write'
       WHERE space_id='${SPACE}' AND user_id='${READ_USER}';`,
    )
    expect(member.code, member.stderr).toBe(0)
    expect(
      succeeds(
        'postgres',
        'postgres',
        `SELECT permission FROM membership WHERE space_id='${SPACE}' AND user_id='${READ_USER}';`,
      ),
    ).toBe('read')

    const admin = psql(
      RECORD_ACTOR_ROLE,
      'actor-password',
      `SET app.space_id='${SPACE}'; SET app.user_id='${ADMIN_USER}';
       UPDATE membership SET permission='write'
       WHERE space_id='${SPACE}' AND user_id='${READ_USER}';
       UPDATE membership SET permission='read'
       WHERE space_id='${SPACE}' AND user_id='${READ_USER}';`,
    )
    expect(admin.code, admin.stderr).toBe(0)
  })
})
