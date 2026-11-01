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

  test('a dangling live pin refuses both dry-run and confirmed moves', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('dangling live pin proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1991 Dangling Live Pin',
      `dev-1991-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId(),
      profile = newRecordId(),
      selection = newRecordId(),
      dangling = newRecordId()
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','dangling-live-pin',now());
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,current_version_id,body,enabled,updated_at)
         SELECT '${profile}','${source}',id,'architecture','dangling-live',1,
           '${profile}','{"guidance":"current"}',true,now() FROM lens
         WHERE space_id='${source}' ORDER BY key LIMIT 1;
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version_id,selection_version,updated_at)
         SELECT '${selection}','${source}','${project}',id,'architecture','dangling-live','${dangling}',1,now()
         FROM lens WHERE space_id='${source}' ORDER BY key LIMIT 1;`,
    )
    for (const confirm of [undefined, 0])
      await expect(
        moveRecordProjectSpace({
          url: input.actorUrl,
          project: 'dangling-live-pin',
          source,
          destination: destination.slug,
          confirm,
        }),
      ).rejects.toThrow('project lens profile pinned-version conflict:')
    expect(input.admin(`SELECT space_id FROM project WHERE id='${project}';`).trim()).toBe(source)
  })

  test('a selection without a source profile survives the move', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('missing source profile proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1991 Missing Source Profile',
      `dev-1991-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId(),
      selection = newRecordId()
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','missing-source-profile',now());
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version_id,selection_version,updated_at)
         SELECT '${selection}','${source}','${project}',id,'architecture','does-not-exist',NULL,1,now()
         FROM lens WHERE space_id='${source}' ORDER BY key LIMIT 1;`,
    )
    const sourceLensKey = input
      .admin(
        `SELECT l.key FROM project_lens_profile s JOIN lens l ON l.id=s.lens_id WHERE s.id='${selection}';`,
      )
      .trim()
    const dry = await moveRecordProjectSpace({
      url: input.actorUrl,
      project: 'missing-source-profile',
      source,
      destination: destination.slug,
    })
    await moveRecordProjectSpace({
      url: input.actorUrl,
      project: 'missing-source-profile',
      source,
      destination: destination.slug,
      confirm: dry.total,
    })
    expect(
      input
        .admin(
          `SELECT s.space_id || ':' || l.space_id || ':' || l.key || ':' || s.profile_name
           FROM project_lens_profile s JOIN lens l ON l.id=s.lens_id WHERE s.id='${selection}';`,
        )
        .trim(),
    ).toBe(`${destination.id}:${destination.id}:${sourceLensKey}:does-not-exist`)
  })

  test('a lens-scoped selection refuses when its lens key is absent from the destination', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('missing destination lens proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1991 Missing Destination Lens',
      `dev-1991-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId(),
      selection = newRecordId(),
      sourceLens = newRecordId()
    input.admin(
      `INSERT INTO lens(id,space_id,key,title,question,excludes,slots,version,enabled,requires_execution,updated_at)
         VALUES ('${sourceLens}','${source}','dev-1991-source-only','Source only','Question','Excludes','Slots',1,true,false,now());
       INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','missing-destination-lens',now());
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version_id,selection_version,updated_at)
         VALUES ('${selection}','${source}','${project}','${sourceLens}','architecture','does-not-exist',NULL,1,now());`,
    )
    for (const confirm of [undefined, 0])
      await expect(
        moveRecordProjectSpace({
          url: input.actorUrl,
          project: 'missing-destination-lens',
          source,
          destination: destination.slug,
          confirm,
        }),
      ).rejects.toThrow('because destination lenses are missing for selected profiles:')
    expect(input.admin(`SELECT space_id FROM project WHERE id='${project}';`).trim()).toBe(source)
  })

  test('a pinned selection without a source profile refuses the move', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('pinned missing source profile proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1991 Pinned Missing Source Profile',
      `dev-1991-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId(),
      selection = newRecordId(),
      missingVersion = newRecordId()
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','pinned-missing-source-profile',now());
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version_id,selection_version,updated_at)
         SELECT '${selection}','${source}','${project}',id,'architecture','does-not-exist','${missingVersion}',1,now()
         FROM lens WHERE space_id='${source}' ORDER BY key LIMIT 1;`,
    )
    for (const confirm of [undefined, 0])
      await expect(
        moveRecordProjectSpace({
          url: input.actorUrl,
          project: 'pinned-missing-source-profile',
          source,
          destination: destination.slug,
          confirm,
        }),
      ).rejects.toThrow('project lens profile pinned-version conflict:')
    expect(input.admin(`SELECT space_id FROM project WHERE id='${project}';`).trim()).toBe(source)
  })

  test('an axis-level selection and its revision move exactly once across matching profiles', async () => {
    input.setToken(input.token())
    const source = (await recordMemberships()).activeSpaceId
    if (!source) throw new Error('axis-level pin proof has no active source space')
    const destination = await createRecordSpace(
      'DEV 1991 Axis Pin',
      `dev-1991-${newRecordId().slice(-8)}`,
    )
    const project = newRecordId(),
      sourceProfileA = newRecordId(),
      sourceProfileB = newRecordId(),
      destinationProfileA = newRecordId(),
      destinationProfileB = newRecordId(),
      sourceRevision = newRecordId(),
      destinationRevision = newRecordId(),
      selection = newRecordId(),
      selectionRevision = newRecordId()
    input.admin(
      `INSERT INTO project(id,space_id,name,created_at)
         VALUES ('${project}','${source}','axis-pin-proof',now());
       WITH picked AS (
         SELECT id,row_number() OVER (ORDER BY key) n FROM lens WHERE space_id='${source}' LIMIT 2
       )
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,current_version_id,body,enabled,updated_at)
         SELECT CASE n WHEN 1 THEN '${sourceProfileA}'::uuid ELSE '${sourceProfileB}'::uuid END,
           '${source}',id,'architecture','axis-shared',2,
           CASE n WHEN 1 THEN '${sourceProfileA}'::uuid ELSE '${sourceProfileB}'::uuid END,
           '{"guidance":"current"}',true,now() FROM picked;
       WITH picked AS (
         SELECT id,row_number() OVER (ORDER BY key) n FROM lens WHERE space_id='${destination.id}' LIMIT 2
       )
       INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,current_version_id,body,enabled,updated_at)
         SELECT CASE n WHEN 1 THEN '${destinationProfileA}'::uuid ELSE '${destinationProfileB}'::uuid END,
           '${destination.id}',id,'architecture','axis-shared',2,
           CASE n WHEN 1 THEN '${destinationProfileA}'::uuid ELSE '${destinationProfileB}'::uuid END,
           '{"guidance":"current"}',true,now() FROM picked;
       INSERT INTO lens_profile_revision(id,space_id,profile_id,version,prior_body,reason,at) VALUES
         ('${sourceRevision}','${source}','${sourceProfileA}',1,
          '{"body":{"guidance":"prior"},"enabled":true}','proof',now()),
         ('${destinationRevision}','${destination.id}','${destinationProfileA}',1,
          '{"body":{"guidance":"prior"},"enabled":true}','proof',now());
       INSERT INTO project_lens_profile
         (id,space_id,project_id,lens_id,axis,profile_name,selected_version_id,selection_version,updated_at)
         VALUES ('${selection}','${source}','${project}',NULL,'architecture','axis-shared','${sourceRevision}',1,now());
       INSERT INTO project_lens_profile_revision
         (id,space_id,selection_id,prior_profile_name,prior_selected_version_id,reason,at)
         VALUES ('${selectionRevision}','${source}','${selection}','axis-shared','${sourceProfileB}','proof',now());`,
    )
    const dry = await moveRecordProjectSpace({
      url: input.actorUrl,
      project: 'axis-pin-proof',
      source,
      destination: destination.slug,
    })
    await moveRecordProjectSpace({
      url: input.actorUrl,
      project: 'axis-pin-proof',
      source,
      destination: destination.slug,
      confirm: dry.total,
    })
    expect(
      input
        .admin(
          `SELECT count(*) || ':' || min(selected_version_id::text) FROM project_lens_profile WHERE id='${selection}';
           SELECT count(*) || ':' || min(prior_selected_version_id::text) FROM project_lens_profile_revision WHERE id='${selectionRevision}';`,
        )
        .trim()
        .split('\n'),
    ).toEqual([`1:${destinationRevision}`, `1:${destinationProfileB}`])
  })
}
