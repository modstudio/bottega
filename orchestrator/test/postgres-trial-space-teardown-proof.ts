import { expect, test } from 'bun:test'
import { newRecordId, RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { bearerHeaders } from '../src/record/record-auth.ts'
import { closeRecordPools } from '../src/record/record-pool.ts'
import { deleteTrialRecordSpace } from '../src/record/record-trial-space-delete.ts'
import type { PsqlResult } from './fixtures/postgres-rls.ts'
import { testRecordAuth } from './fixtures/record-auth-postgres.ts'

export function registerTrialSpaceTeardownProof(input: {
  actorUrl: () => string
  authUrl: () => string
  token: () => string
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
      message = newRecordId(),
      permissionClaim = newRecordId(),
      permissionMessage = newRecordId(),
      hiddenTrial = newRecordId(),
      session = newRecordId(),
      publicKey = newRecordId()
    input.admin(`
      INSERT INTO space(id,name,slug,metadata,created_at) VALUES
        ('${personal}','trial personal','user-${member}',NULL,now()),
        ('${trial}','trial teardown','trial-${trial}',jsonb_build_object('trial',jsonb_build_object('createdByUserId','${owner}','createdAt',now())),now()),
        ('${real}','real membership','real-${real}',jsonb_build_object('trial',NULL),now()),
        ('${hiddenTrial}','hidden trial','trial-${hiddenTrial}',jsonb_build_object('trial',jsonb_build_object('createdByUserId','${foreignOwner}','createdAt',now())),now());
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
        ('${newRecordId()}','${real}','${foreignOwner}','owner','write',true,now()),
        ('${newRecordId()}','${hiddenTrial}','${foreignOwner}','owner','write',true,now());
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
        VALUES
          ('${claim}','${project}','task','DEV-2063','${owner}','${run}',60000,now(),now(),now()+interval '1 hour'),
          ('${permissionClaim}','${project}','task','DEV-2063-permission','${owner}','${run}',60000,now(),now(),now()+interval '1 hour');
      INSERT INTO board_message(id,author_user_id,author_run_id,kind,audience,title,body,
        ack_required,expires_at,created_at,scope_project_ids,recipient_user_ids,shared_space_reach,
        thread_root_author_user_id)
        VALUES
          ('${message}','${authorMember}','${run}','notice','architect','proof','proof',false,
            now()+interval '1 hour',now(),ARRAY[]::uuid[],ARRAY[]::uuid[],false,'${authorMember}'),
          ('${permissionMessage}','${authorMember}','${run}','notice','architect','permission','proof',false,
            now()+interval '1 hour',now(),ARRAY[]::uuid[],ARRAY[]::uuid[],false,'${authorMember}');
      INSERT INTO session(id,user_id,token,expires_at,active_space_id,created_at,updated_at)
        VALUES ('${session}','${member}','trial-session-${session}',now()+interval '1 hour','${trial}',now(),now());
      INSERT INTO machine_public_key(id,space_id,user_id,key_id,public_key,label,created_at)
        VALUES ('${publicKey}','${trial}','${member}','abcdefghijklmnopqrstuv',decode(repeat('00',32),'hex'),'proof',now());
      INSERT INTO secret_dek(id,space_id,version,created_at) VALUES ('${dek}','${trial}',1,now());
      INSERT INTO config_secret(id,space_id,key,environment,dek_id,row_version,envelope,updated_at)
        VALUES ('${newRecordId()}','${trial}','proof','default','${dek}',1,'\\x00',now());`)
    expect(input.admin(`SELECT record_user_has_real_space_membership('${member}');`)).toBe('f')
    input.admin(`INSERT INTO membership(id,space_id,user_id,role,permission,created_at)
      VALUES ('${newRecordId()}','${real}','${member}','member','write',now());`)
    expect(input.admin(`SELECT record_user_has_real_space_membership('${member}');`)).toBe('t')
    await expect(
      deleteTrialRecordSpace({
        url: input.actorUrl(),
        slug: `trial-${trial}`,
        userId: owner,
        activeSpaceId: trial,
      }),
    ).rejects.toThrow('trial-member-spaces guard failed')
    expect(
      input.psql(
        RECORD_ACTOR_ROLE,
        'actor-password',
        `SET app.user_id='${member}'; SET app.space_id='${trial}';
         WITH removed AS (DELETE FROM board_claim WHERE id='${permissionClaim}' RETURNING 1)
         SELECT count(*) FROM removed;`,
      ),
    ).toMatchObject({ code: 0, stdout: '0' })
    expect(
      input.psql(
        RECORD_ACTOR_ROLE,
        'actor-password',
        `SET app.user_id='${member}'; SET app.space_id='${trial}';
         WITH removed AS (DELETE FROM board_message WHERE id='${permissionMessage}' RETURNING 1)
         SELECT count(*) FROM removed;`,
      ),
    ).toMatchObject({ code: 0, stdout: '0' })
    expect(
      input.psql(
        RECORD_ACTOR_ROLE,
        'actor-password',
        `SET app.user_id='${owner}'; SET app.space_id='${trial}';
         WITH removed AS (DELETE FROM board_claim WHERE id='${permissionClaim}' RETURNING 1)
         SELECT count(*) FROM removed;`,
      ),
    ).toMatchObject({ code: 0, stdout: '1' })
    expect(
      input.psql(
        RECORD_ACTOR_ROLE,
        'actor-password',
        `SET app.user_id='${owner}'; SET app.space_id='${trial}';
         WITH removed AS (DELETE FROM board_message WHERE id='${permissionMessage}' RETURNING 1)
         SELECT count(*) FROM removed;`,
      ),
    ).toMatchObject({ code: 0, stdout: '1' })
    expect(
      await deleteTrialRecordSpace({
        url: input.actorUrl(),
        slug: `trial-${hiddenTrial}`,
        userId: owner,
        activeSpaceId: trial,
      }),
    ).toEqual({ nothingToRemove: true, activeSpaceCleared: false, tables: {}, neutralized: [] })
    input.admin(`DELETE FROM membership WHERE space_id='${real}' AND user_id='${member}';`)
    const result = await deleteTrialRecordSpace({
      url: input.actorUrl(),
      slug: `trial-${trial}`,
      userId: owner,
      activeSpaceId: trial,
    })
    expect(result.tables.config_secret).toBe(1)
    expect(result.tables.board_claim).toBe(1)
    expect(result.tables.board_message).toBe(1)
    expect(result.tables.space).toBe(1)
    expect(result.tables.membership).toBe(3)
    expect(result.activeSpaceCleared).toBe(true)
    expect(result.neutralized).toEqual(
      [
        { userId: member, email: `trial-${member}@example.test`, sessions: 1, machineKeys: 1 },
        {
          userId: authorMember,
          email: `trial-${authorMember}@example.test`,
          sessions: 0,
          machineKeys: 0,
        },
      ].sort((left, right) => left.email.localeCompare(right.email)),
    )
    expect(
      await deleteTrialRecordSpace({
        url: input.actorUrl(),
        slug: `trial-${trial}`,
        userId: owner,
        activeSpaceId: trial,
      }),
    ).toMatchObject({ nothingToRemove: true })
    await closeRecordPools()
  })

  test('the trial-membership definer has only its declared execute privilege', () => {
    expect(
      input.psql(
        RECORD_ACTOR_ROLE,
        'actor-password',
        `SELECT record_user_has_real_space_membership('${newRecordId()}');`,
      ),
    ).toMatchObject({ code: 0, stdout: 'f' })
    expect(
      input.admin(`SELECT count(*) FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
        CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
        WHERE n.nspname='public' AND p.proname='record_user_has_real_space_membership'
          AND a.grantee=0 AND a.privilege_type='EXECUTE';`),
    ).toBe('0')
    const allowedDefiners = [
      'board_message_advance_receipt_revision',
      'board_message_extend_thread_expiry',
      'board_message_set_hidden',
      'contention_prune',
      'hub_change_prune',
      'hub_note_set_hidden',
      'hub_report_delivery_candidates',
      'invitation_open_for',
      'outside_intake_for_project',
      'project_is_outside_intake',
      'record_applied_migration_count',
      'record_board_author_shares_space',
      'record_change_prune',
      'record_config_access_stranded_dek_versions',
      'record_membership_admin',
      'record_move_project_space',
      'record_user_has_real_space_membership',
      'record_uuid_v7',
    ]
    expect(
      input
        .admin(`SELECT p.proname FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.prosecdef
            AND has_function_privilege('record_actor',p.oid,'EXECUTE')
          ORDER BY p.proname;`)
        .split('\n'),
    ).toEqual(allowedDefiners)
  })

  test('the real organization update hook preserves but never changes a trial marker', async () => {
    const auth = testRecordAuth(input.actorUrl(), input.authUrl())
    try {
      const marker = { createdByUserId: 'proof', createdAt: new Date().toISOString() }
      const organization = await auth.api.createOrganization({
        headers: bearerHeaders(input.token()),
        body: {
          name: `Trial marker hook ${marker.createdAt}`,
          slug: `trial-hook-${newRecordId()}`,
          metadata: { trial: marker },
          keepCurrentActiveOrganization: true,
        },
      })
      await expect(
        auth.api.updateOrganization({
          headers: bearerHeaders(input.token()),
          body: { organizationId: organization.id, data: { metadata: { trial: marker } } },
        }),
      ).resolves.toMatchObject({ id: organization.id })
      await expect(
        auth.api.updateOrganization({
          headers: bearerHeaders(input.token()),
          body: {
            organizationId: organization.id,
            data: { metadata: { trial: { ...marker, createdAt: 'changed' } } },
          },
        }),
      ).rejects.toThrow('metadata.trial is immutable')
    } finally {
      await auth.close()
    }
  })
}
