import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { closeRecordPools } from '../src/record/record-pool.ts'
import { deleteTrialRecordSpace } from '../src/record/record-trial-space-delete.ts'

export function registerTrialSpaceTeardownProof(input: {
  actorUrl: () => string
  admin: (sql: string) => string
}): void {
  test('a marked trial space with a config secret is deleted and reruns safely', async () => {
    const owner = newRecordId(),
      member = newRecordId(),
      personal = newRecordId(),
      trial = newRecordId(),
      real = newRecordId(),
      dek = newRecordId()
    input.admin(`
      INSERT INTO space(id,name,slug,metadata,created_at) VALUES
        ('${personal}','trial personal','user-${member}',NULL,now()),
        ('${trial}','trial teardown','trial-${trial}',jsonb_build_object('trial',jsonb_build_object('createdByUserId','${owner}','createdAt',now())),now()),
        ('${real}','real membership','real-${real}',NULL,now());
      INSERT INTO "user"(id,email,name,personal_space_id,created_at) VALUES
        ('${owner}','proof-owner-${owner}@example.test','owner',NULL,now()),
        ('${member}','trial-${member}@example.test','trial', '${personal}',now());
      INSERT INTO membership(id,space_id,user_id,role,permission,config_access,created_at) VALUES
        ('${newRecordId()}','${trial}','${owner}','owner','write',true,now()),
        ('${newRecordId()}','${trial}','${member}','member','write',false,now()),
        ('${newRecordId()}','${personal}','${member}','owner','write',true,now());
      INSERT INTO secret_dek(id,space_id,version,created_at) VALUES ('${dek}','${trial}',1,now());
      INSERT INTO config_secret(id,space_id,key,environment,dek_id,row_version,envelope,updated_at)
        VALUES ('${newRecordId()}','${trial}','proof','default','${dek}',1,'\\x00',now());`)
    expect(input.admin(`SELECT record_user_has_real_space_membership('${member}');`)).toBe('f')
    input.admin(
      `INSERT INTO membership(id,space_id,user_id,role,permission,created_at) VALUES ('${newRecordId()}','${real}','${member}','member','write',now());`,
    )
    expect(input.admin(`SELECT record_user_has_real_space_membership('${member}');`)).toBe('t')
    input.admin(
      `DELETE FROM membership WHERE space_id='${real}' AND user_id='${member}'; DELETE FROM space WHERE id='${real}';`,
    )
    const result = await deleteTrialRecordSpace({
      url: input.actorUrl(),
      slug: `trial-${trial}`,
      userId: owner,
    })
    expect(result.tables.config_secret).toBe(1)
    expect(result.tables.space).toBe(1)
    expect(
      await deleteTrialRecordSpace({
        url: input.actorUrl(),
        slug: `trial-${trial}`,
        userId: owner,
      }),
    ).toMatchObject({ nothingToRemove: true })
    await closeRecordPools()
  })
}
