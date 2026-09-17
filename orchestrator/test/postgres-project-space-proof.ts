import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { createRecordSpace, recordMemberships } from '../src/record/record-space.ts'
import { moveRecordProjectSpace } from '../src/record/record-space-move.ts'
import { proveProjectSpaceRecordSync } from './postgres-score-proof.ts'

type PsqlResult = { code: number; stdout: string; stderr: string }

export function registerProjectSpaceProofs(input: {
  actorUrl: string
  actorRole: string
  machineId: string
  userId: string
  firstSpaceId: string
  secondSpaceId: string
  otherRunId: string
  token: () => string
  setToken(token: string): void
  asSpace(user: string, password: string, spaceId: string, statement: string): PsqlResult
  admin(statement: string): string
}): void {
  test('space creation grants ownership and duplicate slug names the existing id', async () => {
    input.setToken(input.token())
    const created = await createRecordSpace(input.actorUrl, 'DEV 741 Team', 'dev-741-team')
    expect(created.slug).toBe('dev-741-team')
    expect((await recordMemberships(input.actorUrl)).memberships).toContainEqual(
      expect.objectContaining({
        spaceId: created.id,
        slug: created.slug,
        role: 'owner',
        permission: 'write',
      }),
    )
    await expect(createRecordSpace(input.actorUrl, 'Duplicate', created.slug)).rejects.toThrow(
      `record space slug ${created.slug} already exists: ${created.id}`,
    )
  })

  test('two projects sync into separate spaces and remain tenant-confined', async () => {
    const ids = await proveProjectSpaceRecordSync({
      actorUrl: input.actorUrl,
      actorRole: input.actorRole,
      machineId: input.machineId,
      userId: input.userId,
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

  test('project rows move together while another source project and space aggregates stay', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships(input.actorUrl)).activeSpaceId
    if (!source) throw new Error('move proof has no active source space')
    const destination = await createRecordSpace(
      input.actorUrl,
      'DEV 747 Move',
      `dev-747-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const otherProject = newRecordId()
    const run = newRecordId()
    const otherRun = newRecordId()
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
         VALUES ('${newRecordId()}','${source}','2099-07-47',now(),now());`,
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
       SELECT count(*) FROM hub_day WHERE day='2099-07-47';`,
    )
    expect(sourceFacts.code, sourceFacts.stderr).toBe(0)
    expect(sourceFacts.stdout.split('\n')).toEqual(['0', '0', '0', '1', '1', '1'])
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
    const source = (await recordMemberships(input.actorUrl)).activeSpaceId
    if (!source) throw new Error('move proof has no active source space')
    const destination = await createRecordSpace(
      input.actorUrl,
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
}
