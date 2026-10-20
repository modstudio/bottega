import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { createRecordSpace, recordMemberships } from '../src/record/record-space.ts'
import { moveRecordProjectSpace } from '../src/record/record-space-move.ts'
import type { ProjectSpaceProofInput } from './postgres-project-space-proof.ts'

export function registerProjectSpaceDryRunProofs(input: ProjectSpaceProofInput): void {
  test('a dry run catches a partial expression document-address collision and rolls back', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('document collision proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1214 Document Collision',
      `dev-1214-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const destinationProject = newRecordId()
    const sourceDoc = newRecordId()
    const destinationDoc = newRecordId()
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at) VALUES
         ('${project}','${source}','doc-collision-proof',now()),
         ('${destinationProject}','${destination.id}','doc-collision-stay',now());
       INSERT INTO doc
         (id,space_id,scope,subject,slug,title,body,delivery,audiences,project_id,created_at,updated_at)
         VALUES
         ('${sourceDoc}','${source}','project','same-address','same-address','Source',
          'source','demand',ARRAY['technical'],'${project}',now(),now()),
         ('${destinationDoc}','${destination.id}','project','same-address','same-address','Destination',
          'destination','demand',ARRAY['technical'],'${destinationProject}',now(),now());`,
    )
    let message = ''
    try {
      await moveRecordProjectSpace({
        url: input.actorUrl,
        project: 'doc-collision-proof',
        source,
        destination: destination.slug,
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('dry-run trial hit a constraint')
    expect(message).toContain('table doc')
    expect(message).toContain('constraint doc_live_address')
    expect(message).toContain('Key (space_id, scope, COALESCE(subject')
    expect(
      input
        .admin(
          `SELECT space_id FROM project WHERE id='${project}';
           SELECT space_id FROM doc WHERE id='${sourceDoc}';
           SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relrowsecurity AND NOT c.relforcerowsecurity;`,
        )
        .trim()
        .split('\n'),
    ).toEqual([source, source, '0'])
  })

  test('a dry run catches a partial subject-name collision and rolls back', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('subject collision proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1214 Subject Collision',
      `dev-1214-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const sourceSubject = newRecordId()
    const destinationSubject = newRecordId()
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','subject-collision-proof',now());
       INSERT INTO subject(id,space_id,project_id,name,definition,position,created_at,updated_at)
         VALUES ('${sourceSubject}','${source}','${project}','same-name','source',0,now(),now());
       SET session_replication_role=replica;
       INSERT INTO subject(id,space_id,project_id,name,definition,position,created_at,updated_at)
         VALUES ('${destinationSubject}','${destination.id}','${project}','same-name','destination',0,now(),now());
       SET session_replication_role=origin;`,
    )
    let message = ''
    try {
      await moveRecordProjectSpace({
        url: input.actorUrl,
        project: 'subject-collision-proof',
        source,
        destination: destination.slug,
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('dry-run trial hit a constraint')
    expect(message).toContain('table subject')
    expect(message).toContain('constraint subject_live_name')
    expect(message).toContain('Key (space_id, project_id, name)')
    expect(
      input
        .admin(
          `SELECT space_id FROM project WHERE id='${project}';
           SELECT space_id FROM subject WHERE id='${sourceSubject}';
           SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relrowsecurity AND NOT c.relforcerowsecurity;`,
        )
        .trim()
        .split('\n'),
    ).toEqual([source, source, '0'])
  })

  test('a nullable unique key uses PostgreSQL NULLS DISTINCT semantics', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('nullable unique proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1214 Nullable Unique',
      `dev-1214-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const sourceInterval = newRecordId()
    const destinationInterval = newRecordId()
    input.admin(
      `CREATE UNIQUE INDEX dev_1214_nullable_unique ON hub_interval(space_id,agent);
       INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','nullable-unique-proof',now());
       INSERT INTO hub_interval
         (id,space_id,project_id,project_name,source,start_at,end_at,ref,updated_at)
         VALUES
         ('${sourceInterval}','${source}','${project}','nullable-unique-proof','proof',now(),now(),
          '${sourceInterval}',now()),
         ('${destinationInterval}','${destination.id}',NULL,'space-owned','proof',now(),now(),
          '${destinationInterval}',now());`,
    )
    try {
      const dry = await moveRecordProjectSpace({
        url: input.actorUrl,
        project: 'nullable-unique-proof',
        source,
        destination: destination.slug,
      })
      await moveRecordProjectSpace({
        url: input.actorUrl,
        project: 'nullable-unique-proof',
        source,
        destination: destination.slug,
        confirm: dry.total,
      })
      expect(
        input
          .admin(
            `SELECT space_id FROM project WHERE id='${project}';
             SELECT space_id FROM hub_interval WHERE id='${sourceInterval}';`,
          )
          .trim()
          .split('\n'),
      ).toEqual([destination.id, destination.id])
    } finally {
      input.admin('DROP INDEX IF EXISTS dev_1214_nullable_unique;')
    }
  })
}
