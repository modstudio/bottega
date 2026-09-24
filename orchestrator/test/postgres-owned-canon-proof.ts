import { expect, test } from 'bun:test'
import { newRecordId, RECORD_ACTOR_ROLE, RECORD_OWNER_ROLE } from '../../shared/record/schema.ts'
import { asSpace, psql, succeeds } from './fixtures/postgres-rls.ts'

export function registerOwnedCanonPrivacyProof(
  spaceId: string,
  ownerUserId: string,
  otherUserId: string,
  fixtureSpaceId: string,
): void {
  test('another user in the same space cannot read owned canon', () => {
    const ownedDoc = newRecordId()
    const membership = newRecordId()
    succeeds(
      'postgres',
      'postgres',
      `INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
       VALUES ('${membership}','${spaceId}','${otherUserId}','member','write',now());
       INSERT INTO doc
         (id,space_id,scope,subject,owner_user_id,slug,title,body,delivery,created_at,updated_at)
       VALUES
         ('${ownedDoc}','${spaceId}','canon',NULL,'${ownerUserId}','AGENTS.md','private','private','demand',now(),now());`,
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
}
