import { expect, test } from 'bun:test'
import {
  newRecordId,
  RECORD_ACTOR_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_READER_ROLE,
} from '../../shared/record/schema.ts'
import { asSpace, psql, succeeds } from './fixtures/postgres-rls.ts'
import * as ids from './postgres-rls-values.ts'

export function registerRecordGrantProofs(): void {
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
      ids.SPACE_A,
      `INSERT INTO seq (id, space_id, project_id, name, next)
       VALUES ('${newRecordId()}', '${ids.SPACE_A}', '${ids.PROJECT_A}', NULL, 1);`,
    )
    expect(inserted.code).not.toBe(0)
    expect(inserted.stderr).toContain('null value in column "name"')
  })

  test('record actor cannot create tables', () => {
    const result = psql(RECORD_ACTOR_ROLE, 'actor-password', 'CREATE TABLE actor_table (id int);')
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('permission denied for schema public')
  })

  test('record actor can only read Drizzle migration metadata', () => {
    const result = succeeds(
      RECORD_ACTOR_ROLE,
      'actor-password',
      `SELECT count(*), has_table_privilege(current_user, 'drizzle.__drizzle_migrations', 'SELECT'), has_table_privilege(current_user, 'drizzle.__drizzle_migrations', 'INSERT'), has_table_privilege(current_user, 'drizzle.__drizzle_migrations', 'UPDATE'), has_table_privilege(current_user, 'drizzle.__drizzle_migrations', 'DELETE') FROM drizzle.__drizzle_migrations;`,
    )
    expect(result).toMatch(/^\d+\|t\|f\|f\|f$/)
  })

  test('PUBLIC has no table privilege', () => {
    expect(
      succeeds(
        'postgres',
        'postgres',
        `SELECT has_table_privilege('public_probe', 'project', 'SELECT');`,
      ),
    ).toBe('f')
    const result = psql(
      'public_probe',
      'public-password',
      `SET app.space_id='${ids.SPACE_A}';SELECT name FROM public.project WHERE id='${ids.PROJECT_A}';`,
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('permission denied for schema public')
  })

  test('record reader can read its space and cannot insert', () => {
    const read = asSpace(
      RECORD_READER_ROLE,
      'reader-password',
      ids.SPACE_A,
      `SELECT name FROM project WHERE id = '${ids.PROJECT_A}';`,
    )
    expect(read.code, read.stderr).toBe(0)
    expect(read.stdout).toBe('alpha')

    const write = asSpace(
      RECORD_READER_ROLE,
      'reader-password',
      ids.SPACE_A,
      `INSERT INTO project (id, space_id, name, created_at)
       VALUES ('01990000-0000-7000-8000-00000000002c', '${ids.SPACE_A}', 'reader-write', now());`,
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
}
