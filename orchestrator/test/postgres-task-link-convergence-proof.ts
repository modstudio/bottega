import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type PsqlResult = { code: number; stdout: string; stderr: string }

const ids = {
  existingTask: '01990000-0000-7000-8000-000000001773',
  liveTask: '01990000-0000-7000-8000-000000001774',
  deletedTask: '01990000-0000-7000-8000-000000001775',
  otherSpaceTask: '01990000-0000-7000-8000-000000001776',
  question: '01990000-0000-7000-8000-000000001777',
  linkedQuestion: '01990000-0000-7000-8000-000000001778',
  deletedQuestion: '01990000-0000-7000-8000-000000001779',
  otherSpaceQuestion: '01990000-0000-7000-8000-00000000177a',
  run: '01990000-0000-7000-8000-00000000177b',
  email: '01990000-0000-7000-8000-00000000177c',
  backfillTask: '01990000-0000-7000-8000-00000000177d',
  backfillQuestion: '01990000-0000-7000-8000-00000000177e',
  backfillRun: '01990000-0000-7000-8000-00000000177f',
  backfillEmail: '01990000-0000-7000-8000-000000001780',
} as const

const backfillSql = readFileSync(
  join(
    import.meta.dir,
    '..',
    '..',
    'shared',
    'record',
    'migrations',
    '20261026111127_dev_1773_task_link_backfill',
    'migration.sql',
  ),
  'utf8',
)

