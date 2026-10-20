import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { upsertRecordProject } from '../src/record/record-projects.ts'
import { createRecordSpace, recordMemberships } from '../src/record/record-space.ts'
import { moveRecordProjectSpace } from '../src/record/record-space-move.ts'
import { registerProjectSpaceDryRunProofs } from './postgres-project-space-dry-run-proof.ts'
import { proveProjectSpaceRecordSync, SYNC_PROOF_MACHINE } from './postgres-score-proof.ts'
import { registerHostedSyncAuthorizationProofs } from './postgres-sync-authorization-proof.ts'

type PsqlResult = { code: number; stdout: string; stderr: string }

export type ProjectSpaceProofInput = {
  actorUrl: string
  actorRole: string
  machineId: string
  userId: () => string
  firstSpaceId: string
  firstProjectId: string
  secondSpaceId: string
  secondProjectId: string
  otherRunId: string
  token: (user?: 'a' | 'b') => string
  setToken(token: string): void
  asSpace(user: string, password: string, spaceId: string, statement: string): PsqlResult
  admin(statement: string): string
}

export function registerProjectSpaceProofs(input: ProjectSpaceProofInput): void {
  test('space creation grants ownership and duplicate slug names the existing id', async () => {
    input.setToken(input.token())
    const created = await createRecordSpace('DEV 741 Team', 'dev-741-team')
    expect(created.slug).toBe('dev-741-team')
    expect((await recordMemberships()).memberships).toContainEqual(
      expect.objectContaining({
        spaceId: created.id,
        slug: created.slug,
        role: 'owner',
        permission: 'write',
      }),
    )
    await expect(createRecordSpace('Duplicate', created.slug)).rejects.toThrow(
      `record space slug ${created.slug} already exists: ${created.id}`,
    )
  })

  test('two projects sync into separate spaces and remain tenant-confined', async () => {
    input.setToken(input.token())
    input.admin(
      `INSERT INTO membership (id,space_id,user_id,role,permission,created_at) VALUES
       ('${newRecordId()}','${input.firstSpaceId}','${input.userId()}','member','write',now()),
       ('${newRecordId()}','${input.secondSpaceId}','${input.userId()}','member','write',now())
       ON CONFLICT (space_id,user_id) DO UPDATE SET permission='write';`,
    )
    const ids = await proveProjectSpaceRecordSync({
      actorUrl: input.actorUrl,
      actorRole: input.actorRole,
      machineId: SYNC_PROOF_MACHINE,
      userId: input.userId(),
      firstSpaceId: input.firstSpaceId,
      firstProjectId: input.firstProjectId,
      secondSpaceId: input.secondSpaceId,
      secondProjectId: input.secondProjectId,
      asSpace: input.asSpace,
    })
    expect(ids).toHaveLength(2)
  })

  test('cross-space run SELECT returns nothing', () => {
    const result = input.asSpace(
      input.actorRole,
      'actor-password',
      input.firstSpaceId,
      `SELECT id FROM run WHERE id = '${input.otherRunId}';`,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.split('\n').at(-1)).toBe('')
  })

  test('cross-space write is refused', () => {
    const result = input.asSpace(
      input.actorRole,
      'actor-password',
      input.firstSpaceId,
      `INSERT INTO project (id, space_id, name, created_at)
       VALUES ('01990000-0000-7000-8000-00000000002b', '${input.secondSpaceId}', 'intruder', now());`,
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('violates row-level security policy')
  })

  registerHostedSyncAuthorizationProofs({
    machineId: SYNC_PROOF_MACHINE,
    // The suite fills the signed-in user in during setup, after registration.
    get userId() {
      return input.userId()
    },
    writeSpaceId: input.firstSpaceId,
    writeProjectName: 'alpha',
    writeProjectId: input.firstProjectId,
    token: input.token,
    otherToken: () => input.token('b'),
    setToken: input.setToken,
    admin: input.admin,
  })

  test('project rows move together while another source project and space aggregates stay', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('move proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 747 Move',
      `dev-747-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const otherProject = newRecordId()
    const run = newRecordId()
    const otherRun = newRecordId()
    const review = newRecordId()
    const reviewLens = newRecordId()
    const finding = newRecordId()
    const landing = newRecordId()
    const runContention = newRecordId()
    const landingContention = newRecordId()
    const document = newRecordId()
    const documentRevision = newRecordId()
    const note = newRecordId()
    const noteAcknowledgement = newRecordId()
    const builtInSelection = newRecordId()
    const customSelection = newRecordId()
    const customProfile = newRecordId()
    const customProfileRevision = newRecordId()
    const pair = newRecordId()
    const baseline = newRecordId()
    const skip = newRecordId()
    const sourceOnlyPair = newRecordId()
    const portRef = newRecordId()
    const portRefSource = newRecordId()
    const subscription = newRecordId()
    const send = newRecordId()
    const sendRecipient = newRecordId()
    const task = `MOVE-${newRecordId().slice(-6)}`
    const inserted = input.asSpace(
      input.actorRole,
      'actor-password',
      source,
      `INSERT INTO project (id,space_id,name,key_prefixes,created_at) VALUES
         ('${project}','${source}','move-proof',ARRAY['MOVE'],now()),
         ('${otherProject}','${source}','stay-proof',ARRAY['STAY'],now());
       INSERT INTO run
         (id,space_id,project_id,machine_id,started_at,agent,job,prompt_sha,
          prompt_bytes,prompt_head,probe,status,turn,no_failover,automatic_failover,
          work_preserved,created_at,updated_at) VALUES
         ('${run}','${source}','${project}','${input.machineId}',now(),'proof','proof','m',1,'m',false,'ok',1,false,false,false,now(),now()),
         ('${otherRun}','${source}','${otherProject}','${input.machineId}',now(),'proof','proof','s',1,'s',false,'ok',1,false,false,false,now(),now());
       INSERT INTO review
         (id,space_id,project_id,machine_id,recorded_at,created_at,updated_at)
         VALUES ('${review}','${source}','${project}','${input.machineId}',now(),now(),now());
       INSERT INTO review_lens
         (id,space_id,review_id,run_id,machine_id,lens,agent,standards_read,files_covered,
          commands_run,could_not_verify,mcp_tools,docs_read,substitutes,created_at,updated_at)
         VALUES ('${reviewLens}','${source}','${review}','${run}','${input.machineId}',
          'correctness','proof','[]','[]','[]','[]','[]','[]','[]',now(),now());
       INSERT INTO review_finding
         (id,space_id,review_id,review_lens_id,machine_id,ordinal,severity,location,evidence,
          proposed_correction,created_at,updated_at)
         VALUES ('${finding}','${source}','${review}','${reviewLens}','${input.machineId}',1,
          'major','proof.ts:1','evidence','fix',now(),now());
       INSERT INTO landing
         (id,space_id,project_id,machine_id,branch,status,started_at,created_at,updated_at)
         VALUES ('${landing}','${source}','${project}','${input.machineId}',
          'DEV-747-proof','landed',now(),now(),now());
       INSERT INTO contention
         (id,space_id,machine_id,at,resource_kind,resource_key,event_kind,run_id,created_at,updated_at)
         VALUES ('${runContention}','${source}','${input.machineId}',now(),'run','move-run','wait','${run}',now(),now());
       INSERT INTO contention
         (id,space_id,machine_id,at,resource_kind,resource_key,event_kind,landing_id,created_at,updated_at)
         VALUES ('${landingContention}','${source}','${input.machineId}',now(),'landing','move-landing','wait','${landing}',now(),now());
       INSERT INTO doc
         (id,space_id,scope,subject,slug,title,body,delivery,audiences,project_id,created_at,updated_at)
         VALUES ('${document}','${source}','project','move-proof','move-proof','Move proof',
          'Body','demand',ARRAY['technical'],'${project}',now(),now());
       INSERT INTO doc_revision
         (id,space_id,doc_id,scope,subject,slug,op,title,body,delivery,author,reason,at,audiences,project_id)
         VALUES ('${documentRevision}','${source}','${document}','project','move-proof',
          'move-proof','create','Move proof','Body','demand','proof','proof',now(),
          ARRAY['technical'],'${project}');
       INSERT INTO hub_note
         (id,space_id,project_name,project_id,number,project,text,anchors,sightings,created_at,last_seen_at,updated_at)
         VALUES ('${note}','${source}','move-proof','${project}',1,'move-proof','move note',
          '[]',1,now(),now(),now());
       INSERT INTO hub_note_acknowledgement
         (id,space_id,project_name,project_id,note_id,session_id,acknowledged_at,sightings,created_at,updated_at)
         VALUES ('${noteAcknowledgement}','${source}','move-proof','${project}','${note}',
          'move-session',now(),1,now(),now());
       INSERT INTO lens_profile
         (id,space_id,lens_id,axis,name,version,body,enabled,updated_at)
         SELECT '${customProfile}','${source}',id,'architecture','move-custom',2,
          '{"guidance":"custom move profile"}',true,now() FROM lens
         WHERE space_id='${source}' ORDER BY key LIMIT 1;
       INSERT INTO lens_profile_revision
         (id,space_id,profile_id,version,prior_body,reason,session_id,at)
         VALUES ('${customProfileRevision}','${source}','${customProfile}',1,
          '{"body":{"guidance":"prior"},"enabled":true}','proof','move-session',now());
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version,selection_version,updated_at)
         SELECT '${builtInSelection}','${source}','${project}',id,'framework','default',NULL,1,now()
         FROM lens WHERE space_id='${source}' ORDER BY key LIMIT 1;
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version,selection_version,updated_at)
         SELECT '${customSelection}','${source}','${project}',id,'architecture','move-custom',NULL,1,now()
         FROM lens WHERE space_id='${source}' ORDER BY key LIMIT 1;
       INSERT INTO port_pair(id,space_id,source_project_id,target_project_id,created_at) VALUES
         ('${pair}','${source}','${otherProject}','${project}',now()),
         ('${sourceOnlyPair}','${source}','${project}','${otherProject}',now());
       INSERT INTO port_baseline(id,space_id,pair_id,source_commit,scanned_at,version,updated_at)
         VALUES ('${baseline}','${source}','${pair}','abc123',now(),1,now());
       INSERT INTO port_skip(id,space_id,pair_id,candidate,reason,skipped_at)
         VALUES ('${skip}','${source}','${pair}','def456','proof',now());
       INSERT INTO port_ref(id,space_id,task_key,target_project_id,note,created_at,version,updated_at)
         VALUES ('${portRef}','${source}','${task}','${project}','proof',now(),1,now());
       INSERT INTO port_ref_source
         (id,space_id,ref_id,source_project_id,commits,paths,note,updated_at)
         VALUES ('${portRefSource}','${source}','${portRef}','${otherProject}',
          '["abc123"]','["proof.ts"]','proof',now());
       INSERT INTO seq(space_id,project_id,name,next) VALUES
         ('${source}','${project}','task:MOVE',2),('${source}','${otherProject}','task:STAY',2);
       INSERT INTO hub_task
         (id,space_id,project_name,key,project,source,first_seen,last_seen,created_at,updated_at)
         VALUES ('${newRecordId()}','${source}','move-proof','${task}','move-proof','local',now(),now(),now(),now());
       INSERT INTO hub_day
         (id,space_id,day,collected_at,updated_at)
         VALUES ('${newRecordId()}','${source}','2099-07-47',now(),now());
       INSERT INTO hub_report_subscription
         (id,space_id,scope_kind,project_name,cadence,hour,zone,enabled,created_at,updated_at)
         VALUES ('${subscription}','${source}','project','move-proof','daily',9,'UTC',1,now(),now());
       INSERT INTO hub_send
         (id,space_id,at,"window",recipients,projects,items,status,test,created_at,machine,
          subscription_id,period_start,period_end)
         VALUES ('${send}','${source}',now(),'day','operator@example.test','move-proof',1,'sent',0,
          now(),'proof','${subscription}',now() - interval '1 day',now());
       INSERT INTO hub_send_recipient
         (id,space_id,send_id,user_id,name,email,created_at)
         VALUES ('${sendRecipient}','${source}','${send}','${input.userId()}',
          'Operator','operator@example.test',now());`,
    )
    expect(inserted.code, inserted.stderr).toBe(0)

    const dry = await moveRecordProjectSpace({
      url: input.actorUrl,
      project: 'move-proof',
      source,
      destination: destination.slug,
    })
    expect(dry.rows.find((row) => row.tableName === 'project')?.rowCount).toBe(1)
    expect(dry.rows.find((row) => row.tableName === 'run')?.rowCount).toBe(1)
    expect(dry.rows.find((row) => row.tableName === 'hub_task')?.rowCount).toBe(1)
    expect(dry.rows.find((row) => row.tableName === 'hub_day')).toMatchObject({
      rowCount: 0,
      moved: false,
      reachedBy: 'space-and-day aggregate; no project attribution',
    })
    expect(dry.rows.find((row) => row.tableName === 'hub_send')).toMatchObject({
      rowCount: 0,
      moved: false,
      reachedBy: 'space send; projects may name several projects',
    })
    expect(dry.rows.find((row) => row.tableName === 'hub_send_recipient')).toMatchObject({
      rowCount: 0,
      moved: false,
      reachedBy: 'space send recipient; parent send is not project-attributable',
    })
    expect(
      input.asSpace(
        input.actorRole,
        'actor-password',
        source,
        `SELECT count(*) FROM project WHERE id='${project}';`,
      ).stdout,
    ).toBe('1')

    const moved = await moveRecordProjectSpace({
      url: input.actorUrl,
      project: 'move-proof',
      source,
      destination: destination.slug,
      confirm: dry.total,
    })
    expect(moved.rows.filter((row) => row.moved).map((row) => row.tableName)).toContain('seq')
    const sourceFacts = input.asSpace(
      input.actorRole,
      'actor-password',
      source,
      `SELECT count(*) FROM project WHERE id='${project}';
       SELECT count(*) FROM run WHERE id='${run}';
       SELECT count(*) FROM hub_task WHERE key='${task}';
       SELECT count(*) FROM review WHERE id='${review}';
       SELECT count(*) FROM review_lens WHERE id='${reviewLens}';
       SELECT count(*) FROM review_finding WHERE id='${finding}';
       SELECT count(*) FROM landing WHERE id='${landing}';
       SELECT count(*) FROM contention WHERE id IN ('${runContention}','${landingContention}');
       SELECT count(*) FROM doc WHERE id='${document}';
       SELECT count(*) FROM doc_revision WHERE id='${documentRevision}';
       SELECT count(*) FROM hub_note WHERE id='${note}';
       SELECT count(*) FROM hub_note_acknowledgement WHERE id='${noteAcknowledgement}';
       SELECT count(*) FROM project_lens_profile WHERE id IN ('${builtInSelection}','${customSelection}');
       SELECT count(*) FROM port_pair WHERE id='${pair}';
       SELECT count(*) FROM port_baseline WHERE id='${baseline}';
       SELECT count(*) FROM port_skip WHERE id='${skip}';
       SELECT count(*) FROM port_ref WHERE id='${portRef}';
       SELECT count(*) FROM port_ref_source WHERE id='${portRefSource}';
       SELECT count(*) FROM port_pair WHERE id='${sourceOnlyPair}';
       SELECT count(*) FROM project WHERE id='${otherProject}';
       SELECT count(*) FROM run WHERE id='${otherRun}';
       SELECT count(*) FROM hub_day WHERE day='2099-07-47';
       SELECT count(*) FROM hub_send WHERE id='${send}';
       SELECT count(*) FROM hub_send_recipient WHERE id='${sendRecipient}';`,
    )
    expect(sourceFacts.code, sourceFacts.stderr).toBe(0)
    expect(sourceFacts.stdout.split('\n')).toEqual([
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '1',
      '1',
      '1',
      '1',
      '1',
      '1',
    ])
    const destinationFacts = input.asSpace(
      input.actorRole,
      'actor-password',
      destination.id,
      `SELECT count(*) FROM project WHERE id='${project}';
       SELECT count(*) FROM run WHERE id='${run}';
       SELECT count(*) FROM hub_task WHERE key='${task}';
       SELECT count(*) FROM review WHERE id='${review}';
       SELECT count(*) FROM review_lens WHERE id='${reviewLens}';
       SELECT count(*) FROM review_finding WHERE id='${finding}';
       SELECT count(*) FROM landing WHERE id='${landing}';
       SELECT count(*) FROM contention WHERE id IN ('${runContention}','${landingContention}');
       SELECT count(*) FROM doc WHERE id='${document}';
       SELECT count(*) FROM doc_revision WHERE id='${documentRevision}';
       SELECT count(*) FROM hub_note WHERE id='${note}';
       SELECT count(*) FROM hub_note_acknowledgement WHERE id='${noteAcknowledgement}';
       SELECT count(*) FROM project_lens_profile WHERE id IN ('${builtInSelection}','${customSelection}');
       SELECT count(*) FROM lens_profile p JOIN lens l ON l.id=p.lens_id
         WHERE p.space_id='${destination.id}' AND p.axis='architecture' AND p.name='move-custom'
           AND p.body='{"guidance":"custom move profile"}';
       SELECT count(*) FROM lens_profile_revision r JOIN lens_profile p ON p.id=r.profile_id
         WHERE r.space_id='${destination.id}' AND p.name='move-custom' AND r.version=1;
       SELECT count(*) FROM port_pair WHERE id='${pair}';
       SELECT count(*) FROM port_baseline WHERE id='${baseline}';
       SELECT count(*) FROM port_skip WHERE id='${skip}';
       SELECT count(*) FROM port_ref WHERE id='${portRef}';
       SELECT count(*) FROM port_ref_source WHERE id='${portRefSource}';
       SELECT count(*) FROM seq WHERE project_id='${project}';`,
    )
    expect(destinationFacts.code, destinationFacts.stderr).toBe(0)
    expect(destinationFacts.stdout.split('\n')).toEqual([
      '1',
      '1',
      '1',
      '1',
      '1',
      '1',
      '1',
      '2',
      '1',
      '1',
      '1',
      '1',
      '2',
      '1',
      '1',
      '1',
      '1',
      '1',
      '1',
      '1',
      '1',
    ])

    // The move turns FORCE RLS off per table to rewrite space_id, and this move
    // COMMITTED, so nothing would put it back. A table left unforced lets its
    // owner read every space, which is the protection the whole record rests on.
    const unforced = input.admin(
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
         AND NOT c.relforcerowsecurity;`,
    )
    expect(unforced.trim()).toBe('0')
  })

  test('a dry run refuses a destination lens profile with different current content', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('profile conflict proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1214 Profile Conflict',
      `dev-1214-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const sourceProfile = newRecordId()
    const destinationProfile = newRecordId()
    const selection = newRecordId()
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','profile-conflict-proof',now());
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,body,enabled,updated_at)
         SELECT '${sourceProfile}','${source}',id,'architecture','conflicting-profile',1,
           '{"guidance":"source"}',true,now() FROM lens
         WHERE space_id='${source}' ORDER BY key LIMIT 1;
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,body,enabled,updated_at)
         SELECT '${destinationProfile}','${destination.id}',id,'architecture','conflicting-profile',1,
           '{"guidance":"destination"}',true,now() FROM lens
         WHERE space_id='${destination.id}' ORDER BY key LIMIT 1;
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version,selection_version,updated_at)
         SELECT '${selection}','${source}','${project}',id,'architecture','conflicting-profile',NULL,1,now()
         FROM lens WHERE space_id='${source}' ORDER BY key LIMIT 1;`,
    )
    await expect(
      moveRecordProjectSpace({
        url: input.actorUrl,
        project: 'profile-conflict-proof',
        source,
        destination: destination.slug,
      }),
    ).rejects.toThrow(
      `project profile-conflict-proof cannot move from space ${source} to space ${destination.id} because lens profiles have different current content`,
    )
    expect(
      input
        .admin(
          `SELECT space_id FROM project WHERE id='${project}';
         SELECT space_id FROM project_lens_profile WHERE id='${selection}';`,
        )
        .trim()
        .split('\n'),
    ).toEqual([source, source])
  })

  test('an unpinned selection re-points without merging divergent profile history', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('unpinned history proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1214 Unpinned History',
      `dev-1214-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const sourceProfile = newRecordId()
    const destinationProfile = newRecordId()
    const selection = newRecordId()
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','unpinned-history-proof',now());
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,body,enabled,updated_at)
         SELECT '${sourceProfile}','${source}',id,'architecture','history-profile',2,
           '{"guidance":"current"}',true,now() FROM lens
         WHERE space_id='${source}' ORDER BY key LIMIT 1;
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,body,enabled,updated_at)
         SELECT '${destinationProfile}','${destination.id}',id,'architecture','history-profile',2,
           '{"guidance":"current"}',true,now() FROM lens
         WHERE space_id='${destination.id}' ORDER BY key LIMIT 1;
       INSERT INTO lens_profile_revision(id,space_id,profile_id,version,prior_body,reason,at) VALUES
         ('${newRecordId()}','${source}','${sourceProfile}',1,
          '{"body":{"guidance":"source prior"},"enabled":true}','proof',now()),
         ('${newRecordId()}','${destination.id}','${destinationProfile}',1,
          '{"body":{"guidance":"destination prior"},"enabled":true}','proof',now());
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version,selection_version,updated_at)
         SELECT '${selection}','${source}','${project}',id,'architecture','history-profile',NULL,1,now()
         FROM lens WHERE space_id='${source}' ORDER BY key LIMIT 1;`,
    )
    const dry = await moveRecordProjectSpace({
      url: input.actorUrl,
      project: 'unpinned-history-proof',
      source,
      destination: destination.slug,
    })
    await moveRecordProjectSpace({
      url: input.actorUrl,
      project: 'unpinned-history-proof',
      source,
      destination: destination.slug,
      confirm: dry.total,
    })
    expect(
      input
        .admin(
          `SELECT count(*) FROM project_lens_profile s JOIN lens l ON l.id=s.lens_id
             WHERE s.id='${selection}' AND s.space_id='${destination.id}' AND l.space_id='${destination.id}';
           SELECT count(*) FROM lens_profile_revision
             WHERE profile_id='${destinationProfile}' AND prior_body::jsonb =
               '{"body":{"guidance":"destination prior"},"enabled":true}'::jsonb;
           SELECT count(*) FROM lens_profile_revision WHERE profile_id='${destinationProfile}';`,
        )
        .trim()
        .split('\n'),
    ).toEqual(['1', '1', '1'])
  })

  test('a pinned selection refuses equal current content with divergent history', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('pinned history proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1214 Pinned History',
      `dev-1214-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const sourceProfile = newRecordId()
    const destinationProfile = newRecordId()
    const selection = newRecordId()
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','pinned-history-proof',now());
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,body,enabled,updated_at)
         SELECT '${sourceProfile}','${source}',id,'architecture','pinned-history',2,
           '{"guidance":"current"}',true,now() FROM lens
         WHERE space_id='${source}' ORDER BY key LIMIT 1;
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,body,enabled,updated_at)
         SELECT '${destinationProfile}','${destination.id}',id,'architecture','pinned-history',2,
           '{"guidance":"current"}',true,now() FROM lens
         WHERE space_id='${destination.id}' ORDER BY key LIMIT 1;
       INSERT INTO lens_profile_revision(id,space_id,profile_id,version,prior_body,reason,at) VALUES
         ('${newRecordId()}','${source}','${sourceProfile}',1,
          '{"body":{"guidance":"source prior"},"enabled":true}','proof',now()),
         ('${newRecordId()}','${destination.id}','${destinationProfile}',1,
          '{"body":{"guidance":"destination prior"},"enabled":true}','proof',now());
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version,selection_version,updated_at)
         SELECT '${selection}','${source}','${project}',id,'architecture','pinned-history',1,1,now()
         FROM lens WHERE space_id='${source}' ORDER BY key LIMIT 1;`,
    )
    await expect(
      moveRecordProjectSpace({
        url: input.actorUrl,
        project: 'pinned-history-proof',
        source,
        destination: destination.slug,
      }),
    ).rejects.toThrow(
      `project pinned-history-proof lens correctness profile pinned-history version 1 from space ${source} differs from or is missing in space ${destination.id}`,
    )
    expect(input.admin(`SELECT space_id FROM project WHERE id='${project}';`).trim()).toBe(source)
  })

  test('a pinned selection refuses when the destination profile lacks that version', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('missing pinned version proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1214 Missing Pinned Version',
      `dev-1214-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const sourceProfile = newRecordId()
    const destinationProfile = newRecordId()
    const selection = newRecordId()
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','missing-version-proof',now());
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,body,enabled,updated_at)
         SELECT '${sourceProfile}','${source}',id,'architecture','missing-version',2,
           '{"guidance":"current"}',true,now() FROM lens
         WHERE space_id='${source}' ORDER BY key LIMIT 1;
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,body,enabled,updated_at)
         SELECT '${destinationProfile}','${destination.id}',id,'architecture','missing-version',2,
           '{"guidance":"current"}',true,now() FROM lens
         WHERE space_id='${destination.id}' ORDER BY key LIMIT 1;
       INSERT INTO lens_profile_revision(id,space_id,profile_id,version,prior_body,reason,at)
         VALUES ('${newRecordId()}','${source}','${sourceProfile}',1,
          '{"body":{"guidance":"prior"},"enabled":true}','proof',now());
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version,selection_version,updated_at)
         SELECT '${selection}','${source}','${project}',id,'architecture','missing-version',1,1,now()
         FROM lens WHERE space_id='${source}' ORDER BY key LIMIT 1;`,
    )
    await expect(
      moveRecordProjectSpace({
        url: input.actorUrl,
        project: 'missing-version-proof',
        source,
        destination: destination.slug,
      }),
    ).rejects.toThrow(
      `project missing-version-proof lens correctness profile missing-version version 1 from space ${source} differs from or is missing in space ${destination.id}`,
    )
    expect(input.admin(`SELECT space_id FROM project WHERE id='${project}';`).trim()).toBe(source)
  })

  test('a dry run reports port pair and ref destination unique-key collisions atomically', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('port collision proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1214 Port Collision',
      `dev-1214-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const sourceProject = newRecordId()
    const sourcePair = newRecordId()
    const destinationPair = newRecordId()
    const sourceRef = newRecordId()
    const destinationRef = newRecordId()
    const taskKey = `PORT-${newRecordId().slice(-6)}`
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at) VALUES
         ('${project}','${source}','port-collision-proof',now()),
         ('${sourceProject}','${source}','port-collision-source',now());
       INSERT INTO port_pair(id,space_id,source_project_id,target_project_id,created_at)
         VALUES ('${sourcePair}','${source}','${sourceProject}','${project}',now());
       INSERT INTO port_ref(id,space_id,task_key,target_project_id,note,created_at,version,updated_at)
         VALUES ('${sourceRef}','${source}','${taskKey}','${project}','source',now(),1,now());
       SET session_replication_role=replica;
       INSERT INTO port_pair(id,space_id,source_project_id,target_project_id,created_at)
         VALUES ('${destinationPair}','${destination.id}','${sourceProject}','${project}',now());
       INSERT INTO port_ref(id,space_id,task_key,target_project_id,note,created_at,version,updated_at)
         VALUES ('${destinationRef}','${destination.id}','${taskKey}','${project}','destination',now(),1,now());
       SET session_replication_role=origin;`,
    )
    let message = ''
    try {
      await moveRecordProjectSpace({
        url: input.actorUrl,
        project: 'port-collision-proof',
        source,
        destination: destination.slug,
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('destination unique keys conflict')
    expect(message).toContain('port_pair (port_pair_space_projects_unique)')
    expect(message).toContain('port_ref (port_ref_space_target_task_unique)')
    expect(message).toContain(source)
    expect(message).toContain(destination.id)
    expect(
      input
        .admin(
          `SELECT space_id FROM project WHERE id='${project}';
           SELECT space_id FROM port_pair WHERE id='${sourcePair}';
           SELECT space_id FROM port_ref WHERE id='${sourceRef}';`,
        )
        .trim()
        .split('\n'),
    ).toEqual([source, source, source])
  })

  registerProjectSpaceDryRunProofs(input)

  test('a task collision is named and a mid-move failure rolls the whole move back', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('move proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 747 Atomic',
      `dev-747-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const run = newRecordId()
    const key = `COLLIDE-${newRecordId().slice(-6)}`
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at) VALUES ('${project}','${source}','atomic-proof',now());
       INSERT INTO run
         (id,space_id,project_id,machine_id,started_at,agent,job,prompt_sha,prompt_bytes,
          prompt_head,probe,status,turn,no_failover,automatic_failover,work_preserved,created_at,updated_at)
         VALUES ('${run}','${source}','${project}','${input.machineId}',now(),'proof','proof','a',1,'a',false,'ok',1,false,false,false,now(),now());
       INSERT INTO hub_task(id,space_id,project_name,key,project,source,first_seen,last_seen,created_at,updated_at) VALUES
         ('${newRecordId()}','${source}','atomic-proof','${key}','atomic-proof','local',now(),now(),now(),now()),
         ('${newRecordId()}','${destination.id}','other','${key}','other','local',now(),now(),now(),now());`,
    )
    await expect(
      moveRecordProjectSpace({
        url: input.actorUrl,
        project: 'atomic-proof',
        source,
        destination: destination.id,
      }),
    ).rejects.toThrow(key)
    input.admin(`DELETE FROM hub_task WHERE space_id='${destination.id}' AND key='${key}';`)
    const dry = await moveRecordProjectSpace({
      url: input.actorUrl,
      project: 'atomic-proof',
      source,
      destination: destination.id,
    })
    input.admin(
      `CREATE FUNCTION dev_747_forced_failure() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'forced move failure'; END $$;
       CREATE TRIGGER dev_747_forced_failure BEFORE UPDATE ON run
         FOR EACH ROW WHEN (OLD.id='${run}') EXECUTE FUNCTION dev_747_forced_failure();`,
    )
    try {
      await expect(
        moveRecordProjectSpace({
          url: input.actorUrl,
          project: 'atomic-proof',
          source,
          destination: destination.id,
          confirm: dry.total,
        }),
      ).rejects.toThrow('forced move failure')
    } finally {
      input.admin(
        'DROP TRIGGER dev_747_forced_failure ON run; DROP FUNCTION dev_747_forced_failure();',
      )
    }
    const sourceFacts = input.asSpace(
      input.actorRole,
      'actor-password',
      source,
      `SELECT count(*) FROM project WHERE id='${project}'; SELECT count(*) FROM run WHERE id='${run}';`,
    )
    expect(sourceFacts.stdout.split('\n')).toEqual(['1', '1'])
    const destinationFacts = input.asSpace(
      input.actorRole,
      'actor-password',
      destination.id,
      `SELECT count(*) FROM project WHERE id='${project}'; SELECT count(*) FROM run WHERE id='${run}';`,
    )
    expect(destinationFacts.stdout.split('\n')).toEqual(['0', '0'])
  })

  test('a hosted rename changes rows by project id and leaves null project rows unchanged', async () => {
    input.setToken(input.token())
    const space = (await recordMemberships()).activeSpaceId
    if (!space) throw new Error('rename proof has no active space')
    const project = newRecordId()
    const other = newRecordId()
    const note = newRecordId()
    const subscription = newRecordId()
    const projectDoc = newRecordId()
    const legacyProjectDoc = newRecordId()
    const stackDoc = newRecordId()
    const otherProjectDoc = newRecordId()
    const task = `REN-${newRecordId().slice(-6)}`
    try {
      const inserted = input.asSpace(
        input.actorRole,
        'actor-password',
        space,
        `INSERT INTO project (id,space_id,name,created_at) VALUES
         ('${project}','${space}','rename-proof',now()),
         ('${other}','${space}','rename-stay',now());
       INSERT INTO doc
         (id,space_id,scope,subject,slug,title,body,delivery,audiences,featured,project_id,kind,created_at,updated_at)
         VALUES
         ('${projectDoc}','${space}','project','rename-proof','rename-project','Project','body','demand',ARRAY['technical'],false,'${project}','working',now(),now()),
         ('${legacyProjectDoc}','${space}','project','rename-proof','rename-legacy','Legacy','body','demand',ARRAY['technical'],false,NULL,'working',now(),now()),
         ('${stackDoc}','${space}','stack','rename-proof','rename-stack','Stack','body','demand',ARRAY['technical'],false,NULL,'working',now(),now()),
         ('${otherProjectDoc}','${space}','project','rename-proof','rename-other-project','Other','body','demand',ARRAY['technical'],false,'${other}','working',now(),now());
       INSERT INTO doc_revision
         (id,space_id,doc_id,scope,subject,slug,op,title,body,delivery,author,reason,at,audiences,project_id)
         VALUES
         ('${newRecordId()}','${space}','${projectDoc}','project','rename-proof','rename-project','create','Project','body','demand','proof','proof',now(),ARRAY['technical'],'${project}'),
         ('${newRecordId()}','${space}','${legacyProjectDoc}','project','rename-proof','rename-legacy','create','Legacy','body','demand','proof','proof',now(),ARRAY['technical'],NULL),
         ('${newRecordId()}','${space}','${stackDoc}','stack','rename-proof','rename-stack','create','Stack','body','demand','proof','proof',now(),ARRAY['technical'],NULL),
         ('${newRecordId()}','${space}','${otherProjectDoc}','project','rename-proof','rename-other-project','create','Other','body','demand','proof','proof',now(),ARRAY['technical'],'${other}');
       INSERT INTO hub_task
         (id,space_id,project_name,project_id,key,project,source,first_seen,last_seen,created_at,updated_at)
         VALUES
         ('${newRecordId()}','${space}','rename-proof','${project}','${task}','rename-proof','local',now(),now(),now(),now()),
         ('${newRecordId()}','${space}','rename-proof',NULL,'${task}-null','rename-proof','local',now(),now(),now(),now()),
         ('${newRecordId()}','${space}','rename-stay','${other}','${task}-stay','rename-stay','local',now(),now(),now(),now());
       INSERT INTO hub_task_comment
         (id,space_id,project_name,project_id,task_key,body,created_at,updated_at)
         VALUES ('${newRecordId()}','${space}','rename-proof','${project}','${task}','c',now(),now());
       INSERT INTO hub_task_document
         (id,space_id,project_name,project_id,task_key,number,title,body,version,created_at,updated_at)
         VALUES ('${newRecordId()}','${space}','rename-proof','${project}','${task}',1,'t','b','1',now(),now());
       INSERT INTO hub_task_status_event
         (id,space_id,project_name,project_id,task_key,at,to_status,created_at,updated_at)
         VALUES ('${newRecordId()}','${space}','rename-proof','${project}','${task}',now(),'active',now(),now());
       INSERT INTO hub_note
         (id,space_id,project_name,project_id,number,project,text,anchors,sightings,created_at,last_seen_at,updated_at)
         VALUES ('${note}','${space}','rename-proof','${project}',1,'rename-proof','n','[]',1,now(),now(),now());
       INSERT INTO hub_note_acknowledgement
         (id,space_id,project_name,project_id,note_id,session_id,acknowledged_at,sightings,created_at,updated_at)
         VALUES ('${newRecordId()}','${space}','rename-proof','${project}','${note}','sess',now(),1,now(),now());
       INSERT INTO hub_interval
         (id,space_id,project_name,project_id,source,start_at,end_at,ref,updated_at)
         VALUES ('${newRecordId()}','${space}','rename-proof','${project}','transcript',now(),now(),'r',now());
       INSERT INTO hub_report_subscription
         (id,space_id,scope_kind,project_name,project_id,cadence,hour,zone,enabled,created_at,updated_at)
         VALUES ('${subscription}','${space}','project','rename-proof','${project}','daily',9,'UTC',1,now(),now());
       INSERT INTO hub_report_subscription_project
         (id,space_id,subscription_id,project_id,project_space_id,project_name,created_at)
         VALUES ('${newRecordId()}','${space}','${subscription}','${project}','${space}','rename-proof',now());`,
      )
      expect(inserted.code, inserted.stderr).toBe(0)
      await upsertRecordProject({
        id: project,
        url: input.actorUrl,
        userId: input.userId(),
        spaceId: space,
        name: 'renamed-proof',
        path: '/w/renamed-proof',
        stack: null,
        canon: false,
        settings: {},
        retiredAt: null,
      })
      const leftover = input.admin(`
      SELECT sum(n) FROM (
        SELECT count(*) n FROM hub_task WHERE project_name='rename-proof' OR project='rename-proof'
        UNION ALL SELECT count(*) FROM hub_task_comment WHERE project_name='rename-proof'
        UNION ALL SELECT count(*) FROM hub_task_document WHERE project_name='rename-proof'
        UNION ALL SELECT count(*) FROM hub_task_status_event WHERE project_name='rename-proof'
        UNION ALL SELECT count(*) FROM hub_note WHERE project_name='rename-proof' OR project='rename-proof'
        UNION ALL SELECT count(*) FROM hub_note_acknowledgement WHERE project_name='rename-proof'
        UNION ALL SELECT count(*) FROM hub_interval WHERE project_name='rename-proof'
        UNION ALL SELECT count(*) FROM hub_report_subscription WHERE project_name='rename-proof'
        UNION ALL SELECT count(*) FROM hub_report_subscription_project WHERE project_name='rename-proof'
      ) leftover;
      SELECT count(*) FROM hub_task WHERE project_name='rename-stay';
      SELECT name FROM project WHERE id='${project}';
      SELECT subject FROM doc WHERE id='${projectDoc}';
      SELECT subject FROM doc WHERE id='${legacyProjectDoc}';
      SELECT subject FROM doc WHERE id='${stackDoc}';
      SELECT subject FROM doc WHERE id='${otherProjectDoc}';
      SELECT subject FROM doc_revision WHERE doc_id='${stackDoc}';
      SELECT subject FROM doc_revision WHERE doc_id='${otherProjectDoc}';`)
      expect(leftover.trim().split('\n')).toEqual([
        '1',
        '1',
        'renamed-proof',
        'renamed-proof',
        'rename-proof',
        'rename-proof',
        'rename-proof',
        'rename-proof',
        'rename-proof',
      ])
    } finally {
      input.admin(`
        DELETE FROM hub_note_acknowledgement WHERE note_id='${note}';
        DELETE FROM hub_note WHERE id='${note}';
        DELETE FROM hub_interval WHERE project_id='${project}';
        DELETE FROM hub_report_subscription_project WHERE subscription_id='${subscription}';
        DELETE FROM hub_report_subscription WHERE id='${subscription}';
        DELETE FROM hub_task_comment WHERE task_key='${task}';
        DELETE FROM hub_task_document WHERE task_key='${task}';
        DELETE FROM hub_task_status_event WHERE task_key='${task}';
        DELETE FROM hub_task WHERE key IN ('${task}','${task}-null','${task}-stay');
        DELETE FROM doc_revision WHERE doc_id IN ('${projectDoc}','${legacyProjectDoc}','${stackDoc}','${otherProjectDoc}');
        DELETE FROM doc WHERE id IN ('${projectDoc}','${legacyProjectDoc}','${stackDoc}','${otherProjectDoc}');
        DELETE FROM project WHERE id IN ('${project}','${other}');`)
    }
  })

  test('a move with a public doc space and an article doc leaves nothing in the source space', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('article move proof has no active source space')
    const destination = {
      id: newRecordId(),
      slug: `dev-1214-${newRecordId().slice(-8)}`,
    }
    const destinationMembership = newRecordId()
    const project = newRecordId()
    const subject = newRecordId()
    const article = newRecordId()
    try {
      input.admin(
        `INSERT INTO space (id,name,slug,created_at)
           VALUES ('${destination.id}','DEV 1214 Move','${destination.slug}',now());
         INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
           VALUES ('${destinationMembership}','${destination.id}','${input.userId()}',
             'owner','write',now());`,
      )
      const inserted = input.asSpace(
        input.actorRole,
        'actor-password',
        source,
        `INSERT INTO project (id,space_id,name,created_at) VALUES
         ('${project}','${source}','article-move',now());
       INSERT INTO subject (id,space_id,project_id,name,definition,position,created_at,updated_at)
         VALUES ('${subject}','${source}','${project}','Article','An article subject',0,now(),now());
       INSERT INTO doc
         (id,space_id,scope,subject,slug,title,body,delivery,audiences,featured,project_id,kind,
          article_subject_id,created_at,updated_at)
         VALUES ('${article}','${source}','project','article-move','article-move-doc','Article',
          'body','demand',ARRAY['technical'],false,'${project}','article','${subject}',now(),now());`,
      )
      expect(inserted.code, inserted.stderr).toBe(0)
      input.admin(
        `INSERT INTO public_doc_space (space_id, project_id) VALUES ('${source}','${project}');`,
      )
      const dry = await moveRecordProjectSpace({
        url: input.actorUrl,
        project: 'article-move',
        source,
        destination: destination.slug,
      })
      const moved = await moveRecordProjectSpace({
        url: input.actorUrl,
        project: 'article-move',
        source,
        destination: destination.slug,
        confirm: dry.total,
      })
      expect(moved.rows.filter((row) => row.moved).map((row) => row.tableName)).toEqual(
        expect.arrayContaining(['project', 'doc', 'subject']),
      )
      const leftover = input.admin(`
      SELECT count(*) FROM project WHERE id='${project}' AND space_id='${source}';
      SELECT count(*) FROM subject WHERE id='${subject}' AND space_id='${source}';
      SELECT count(*) FROM doc WHERE id='${article}' AND space_id='${source}';
      SELECT count(*) FROM public_doc_space WHERE project_id='${project}' AND space_id='${source}';
      SELECT count(*) FROM project WHERE id='${project}' AND space_id='${destination.id}';
      SELECT count(*) FROM subject WHERE id='${subject}' AND space_id='${destination.id}';
      SELECT count(*) FROM doc WHERE id='${article}' AND space_id='${destination.id}';
      SELECT count(*) FROM public_doc_space WHERE project_id='${project}' AND space_id='${destination.id}';`)
      expect(leftover.trim().split('\n')).toEqual(['0', '0', '0', '0', '1', '1', '1', '1'])
    } finally {
      input.admin(`
        DELETE FROM public_doc_space WHERE project_id='${project}';
        DELETE FROM doc WHERE id='${article}';
        DELETE FROM subject WHERE id='${subject}';
        DELETE FROM project WHERE id='${project}';
        DELETE FROM membership WHERE space_id='${destination.id}';
        DELETE FROM space WHERE id='${destination.id}';`)
    }
  })
}
