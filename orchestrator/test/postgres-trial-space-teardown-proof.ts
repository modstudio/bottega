import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  newRecordId,
  RECORD_ACTOR_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_READER_ROLE,
} from '../../shared/record/schema.ts'
import { renderRecordApiRefusal } from '../src/record/record-api-errors.ts'
import { registerRecordProjectRoutes } from '../src/record/record-api-projects.ts'
import { bearerHeaders, type RecordIdentity } from '../src/record/record-auth.ts'
import { closeRecordPools } from '../src/record/record-pool.ts'
import { purgeRecordProject } from '../src/record/record-project-purge.ts'
import {
  deleteRecordSpace,
  deleteTrialRecordSpace,
} from '../src/record/record-trial-space-delete.ts'
import type { PsqlResult } from './fixtures/postgres-rls.ts'
import { testRecordAuth } from './fixtures/record-auth-postgres.ts'

export function registerTrialSpaceTeardownProof(input: {
  actorUrl: () => string
  authUrl: () => string
  token: () => string
  userId: () => string
  admin: (sql: string) => string
  psql: (user: string, password: string, sql: string) => PsqlResult
}): void {
  test('project purge removes only the selected project across every reached path', async () => {
    const owner = newRecordId()
    const space = newRecordId()
    const otherSpace = newRecordId()
    const purgedProject = newRecordId()
    const peerProject = newRecordId()
    const crossSpaceProject = newRecordId()
    const purgedTask = newRecordId()
    const peerTask = newRecordId()
    const crossSpaceTask = newRecordId()
    const purgedInterval = newRecordId()
    const peerInterval = newRecordId()
    input.admin(`
      INSERT INTO "user"(id,email,name,created_at)
        VALUES ('${owner}','purge-proof-${owner}@example.test','purge proof owner',now());
      INSERT INTO space(id,name,slug,metadata,created_at) VALUES
        ('${space}','purge proof','purge-${space}',NULL,now()),
        ('${otherSpace}','purge other','purge-other-${otherSpace}',NULL,now());
      INSERT INTO membership(id,space_id,user_id,role,permission,config_access,created_at) VALUES
        ('${newRecordId()}','${space}','${owner}','owner','write',true,now()),
        ('${newRecordId()}','${otherSpace}','${owner}','owner','write',true,now());
      INSERT INTO project(id,space_id,name,key_prefixes,created_at) VALUES
        ('${purgedProject}','${space}','purged-proof',ARRAY['PP'],now()),
        ('${peerProject}','${space}','peer-proof',ARRAY['PEER'],now()),
        ('${crossSpaceProject}','${otherSpace}','cross-proof',ARRAY['CROSS'],now());
      INSERT INTO hub_task(id,space_id,project_name,project_id,key,project,title,status,source,
        first_seen,last_seen,created_at,updated_at) VALUES
        ('${purgedTask}','${space}','purged-proof','${purgedProject}','PP-1','purged-proof','purged','done','local',now(),now(),now(),now()),
        ('${peerTask}','${space}','peer-proof','${peerProject}','PEER-1','peer-proof','peer','done','local',now(),now(),now(),now()),
        ('${crossSpaceTask}','${otherSpace}','cross-proof','${crossSpaceProject}','CROSS-1','cross-proof','cross','done','local',now(),now(),now(),now());
      INSERT INTO hub_interval(id,space_id,task_key,task_id,project_name,project_id,source,start_at,end_at,ref,updated_at) VALUES
        ('${purgedInterval}','${space}','PP-1','${purgedTask}','purged-proof','${purgedProject}','proof',now()-interval '1 minute',now(),'purged',now()),
        ('${peerInterval}','${space}','PEER-1','${peerTask}','peer-proof','${peerProject}','proof',now()-interval '1 minute',now(),'peer',now());`)

    const result = await purgeRecordProject({
      url: input.actorUrl(),
      userId: owner,
      spaceId: space,
      spaceIds: [space, otherSpace],
      id: purgedProject,
      confirmation: 'purged-proof',
    })
    const counts = Object.fromEntries(result.tables.map((row) => [row.table, row.count]))
    expect(counts.project).toBe(1)
    expect(counts.hub_task).toBe(1)
    expect(counts.hub_interval).toBe(1)
    expect(input.admin(`SELECT count(*) FROM project WHERE id='${purgedProject}';`)).toBe('0')
    expect(
      input.admin(
        `SELECT (SELECT count(*) FROM project WHERE id='${peerProject}') || '|' ||
          (SELECT count(*) FROM hub_task WHERE id='${peerTask}') || '|' ||
          (SELECT count(*) FROM hub_interval WHERE id='${peerInterval}');`,
      ),
    ).toBe('1|1|1')
    expect(
      await purgeRecordProject({
        url: input.actorUrl(),
        userId: owner,
        spaceId: space,
        spaceIds: [space, otherSpace],
        id: purgedProject,
        confirmation: 'purged-proof',
      }),
    ).toEqual({ nothingToRemove: true, tables: [] })

    const routeIdentity: RecordIdentity = {
      user: { id: owner, email: `purge-${owner}@example.test` },
      activeSpaceId: space,
      personalSpaceId: null,
      memberships: [
        {
          space_id: space,
          name: 'Purge proof',
          slug: `purge-${space}`,
          role: 'owner',
          permission: 'write',
        },
        {
          space_id: otherSpace,
          name: 'Purge other',
          slug: `purge-other-${otherSpace}`,
          role: 'owner',
          permission: 'write',
        },
      ],
    }
    const app = new Hono<{ Variables: { identity: RecordIdentity } }>()
    app.use('/v1/*', async (context, next) => {
      context.set('identity', routeIdentity)
      await next()
    })
    registerRecordProjectRoutes(
      app,
      {
        readProjects: async () => [],
        upsertProject: async () => ({ id: crossSpaceProject, name: 'unused' }),
        retireProject: async () => ({ name: 'unused' }),
        purgeProject: purgeRecordProject,
      },
      {
        scope: () => ({
          url: input.actorUrl(),
          userId: owner,
          spaceId: space,
          spaceIds: [space],
        }),
        noSpace: (context) => context.json({ error: 'no space' }, 409),
        writeError: (context, error) => renderRecordApiRefusal(context, error)!,
      },
    )
    const refused = await app.request(`/v1/projects/${crossSpaceProject}/purge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'cross-proof' }),
    })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining('declared-space guard failed'),
    })
    expect(
      input.admin(
        `SELECT (SELECT count(*) FROM project WHERE id='${crossSpaceProject}') || '|' ||
          (SELECT count(*) FROM hub_task WHERE id='${crossSpaceTask}');`,
      ),
    ).toBe('1|1')
    await purgeRecordProject({
      url: input.actorUrl(),
      userId: owner,
      spaceId: otherSpace,
      spaceIds: [space, otherSpace],
      id: crossSpaceProject,
      confirmation: 'cross-proof',
    })
    await purgeRecordProject({
      url: input.actorUrl(),
      userId: owner,
      spaceId: space,
      spaceIds: [space, otherSpace],
      id: peerProject,
      confirmation: 'peer-proof',
    })
    input.admin(
      `DELETE FROM membership WHERE space_id IN ('${space}','${otherSpace}');
       DELETE FROM space WHERE id IN ('${space}','${otherSpace}');
       DELETE FROM "user" WHERE id='${owner}';`,
    )
    await closeRecordPools()
  })

  test('general space delete protects personal spaces and deletes unmarked protected rows', async () => {
    const owner = input.userId()
    const personal = input.admin(`SELECT personal_space_id FROM "user" WHERE id='${owner}';`)
    const personalSlug = input.admin(`SELECT slug FROM space WHERE id='${personal}';`)
    const personalBefore = input.admin(
      `SELECT (SELECT count(*) FROM space WHERE id='${personal}') || '|' ||
        (SELECT count(*) FROM membership WHERE space_id='${personal}');`,
    )
    await expect(
      deleteRecordSpace({
        url: input.actorUrl(),
        slug: personalSlug,
        confirmation: personalSlug,
        userId: owner,
        activeSpaceId: personal,
      }),
    ).rejects.toThrow('personal-space guard failed')
    expect(
      input.admin(
        `SELECT (SELECT count(*) FROM space WHERE id='${personal}') || '|' ||
          (SELECT count(*) FROM membership WHERE space_id='${personal}');`,
      ),
    ).toBe(personalBefore)

    const space = newRecordId()
    const dek = newRecordId()
    const evidence = newRecordId()
    const slug = `trial-general-delete-${space}`
    input.admin(`
      INSERT INTO space(id,name,slug,metadata,created_at)
        VALUES ('${space}','general delete','${slug}',NULL,now());
      INSERT INTO membership(id,space_id,user_id,role,permission,config_access,created_at)
        VALUES ('${newRecordId()}','${space}','${owner}','owner','write',true,now());
      INSERT INTO secret_dek(id,space_id,version,created_at) VALUES ('${dek}','${space}',1,now());
      INSERT INTO routing_evidence_head(id,space_id,sequence) VALUES ('${evidence}','${space}',1);`)
    await expect(
      deleteTrialRecordSpace({
        url: input.actorUrl(),
        slug,
        userId: owner,
        activeSpaceId: personal,
      }),
    ).rejects.toThrow('trial-marker guard failed')
    expect(
      input.admin(
        `SELECT (SELECT count(*) FROM space WHERE id='${space}') || '|' ||
          (SELECT count(*) FROM secret_dek WHERE id='${dek}') || '|' ||
          (SELECT count(*) FROM routing_evidence_head WHERE id='${evidence}');`,
      ),
    ).toBe('1|1|1')
    const deleted = await deleteRecordSpace({
      url: input.actorUrl(),
      slug,
      confirmation: slug,
      userId: owner,
      activeSpaceId: personal,
    })
    const deletedCounts = Object.fromEntries(deleted.tables.map((row) => [row.table, row.count]))
    expect(deletedCounts.secret_dek).toBe(1)
    expect(deletedCounts.routing_evidence_head).toBe(1)
    expect(deletedCounts.space).toBe(1)
    expect(
      input.admin(
        `SELECT (SELECT count(*) FROM space WHERE id='${space}') || '|' ||
          (SELECT count(*) FROM secret_dek WHERE id='${dek}') || '|' ||
          (SELECT count(*) FROM routing_evidence_head WHERE id='${evidence}');`,
      ),
    ).toBe('0|0|0')
    await closeRecordPools()
  })

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
        ack_required,expires_at,created_at,scope_project_ids,recipient_user_ids,shared_space_reach)
        VALUES
          ('${message}','${authorMember}','${run}','notice','architect','proof','proof',false,
            now()+interval '1 hour',now(),ARRAY[]::uuid[],ARRAY[]::uuid[],false),
          ('${permissionMessage}','${authorMember}','${run}','notice','architect','permission','proof',false,
            now()+interval '1 hour',now(),ARRAY[]::uuid[],ARRAY[]::uuid[],false);
      INSERT INTO session(id,user_id,token,expires_at,active_space_id,created_at,updated_at)
        VALUES ('${session}','${member}','trial-session-${session}',now()+interval '1 hour','${trial}',now(),now());
      INSERT INTO machine_public_key(id,space_id,user_id,key_id,public_key,label,created_at)
        VALUES ('${publicKey}','${trial}','${member}','abcdefghijklmnopqrstuv',decode(repeat('00',32),'hex'),'proof',now());
      INSERT INTO secret_dek(id,space_id,version,created_at) VALUES ('${dek}','${trial}',1,now());
      INSERT INTO config_secret(id,space_id,key,environment,dek_id,row_version,envelope,updated_at)
        VALUES ('${newRecordId()}','${trial}','proof','default','${dek}',1,'\\x00',now());`)
    expect(
      input.psql(
        RECORD_OWNER_ROLE,
        'owner-password',
        `SELECT count(*) FROM space WHERE id='${real}';`,
      ),
    ).toMatchObject({ code: 0, stdout: '0' })
    expect(
      input.psql(
        RECORD_OWNER_ROLE,
        'owner-password',
        `SELECT count(*) FROM space WHERE id='${trial}';`,
      ),
    ).toMatchObject({ code: 0, stdout: '1' })
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
    ).toEqual({ nothingToRemove: true, activeSpaceCleared: false, tables: [], neutralized: [] })
    input.admin(`DELETE FROM membership WHERE space_id='${real}' AND user_id='${member}';`)
    const result = await deleteTrialRecordSpace({
      url: input.actorUrl(),
      slug: `trial-${trial}`,
      userId: owner,
      activeSpaceId: trial,
    })
    const counts = Object.fromEntries(result.tables.map((row) => [row.table, row.count]))
    expect(counts.config_secret).toBe(1)
    expect(counts.board_claim).toBe(1)
    expect(counts.board_message).toBe(1)
    expect(counts.space).toBe(1)
    expect(counts.membership).toBe(3)
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
    expect(
      input.psql(
        RECORD_READER_ROLE,
        'reader-password',
        `SELECT record_user_has_real_space_membership('${newRecordId()}');`,
      ),
    ).not.toMatchObject({ code: 0 })
  })

  test('the general protected-row definer grants execute only to record_actor', () => {
    expect(
      input.admin(
        `SELECT has_function_privilege('${RECORD_ACTOR_ROLE}', 'record_delete_protected_space_rows(uuid)', 'EXECUTE') || '|' ||
          has_function_privilege('${RECORD_READER_ROLE}', 'record_delete_protected_space_rows(uuid)', 'EXECUTE') || '|' ||
          has_function_privilege('public', 'record_delete_protected_space_rows(uuid)', 'EXECUTE');`,
      ),
    ).toBe('true|false|false')
  })

  test('the real organization update hook preserves but never changes a trial marker', async () => {
    const auth = testRecordAuth(input.actorUrl(), input.authUrl())
    const slug = `trial-hook-${newRecordId()}`
    let organization: { id: string } | undefined
    try {
      const marker = { createdByUserId: 'proof', createdAt: new Date().toISOString() }
      organization = await auth.api.createOrganization({
        headers: bearerHeaders(input.token()),
        body: {
          name: `Trial marker hook ${marker.createdAt}`,
          slug,
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
      if (organization)
        await deleteTrialRecordSpace({
          url: input.actorUrl(),
          slug,
          userId: input.userId(),
          activeSpaceId: organization.id,
        })
      await auth.close()
    }
  })
}
