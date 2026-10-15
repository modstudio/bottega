import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { upsertRecordProject } from '../src/record/record-projects.ts'
import {
  createRecordSpace,
  recordMemberships,
  switchRecordSpace,
} from '../src/record/record-space.ts'
import { moveRecordProjectSpace } from '../src/record/record-space-move.ts'
import { proveProjectSpaceRecordSync, SYNC_PROOF_MACHINE } from './postgres-score-proof.ts'
import { registerHostedSyncAuthorizationProofs } from './postgres-sync-authorization-proof.ts'

type PsqlResult = { code: number; stdout: string; stderr: string }

export function registerProjectSpaceProofs(input: {
  actorUrl: string
  actorRole: string
  machineId: string
  userId: () => string
  firstSpaceId: string
  secondSpaceId: string
  otherRunId: string
  token: (user?: 'a' | 'b') => string
  setToken(token: string): void
  asSpace(user: string, password: string, spaceId: string, statement: string): PsqlResult
  admin(statement: string): string
}): void {
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
      secondSpaceId: input.secondSpaceId,
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
         (id,space_id,project_id,machine_id,local_id,started_at,agent,job,prompt_sha,
          prompt_bytes,prompt_head,probe,status,turn,no_failover,automatic_failover,
          work_preserved,created_at,updated_at) VALUES
         ('${run}','${source}','${project}','${input.machineId}',7101,now(),'proof','proof','m',1,'m',false,'ok',1,false,false,false,now(),now()),
         ('${otherRun}','${source}','${otherProject}','${input.machineId}',7102,now(),'proof','proof','s',1,'s',false,'ok',1,false,false,false,now(),now());
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
       SELECT count(*) FROM project WHERE id='${otherProject}';
       SELECT count(*) FROM run WHERE id='${otherRun}';
       SELECT count(*) FROM hub_day WHERE day='2099-07-47';
       SELECT count(*) FROM hub_send WHERE id='${send}';
       SELECT count(*) FROM hub_send_recipient WHERE id='${sendRecipient}';`,
    )
    expect(sourceFacts.code, sourceFacts.stderr).toBe(0)
    expect(sourceFacts.stdout.split('\n')).toEqual(['0', '0', '0', '1', '1', '1', '1', '1'])
    const destinationFacts = input.asSpace(
      input.actorRole,
      'actor-password',
      destination.id,
      `SELECT count(*) FROM project WHERE id='${project}';
       SELECT count(*) FROM run WHERE id='${run}';
       SELECT count(*) FROM hub_task WHERE key='${task}';
       SELECT count(*) FROM seq WHERE project_id='${project}';`,
    )
    expect(destinationFacts.code, destinationFacts.stderr).toBe(0)
    expect(destinationFacts.stdout.split('\n')).toEqual(['1', '1', '1', '1'])

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
         (id,space_id,project_id,machine_id,local_id,started_at,agent,job,prompt_sha,prompt_bytes,
          prompt_head,probe,status,turn,no_failover,automatic_failover,work_preserved,created_at,updated_at)
         VALUES ('${run}','${source}','${project}','${input.machineId}',7201,now(),'proof','proof','a',1,'a',false,'ok',1,false,false,false,now(),now());
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

  test('a hosted rename leaves no hub row naming the old project', async () => {
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
        url: input.actorUrl,
        userId: input.userId(),
        spaceId: space,
        previousName: 'rename-proof',
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
        '0',
        '1',
        'renamed-proof',
        'renamed-proof',
        'renamed-proof',
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
    const destination = await createRecordSpace(
      'DEV 1214 Move',
      `dev-1214-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const subject = newRecordId()
    const article = newRecordId()
    try {
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
      await switchRecordSpace(source)
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
