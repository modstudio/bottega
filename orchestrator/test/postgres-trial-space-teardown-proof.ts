import { expect, test } from 'bun:test'
import { newRecordId, RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { closeRecordPools } from '../src/record/record-pool.ts'
import { deleteTrialRecordSpace } from '../src/record/record-trial-space-delete.ts'
import type { PsqlResult } from './fixtures/postgres-rls.ts'

export function registerTrialSpaceTeardownProof(input: {
  actorUrl: () => string
  admin: (sql: string) => string
  psql: (user: string, password: string, sql: string) => PsqlResult
}): void {
  test('a marked trial space with board activity is deleted and reruns safely', async () => {
    const owner = newRecordId(),
      member = newRecordId(),
      authorMember = newRecordId(),
      foreignOwner = newRecordId(),
      personal = newRecordId(),
      trial = newRecordId(),
      real = newRecordId(),
      dek = newRecordId(),
      project = newRecordId(),
      machine = newRecordId(),
      run = newRecordId(),
      claim = newRecordId(),
      message = newRecordId()
    input.admin(`
      INSERT INTO space(id,name,slug,metadata,created_at) VALUES
        ('${personal}','trial personal','user-${member}',NULL,now()),
        ('${trial}','trial teardown','trial-${trial}',jsonb_build_object('trial',jsonb_build_object('createdByUserId','${owner}','createdAt',now())),now()),
        ('${real}','real membership','real-${real}',NULL,now());
      INSERT INTO "user"(id,email,name,personal_space_id,created_at) VALUES
        ('${owner}','proof-owner-${owner}@example.test','owner',NULL,now()),
        ('${member}','trial-${member}@example.test','trial', '${personal}',now()),
        ('${authorMember}','trial-${authorMember}@example.test','trial author',NULL,now()),
        ('${foreignOwner}','proof-foreign-${foreignOwner}@example.test','foreign owner',NULL,now());
      INSERT INTO membership(id,space_id,user_id,role,permission,config_access,created_at) VALUES
        ('${newRecordId()}','${trial}','${owner}','owner','write',true,now()),
        ('${newRecordId()}','${trial}','${member}','member','write',false,now()),
        ('${newRecordId()}','${trial}','${authorMember}','member','write',false,now()),
        ('${newRecordId()}','${personal}','${member}','owner','write',true,now()),
        ('${newRecordId()}','${real}','${foreignOwner}','owner','write',true,now());
      INSERT INTO project(id,space_id,name,key_prefixes,created_at)
        VALUES ('${project}','${trial}','trial-proof',ARRAY['TP'],now());
      INSERT INTO machine(id,user_id,name,registered_at,last_seen)
        VALUES ('${machine}','${owner}','trial-proof',now(),now());
      INSERT INTO run(id,space_id,project_id,machine_id,started_by_user_id,started_at,agent,job,
        prompt_sha,prompt_bytes,prompt_head,probe,status,turn,no_failover,automatic_failover,
        work_preserved,created_at,updated_at)
        VALUES ('${run}','${trial}','${project}','${machine}','${owner}',now(),'proof','proof',
          'proof',1,'proof',false,'ok',1,false,false,false,now(),now());
      INSERT INTO board_claim(id,project_id,subject_kind,subject_value,holder_user_id,run_id,
        duration_ms,taken_at,renewed_at,lapses_at)
        VALUES ('${claim}','${project}','task','DEV-2063','${owner}','${run}',60000,now(),now(),now()+interval '1 hour');
      INSERT INTO board_message(id,author_user_id,author_run_id,kind,audience,title,body,
        ack_required,expires_at,created_at,scope_project_ids,recipient_user_ids,shared_space_reach,
        thread_root_author_user_id)
        VALUES ('${message}','${authorMember}','${run}','notice','architect','proof','proof',false,
          now()+interval '1 hour',now(),ARRAY[]::uuid[],ARRAY[]::uuid[],false,'${authorMember}');
      INSERT INTO secret_dek(id,space_id,version,created_at) VALUES ('${dek}','${trial}',1,now());
      INSERT INTO config_secret(id,space_id,key,environment,dek_id,row_version,envelope,updated_at)
        VALUES ('${newRecordId()}','${trial}','proof','default','${dek}',1,'\\x00',now());`)
    expect(input.admin(`SELECT record_user_has_real_space_membership('${member}');`)).toBe('f')
    input.admin(`INSERT INTO membership(id,space_id,user_id,role,permission,created_at)
      VALUES ('${newRecordId()}','${real}','${member}','member','write',now());`)
    expect(input.admin(`SELECT record_user_has_real_space_membership('${member}');`)).toBe('t')
    expect(
      input.psql(
        RECORD_ACTOR_ROLE,
        'actor-password',
        `SET app.user_id='${member}'; SET app.space_id='${trial}';
         WITH removed AS (DELETE FROM board_claim WHERE id='${claim}' RETURNING 1)
         SELECT count(*) FROM removed;`,
      ),
    ).toMatchObject({ code: 0, stdout: '0' })
    expect(
      input.psql(
        RECORD_ACTOR_ROLE,
        'actor-password',
        `SET app.user_id='${member}'; SET app.space_id='${trial}';
         WITH removed AS (DELETE FROM board_message WHERE id='${message}' RETURNING 1)
         SELECT count(*) FROM removed;`,
      ),
    ).toMatchObject({ code: 0, stdout: '0' })
    expect(
      input.psql(
        RECORD_ACTOR_ROLE,
        'actor-password',
        `SET app.user_id='${foreignOwner}'; SET app.space_id='${real}';
         WITH removed AS (DELETE FROM board_claim WHERE id='${claim}' RETURNING 1)
         SELECT count(*) FROM removed;`,
      ),
    ).toMatchObject({ code: 0, stdout: '0' })
    expect(
      input.psql(
        RECORD_ACTOR_ROLE,
        'actor-password',
        `SET app.user_id='${foreignOwner}'; SET app.space_id='${real}';
         WITH removed AS (DELETE FROM board_message WHERE id='${message}' RETURNING 1)
         SELECT count(*) FROM removed;`,
      ),
    ).toMatchObject({ code: 0, stdout: '0' })
    input.admin(
      `DELETE FROM membership WHERE space_id='${real}'; DELETE FROM space WHERE id='${real}';`,
    )
    const result = await deleteTrialRecordSpace({
      url: input.actorUrl(),
      slug: `trial-${trial}`,
      userId: owner,
    })
    expect(result.tables.config_secret).toBe(1)
    expect(result.tables.board_claim).toBe(1)
    expect(result.tables.board_message).toBe(1)
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
