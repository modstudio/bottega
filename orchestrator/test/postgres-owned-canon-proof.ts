import { expect, test } from 'bun:test'
import { newRecordId, RECORD_ACTOR_ROLE, RECORD_OWNER_ROLE } from '../../shared/record/schema.ts'
import { asSpace, psql, succeeds } from './fixtures/postgres-rls.ts'

export function registerOwnedCanonPrivacyProof(
  authIds: () => { spaceId: string; ownerUserId: string; otherUserId: string },
  subjectFixture: readonly [
    fixtureSpaceId: string,
    otherSpaceId: string,
    projectId: string,
    otherProjectId: string,
  ],
): void {
  const [fixtureSpaceId, otherSpaceId, projectId, otherProjectId] = subjectFixture
  test('another user in the same space cannot read owned canon', () => {
    const { spaceId, ownerUserId, otherUserId } = authIds()
    const ownedDoc = newRecordId()
    const membership = newRecordId()
    succeeds(
      'postgres',
      'postgres',
      `INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
       VALUES ('${membership}','${spaceId}','${otherUserId}','member','write',now());
       INSERT INTO doc
         (id,space_id,scope,subject,owner_user_id,slug,title,body,delivery,audiences,created_at,updated_at)
       VALUES
         ('${ownedDoc}','${spaceId}','canon',NULL,'${ownerUserId}','AGENTS.md','private','private','demand',ARRAY['technical'],now(),now());`,
    )
    const visible = psql(
      RECORD_ACTOR_ROLE,
      'actor-password',
      `SET app.user_id='${otherUserId}'; SET app.space_id='${spaceId}';
       SELECT count(*) FROM doc WHERE id='${ownedDoc}';`,
    )
    expect(visible.code, visible.stderr).toBe(0)
    expect(visible.stdout).toBe('0')
    succeeds(
      'postgres',
      'postgres',
      `DELETE FROM doc WHERE id='${ownedDoc}'; DELETE FROM membership WHERE id='${membership}';`,
    )
  })

  test('the table owner is still confined by FORCE ROW LEVEL SECURITY', () => {
    const result = asSpace(
      RECORD_OWNER_ROLE,
      'owner-password',
      fixtureSpaceId,
      'SELECT name FROM project ORDER BY name;',
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.split('\n')).toEqual(['alpha', 'alpha-two'])
  })

  test('subjects are tenant-confined and cannot reference another space project', () => {
    const subjectId = newRecordId()
    const inserted = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      fixtureSpaceId,
      `INSERT INTO subject
         (id,space_id,project_id,name,definition,position,created_at,updated_at)
       VALUES ('${subjectId}','${fixtureSpaceId}','${projectId}',
         'tenant proof','Tenant proof.',0,now(),now());`,
    )
    expect(inserted.code, inserted.stderr).toBe(0)
    const hidden = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      otherSpaceId,
      `SELECT count(*) FROM subject WHERE id='${subjectId}';`,
    )
    expect(hidden.code, hidden.stderr).toBe(0)
    expect(hidden.stdout).toBe('0')
    const crossed = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      fixtureSpaceId,
      `INSERT INTO subject
         (id,space_id,project_id,name,definition,position,created_at,updated_at)
       VALUES ('${newRecordId()}','${fixtureSpaceId}','${otherProjectId}',
         'cross tenant','Must fail.',1,now(),now());`,
    )
    expect(crossed.code).not.toBe(0)
    succeeds('postgres', 'postgres', `DELETE FROM subject WHERE id='${subjectId}';`)
  })
}
