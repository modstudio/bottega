import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { createRecordSpace, recordMemberships } from '../src/record/record-space.ts'
import { moveRecordProjectSpace } from '../src/record/record-space-move.ts'
import type { ProjectSpaceProofInput } from './postgres-project-space-proof.ts'

export function registerProjectSpacePinProofs(input: ProjectSpaceProofInput): void {
  test('live and historical pins remap to matching destination version ids', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('pin remap proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1991 Pin Remap',
      `dev-1991-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const sourceProfile = newRecordId()
    const destinationProfile = newRecordId()
    const sourceRevision = newRecordId()
    const destinationRevision = newRecordId()
    const selection = newRecordId()
    const selectionRevision = newRecordId()
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','pin-remap-proof',now());
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,current_version_id,body,enabled,updated_at)
         SELECT '${sourceProfile}','${source}',id,'architecture','pin-remap',2,
           '${sourceProfile}','{"guidance":"current"}',true,now() FROM lens
         WHERE space_id='${source}' ORDER BY key LIMIT 1;
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,current_version_id,body,enabled,updated_at)
         SELECT '${destinationProfile}','${destination.id}',id,'architecture','pin-remap',2,
           '${destinationProfile}','{"guidance":"current"}',true,now() FROM lens
         WHERE space_id='${destination.id}' ORDER BY key LIMIT 1;
       INSERT INTO lens_profile_revision(id,space_id,profile_id,version,prior_body,reason,at) VALUES
         ('${sourceRevision}','${source}','${sourceProfile}',1,
          '{"body":{"guidance":"prior"},"enabled":true}','proof',now()),
         ('${destinationRevision}','${destination.id}','${destinationProfile}',1,
          '{"body":{"guidance":"prior"},"enabled":true}','proof',now());
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version_id,selection_version,updated_at)
         SELECT '${selection}','${source}','${project}',id,'architecture','pin-remap','${sourceRevision}',1,now()
         FROM lens WHERE space_id='${source}' ORDER BY key LIMIT 1;
       INSERT INTO project_lens_profile_revision
         (id,space_id,selection_id,prior_profile_name,prior_selected_version_id,reason,at)
         VALUES ('${selectionRevision}','${source}','${selection}','pin-remap','${sourceProfile}',
           'proof',now());`,
    )
    const dry = await moveRecordProjectSpace({
      url: input.actorUrl,
      project: 'pin-remap-proof',
      source,
      destination: destination.slug,
    })
    await moveRecordProjectSpace({
      url: input.actorUrl,
      project: 'pin-remap-proof',
      source,
      destination: destination.slug,
      confirm: dry.total,
    })
    expect(
      input
        .admin(
          `SELECT selected_version_id FROM project_lens_profile WHERE id='${selection}';
           SELECT prior_selected_version_id FROM project_lens_profile_revision
             WHERE id='${selectionRevision}';`,
        )
        .trim()
        .split('\n'),
    ).toEqual([destinationRevision, destinationProfile])
  })

  test('a historical pin refuses when no matching destination version resolves', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('historical pin refusal proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1991 Historical Pin Refusal',
      `dev-1991-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId()
    const sourceProfile = newRecordId()
    const destinationProfile = newRecordId()
    const sourceRevision = newRecordId()
    const selection = newRecordId()
    const selectionRevision = newRecordId()
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','historical-pin-refusal',now());
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,current_version_id,body,enabled,updated_at)
         SELECT '${sourceProfile}','${source}',id,'architecture','historical-missing',2,
           '${sourceProfile}','{"guidance":"current"}',true,now() FROM lens
         WHERE space_id='${source}' ORDER BY key LIMIT 1;
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,current_version_id,body,enabled,updated_at)
         SELECT '${destinationProfile}','${destination.id}',id,'architecture','historical-missing',2,
           '${destinationProfile}','{"guidance":"current"}',true,now() FROM lens
         WHERE space_id='${destination.id}' ORDER BY key LIMIT 1;
       INSERT INTO lens_profile_revision(id,space_id,profile_id,version,prior_body,reason,at)
         VALUES ('${sourceRevision}','${source}','${sourceProfile}',1,
          '{"body":{"guidance":"prior"},"enabled":true}','proof',now());
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version_id,selection_version,updated_at)
         SELECT '${selection}','${source}','${project}',id,'architecture','historical-missing',NULL,1,now()
         FROM lens WHERE space_id='${source}' ORDER BY key LIMIT 1;
       INSERT INTO project_lens_profile_revision
         (id,space_id,selection_id,prior_profile_name,prior_selected_version_id,reason,at)
         VALUES ('${selectionRevision}','${source}','${selection}','historical-missing','${sourceRevision}',
           'proof',now());`,
    )
    await expect(
      moveRecordProjectSpace({
        url: input.actorUrl,
        project: 'historical-pin-refusal',
        source,
        destination: destination.slug,
      }),
    ).rejects.toThrow(
      `project historical-pin-refusal cannot move from space ${source} to space ${destination.id} because historical lens profile pins have no matching version in the destination: correctness/architecture/historical-missing version 1; reconcile the destination profiles, then retry`,
    )
    expect(input.admin(`SELECT space_id FROM project WHERE id='${project}';`).trim()).toBe(source)
  })
}