export function registerHostedTaskLinkConvergenceProof(
  input: () => {
    actorRole: string
    spaceId: string
    otherSpaceId: string
    projectName: string
    projectId: string
    machineId: string
    userId: string
    asSpace: (user: string, password: string, spaceId: string, statement: string) => PsqlResult
    admin: (statement: string) => string
  },
): void {
  test('a live hosted task links same-space rows without overwriting an existing link', () => {
    const fixture = input()
    const result = fixture.asSpace(
      fixture.actorRole,
      'actor-password',
      fixture.spaceId,
      `INSERT INTO hub_task
        (id,space_id,project_name,project_id,key,project,title,status,status_category,source,
         first_seen,last_seen,created_at,updated_at)
       VALUES
        ('${ids.existingTask}','${fixture.spaceId}','${fixture.projectName}','${fixture.projectId}',
         'DEV-1773-EXISTING','${fixture.projectName}','existing','active','active','local',now(),now(),now(),now());
       INSERT INTO question
        (id,space_id,workflow_key,workflow_task_id,machine_id,revision,asked_at,question,
         withheld_fields,created_at,updated_at)
       VALUES
        ('${ids.question}','${fixture.spaceId}','DEV-1773-LIVE',NULL,'${fixture.machineId}',1,now(),'link?',
         '[]'::jsonb,now(),now()),
        ('${ids.linkedQuestion}','${fixture.spaceId}','DEV-1773-LIVE','${ids.existingTask}',
         '${fixture.machineId}',1,now(),'preserve?','[]'::jsonb,now(),now()),
        ('${ids.deletedQuestion}','${fixture.spaceId}','DEV-1773-DELETED',NULL,'${fixture.machineId}',1,now(),
         'deleted?','[]'::jsonb,now(),now()),
        ('${ids.otherSpaceQuestion}','${fixture.spaceId}','DEV-1773-OTHER-SPACE',NULL,'${fixture.machineId}',1,
         now(),'other space?','[]'::jsonb,now(),now());
       INSERT INTO run
        (id,space_id,project_id,machine_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,
         task_key,probe,status,turn,no_failover,automatic_failover,work_preserved,created_at,updated_at)
       VALUES
        ('${ids.run}','${fixture.spaceId}','${fixture.projectId}','${fixture.machineId}',now(),'proof','proof',
         'sha',1,'proof','DEV-1773-LIVE',false,'ok',1,false,false,false,now(),now());
       INSERT INTO operator_waiting_email
        (id,space_id,user_id,kind,item_id,item_record_id,episode,project,task_key,question,options,
         waiting_since,link,status,attempts,created_at,updated_at)
       VALUES
        ('${ids.email}','${fixture.spaceId}','${fixture.userId}','question',1773,'${ids.question}',
         'proof','${fixture.projectName}','DEV-1773-LIVE','link?','[]'::jsonb,now(),'http://localhost',
         'intent',1,now(),now());
       INSERT INTO hub_task
        (id,space_id,project_name,project_id,key,project,title,status,status_category,source,
         first_seen,last_seen,created_at,updated_at,deleted_at)
       VALUES
        ('${ids.liveTask}','${fixture.spaceId}','${fixture.projectName}','${fixture.projectId}',
         'DEV-1773-LIVE','${fixture.projectName}','live','active','active','local',now(),now(),now(),now(),NULL),
        ('${ids.deletedTask}','${fixture.spaceId}','${fixture.projectName}','${fixture.projectId}',
         'DEV-1773-DELETED','${fixture.projectName}','deleted','done','done','local',now(),now(),now(),now(),now());
       SELECT concat_ws(',',
         (SELECT workflow_task_id FROM question WHERE id='${ids.question}'),
         (SELECT task_id FROM run WHERE id='${ids.run}'),
         (SELECT task_id FROM operator_waiting_email WHERE id='${ids.email}'),
         (SELECT workflow_task_id FROM question WHERE id='${ids.linkedQuestion}'),
         coalesce((SELECT workflow_task_id::text FROM question WHERE id='${ids.deletedQuestion}'),'null'));
      `,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe(
      [ids.liveTask, ids.liveTask, ids.liveTask, ids.existingTask, 'null'].join(','),
    )

    fixture.admin(`INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,status,status_category,source,
       first_seen,last_seen,created_at,updated_at)
      VALUES ('${ids.otherSpaceTask}','${fixture.otherSpaceId}','other','DEV-1773-OTHER-SPACE',
        'other','other space','active','active','local',now(),now(),now(),now());`)
    const otherSpace = fixture.asSpace(
      fixture.actorRole,
      'actor-password',
      fixture.spaceId,
      `SELECT coalesce(workflow_task_id::text,'null') FROM question
       WHERE id='${ids.otherSpaceQuestion}';`,
    )
    expect(otherSpace.code, otherSpace.stderr).toBe(0)
    expect(otherSpace.stdout).toBe('null')
  })

  test('the hosted task-link backfill links all three row kinds', () => {
    const fixture = input()
    fixture.admin(`ALTER TABLE hub_task DISABLE TRIGGER hub_task_link_references;
      INSERT INTO hub_task
       (id,space_id,project_name,project_id,key,project,title,status,status_category,source,
        first_seen,last_seen,created_at,updated_at)
      VALUES ('${ids.backfillTask}','${fixture.spaceId}','${fixture.projectName}','${fixture.projectId}',
       'DEV-1773-BACKFILL','${fixture.projectName}','backfill','active','active','local',now(),now(),now(),now());
      ALTER TABLE hub_task ENABLE TRIGGER hub_task_link_references;
      INSERT INTO question
       (id,space_id,workflow_key,machine_id,revision,asked_at,question,withheld_fields,created_at,updated_at)
      VALUES ('${ids.backfillQuestion}','${fixture.spaceId}','DEV-1773-BACKFILL','${fixture.machineId}',1,
       now(),'backfill?','[]'::jsonb,now(),now());
      INSERT INTO run
       (id,space_id,project_id,machine_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,
        task_key,probe,status,turn,no_failover,automatic_failover,work_preserved,created_at,updated_at)
      VALUES ('${ids.backfillRun}','${fixture.spaceId}','${fixture.projectId}','${fixture.machineId}',now(),
       'proof','proof','sha',1,'proof','DEV-1773-BACKFILL',false,'ok',1,false,false,false,now(),now());
      INSERT INTO operator_waiting_email
       (id,space_id,user_id,kind,item_id,item_record_id,episode,project,task_key,question,options,
        waiting_since,link,status,attempts,created_at,updated_at)
      VALUES ('${ids.backfillEmail}','${fixture.spaceId}','${fixture.userId}','workflow',1773,
       '${ids.backfillRun}','backfill','${fixture.projectName}','DEV-1773-BACKFILL','backfill?',
       '[]'::jsonb,now(),'http://localhost','intent',1,now(),now());`)
    fixture.admin(backfillSql)

    const result = fixture.asSpace(
      fixture.actorRole,
      'actor-password',
      fixture.spaceId,
      `SELECT concat_ws(',',
        (SELECT workflow_task_id FROM question WHERE id='${ids.backfillQuestion}'),
        (SELECT task_id FROM run WHERE id='${ids.backfillRun}'),
        (SELECT task_id FROM operator_waiting_email WHERE id='${ids.backfillEmail}'));`,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe([ids.backfillTask, ids.backfillTask, ids.backfillTask].join(','))
  })
}
