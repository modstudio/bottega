import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db, sessionId } from '../database/db.ts'
import { applyMigrations } from '../database/migrations.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberProjectSpace } from '../project-space.ts'
import {
  chooseLensProfile,
  hostedLensComplete,
  listLenses,
  resolveLens,
  selectProjectProfile,
  setLens,
  setProfile,
} from './lenses.ts'

describe('lens catalogue', () => {
  test('six seeded cores render their default profile for every registered project', () => {
    upsertProject({ recordId: newRecordId(), name: 'one', path: '/tmp/one', settings: {} })
    upsertProject({ recordId: newRecordId(), name: 'two', path: '/tmp/two', settings: {} })
    expect(listLenses().map((x) => x.id)).toEqual([
      'correctness',
      'craft',
      'issue-blast-radius',
      'migration-safety',
      'safety',
      'teardown-safety',
    ])
    for (const lens of listLenses())
      for (const project of ['one', 'two']) {
        const resolved = resolveLens(lens.id, project)!
        expect(resolved.profiles).toEqual([
          { axis: 'framework', name: 'default', version: 1, source: 'generic' },
        ])
        expect(resolved.body).toBe(
          'FRAMEWORK GUIDANCE\nNo framework-specific guidance for this stack.\n\nCOMMANDS\nNone.',
        )
      }
  })

  test('profile choice follows lens selection, axis selection, stack, then generic', () => {
    const base = { enabledProfileNames: ['default', 'node'], stack: 'node' }
    expect(chooseLensProfile({ ...base, lensSelection: null, axisSelection: null })).toEqual({
      name: 'node',
      version: null,
      source: 'stack',
    })
    expect(
      chooseLensProfile({
        ...base,
        lensSelection: null,
        axisSelection: { name: 'shared', version: 2 },
      }),
    ).toEqual({ name: 'shared', version: 2, source: 'project' })
    expect(
      chooseLensProfile({
        ...base,
        lensSelection: { name: 'specific', version: 3 },
        axisSelection: { name: 'shared', version: 2 },
      }),
    ).toEqual({ name: 'specific', version: 3, source: 'project' })
    expect(
      chooseLensProfile({
        ...base,
        lensSelection: null,
        axisSelection: null,
        enabledProfileNames: ['default'],
      }),
    ).toEqual({ name: 'default', version: null, source: 'generic' })
  })

  test('an enabled stack profile wins while a disabled one falls through to generic', async () => {
    upsertProject({
      recordId: newRecordId(),
      name: 'stacked',
      path: '/tmp/stacked',
      stack: 'node',
      settings: {},
    })
    await setProfile({
      lensId: 'correctness',
      axis: 'framework',
      name: 'node',
      body: '{"framework_guidance":"Node.","commands":"bun test"}',
      enabled: true,
      reason: 'stack fixture',
    })
    expect(resolveLens('correctness', 'stacked')).toMatchObject({
      profiles: [{ name: 'node', source: 'stack' }],
      body: expect.stringContaining('FRAMEWORK GUIDANCE\nNode.'),
    })
    await setProfile({
      lensId: 'correctness',
      axis: 'framework',
      name: 'node',
      body: '{"framework_guidance":"Node.","commands":"bun test"}',
      enabled: false,
      reason: 'disable stack fixture',
    })
    expect(resolveLens('correctness', 'stacked')!.profiles[0]).toMatchObject({
      name: 'default',
      source: 'generic',
    })
  })

  test('renders declared slots in schema order and omits empty sections', async () => {
    await setLens({
      id: 'custom-sections',
      title: 'Custom sections',
      question: 'What does it find?',
      excludes: 'Everything else.',
      slots: JSON.stringify({
        type: 'object',
        properties: { looks_for: { type: 'string' }, empty_slot: { type: 'string' } },
        additionalProperties: false,
      }),
      enabled: true,
      requiresExecution: false,
      reason: 'custom section fixture',
    })
    await setProfile({
      lensId: 'custom-sections',
      axis: 'framework',
      name: 'default',
      body: '{"looks_for":"Boundary leaks.","empty_slot":""}',
      enabled: true,
      reason: 'custom section fixture',
    })
    expect(resolveLens('custom-sections', null)!.body).toBe('LOOKS FOR\nBoundary leaks.')
    for (const row of db()
      .query<{ record_id: string }, []>(
        "SELECT record_id FROM lens WHERE id='custom-sections' UNION ALL SELECT record_id FROM lens_profile WHERE lens_id='custom-sections'",
      )
      .all()) {
      expect(row.record_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    }
  })

  test('profile validation refuses undeclared slots and project selection binds one shared row', async () => {
    upsertProject({ recordId: newRecordId(), name: 'one', path: '/tmp/one', settings: {} })
    upsertProject({ recordId: newRecordId(), name: 'two', path: '/tmp/two', settings: {} })
    await expect(
      setProfile({
        lensId: 'correctness',
        axis: 'framework',
        name: 'node',
        body: '{"not_declared":"x"}',
        enabled: true,
        reason: 'test',
      }),
    ).rejects.toThrow('undeclared slot')
    await setProfile({
      lensId: 'correctness',
      axis: 'framework',
      name: 'node',
      body: '{"framework_guidance":"Node.","commands":"bun test"}',
      enabled: true,
      reason: 'test',
    })
    await selectProjectProfile({
      project: 'one',
      axis: 'framework',
      name: 'node',
      lensId: 'correctness',
      reason: 'test',
    })
    expect(
      db()
        .query(`SELECT prior_profile_name,prior_selected_version,reason,session_id,at
      FROM project_lens_profile_revision WHERE reason='test'`)
        .get(),
    ).toEqual({
      prior_profile_name: null,
      prior_selected_version: null,
      reason: 'test',
      session_id: sessionId(),
      at: expect.any(String),
    })
    await selectProjectProfile({
      project: 'two',
      axis: 'framework',
      name: 'node',
      lensId: 'correctness',
      reason: 'test',
    })
    expect(
      db()
        .query("SELECT COUNT(*) n FROM lens_profile WHERE lens_id='correctness' AND name='node'")
        .get(),
    ).toEqual({ n: 1 })
    expect(resolveLens('correctness', 'one')!.body).toContain('Node.\n\nCOMMANDS\nbun test')
    expect(resolveLens('correctness', 'two')!.profiles[0]).toMatchObject({
      name: 'node',
      source: 'project',
    })
    await selectProjectProfile({
      project: 'one',
      axis: 'framework',
      name: 'default',
      lensId: 'correctness',
      version: 1,
      reason: 'return to baseline',
    })
    expect(
      db()
        .query(
          `SELECT prior_profile_name,prior_selected_version,reason FROM project_lens_profile_revision WHERE reason='return to baseline'`,
        )
        .get(),
    ).toEqual({
      prior_profile_name: 'node',
      prior_selected_version: null,
      reason: 'return to baseline',
    })
  })

  test('a project routed to a hosted space without the lens keeps its local catalogue body', async () => {
    upsertProject({ recordId: newRecordId(), name: 'routed', path: '/tmp/routed', settings: {} })
    await setProfile({
      lensId: 'correctness',
      axis: 'framework',
      name: 'routed-body',
      body: '{"framework_guidance":"Routed.","commands":"bun test"}',
      enabled: true,
      reason: 'test',
    })
    await selectProjectProfile({
      project: 'routed',
      axis: 'framework',
      name: 'routed-body',
      lensId: 'correctness',
      reason: 'test',
    })
    rememberProjectSpace(db(), 'routed', newRecordId())
    expect(resolveLens('correctness', 'routed')!.profiles[0]).toMatchObject({
      name: 'routed-body',
      source: 'project',
    })
  })

  test('a project routed to a hosted space that holds the lens resolves the hosted copy', async () => {
    const projectRecordId = newRecordId()
    upsertProject({ recordId: projectRecordId, name: 'hosted', path: '/tmp/hosted', settings: {} })
    await selectProjectProfile({
      project: 'hosted',
      axis: 'framework',
      name: 'default',
      lensId: 'correctness',
      reason: 'test',
    })
    const space = newRecordId()
    db()
      .query(
        `INSERT INTO lens (record_id,space_id,id,title,question,excludes,slots,version,enabled,requires_execution)
         SELECT ?,?,id,title,'Hosted question?',excludes,slots,version,enabled,requires_execution
         FROM lens WHERE id='correctness' AND space_id IS NULL`,
      )
      .run(newRecordId(), space)
    rememberProjectSpace(db(), 'hosted', space)
    expect(resolveLens('correctness', 'hosted')!.question).not.toBe('Hosted question?')
    const local = db()
      .query(
        "SELECT lens_id,axis,name,version,body,enabled FROM lens_profile WHERE lens_id='correctness' AND enabled=1 AND space_id IS NULL",
      )
      .all() as {
      lens_id: string
      axis: string
      name: string
      version: number
      body: string
      enabled: number
    }[]
    for (const row of local)
      db()
        .query(
          'INSERT INTO lens_profile (lens_id,axis,name,version,body,enabled,record_id,space_id) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          row.lens_id,
          row.axis,
          row.name,
          row.version,
          row.body,
          row.enabled,
          newRecordId(),
          space,
        )
    // Core and profiles are hosted, but the project's selection is not: still local.
    expect(resolveLens('correctness', 'hosted')!.question).not.toBe('Hosted question?')
    db()
      .query(
        `INSERT INTO project_lens_profile (record_id,space_id,project_record_id,lens_id,axis,profile_name,selected_version,selection_version)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(newRecordId(), space, projectRecordId, 'correctness', 'framework', 'default', null, 1)
    expect(resolveLens('correctness', 'hosted')!.question).toBe('Hosted question?')
    expect(resolveLens('correctness', null)!.question).not.toBe('Hosted question?')
  })

  test('a hosted lens is complete only when it holds the local profiles and selections', () => {
    const full = {
      hostedCore: true,
      localProfiles: 2,
      hostedProfiles: 2,
      localSelections: 1,
      hostedSelections: 1,
    }
    expect(hostedLensComplete(full)).toBe(true)
    expect(hostedLensComplete({ ...full, hostedCore: false })).toBe(false)
    expect(hostedLensComplete({ ...full, hostedProfiles: 1 })).toBe(false)
    expect(hostedLensComplete({ ...full, hostedSelections: 0 })).toBe(false)
  })

  test('unknown lenses remain free-form while disabled catalogue content refuses', async () => {
    expect(resolveLens('a-live-ad-hoc-calibration-key', 'one')).toBeNull()
    const correctness = listLenses().find((lens) => lens.id === 'correctness')!
    await setLens({
      id: correctness.id,
      title: correctness.title,
      question: correctness.question,
      excludes: correctness.excludes,
      slots: JSON.stringify(correctness.slots),
      enabled: false,
      requiresExecution: false,
      reason: 'test switch-off',
    })
    expect(() => resolveLens('correctness', 'one')).toThrow(
      'invariant: A disabled catalogue lens or selected profile never dispatches.',
    )
    expect(() => resolveLens('correctness', 'one')).toThrow('cleared by:')
  })

  test('a disabled unselected profile does not introduce its axis', async () => {
    upsertProject({ recordId: newRecordId(), name: 'one', path: '/tmp/one', settings: {} })
    const before = resolveLens('correctness', 'one')
    await setProfile({
      lensId: 'correctness',
      axis: 'architecture',
      name: 'retired',
      body: '{}',
      enabled: false,
      reason: 'probe disabled axis',
    })
    expect(resolveLens('correctness', 'one')).toEqual(before)
  })

  test('the project-id repair resolves every populated project reference', () => {
    upsertProject({ recordId: newRecordId(), name: 'one', path: '/tmp/one', settings: {} })
    upsertProject({
      recordId: newRecordId(),
      name: PLATFORM_SLUG,
      path: `/tmp/${PLATFORM_SLUG}`,
      settings: {},
    })
    const runId = addRun({ agent: 'codex', job: 'review-lens', repo: 'one' })
    const renamedRunId = addRun({ agent: 'codex', job: 'review-lens', repo: 'devbox' })
    const live = db()
    live.exec('PRAGMA foreign_keys=ON')
    live.query('UPDATE run SET project_record_id=NULL WHERE record_id=?').run(runId)
    live.query('UPDATE run SET project_record_id=NULL WHERE record_id=?').run(renamedRunId)
    live
      .query(`INSERT INTO canon_pack (id,record_id,job,project,sha256,bytes,doc_count,doc_revisions,compiled_at,findings,project_record_id)
      VALUES (8001,?,'review-lens','one','sha',1,1,'[]','now',0,NULL)`)
      .run(newRecordId())
    live
      .query(
        `INSERT INTO review (id,record_id,recorded_at,project_record_id) VALUES (8002,?,'now',NULL)`,
      )
      .run(newRecordId())
    live
      .query(`INSERT INTO review_lens (record_id,review_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
      VALUES (?,8002,?,'correctness','codex','[]','[]','[]','[]')`)
      .run(newRecordId(), runId)
    live
      .query(
        `INSERT INTO landing (id,record_id,project,branch,status,started_at,project_record_id) VALUES (8003,?,'one','branch','queued','now',NULL)`,
      )
      .run(newRecordId())
    live
      .query(`INSERT INTO landing_override (id,record_id,project,branch,tip,tree,reason,at,project_record_id)
      VALUES (8004,?,'one','branch','tip','tree','test','now',NULL)`)
      .run(newRecordId())
    live
      .query(`INSERT INTO landing_review_carry
      (id,record_id,project,branch,tip,tree,review_id,reviewed_commit,reviewed_tree,patch_id,old_base,new_base,at,project_record_id)
      VALUES (8005,?,'one','branch','tip','tree',8002,'commit','tree','patch','old','new','now',NULL)`)
      .run(newRecordId())
    live
      .query(`INSERT INTO doc (id,scope,subject,slug,title,body,audiences,created_at,updated_at,project_record_id,record_id)
      VALUES (8006,'project','one','probe','Probe','body','["technical"]','now','now',NULL,?)`)
      .run(newRecordId())
    live
      .query(`INSERT INTO doc_revision
      (id,doc_id,scope,subject,slug,op,title,body,audiences,author,reason,at,project_record_id,record_id)
      VALUES (8007,8006,'project','one','probe','create','Probe','body','["technical"]','test','test','now',NULL,?)`)
      .run(newRecordId())

    expect(applyMigrations(live)).toEqual([])
    expect(
      live.query('SELECT project_record_id FROM run WHERE record_id=?').get(renamedRunId),
    ).toEqual({
      project_record_id: (
        live.query(`SELECT record_id AS id FROM project WHERE name='${PLATFORM_SLUG}'`).get() as {
          id: number
        }
      ).id,
    })
    for (const [table, where] of [
      ['run', 'repo IS NOT NULL'],
      ['canon_pack', 'project IS NOT NULL'],
      ['landing', '1'],
      ['landing_override', '1'],
      ['landing_review_carry', '1'],
      ['doc', "scope='project'"],
      ['doc_revision', "scope='project'"],
    ])
      expect(
        (
          live
            .query(`SELECT COUNT(*) n FROM ${table} WHERE ${where} AND project_record_id IS NULL`)
            .get() as { n: number }
        ).n,
        table,
      ).toBe(0)
    expect(
      (
        live
          .query(`SELECT COUNT(*) n FROM review rv WHERE rv.project_record_id IS NULL
        AND 1=(SELECT COUNT(DISTINCT r.project_record_id) FROM review_lens rl JOIN run r ON r.record_id=rl.run_record_id WHERE rl.review_id=rv.id)
        AND 0=(SELECT COUNT(*) FROM review_lens rl JOIN run r ON r.record_id=rl.run_record_id WHERE rl.review_id=rv.id AND r.project_record_id IS NULL)`)
          .get() as { n: number }
      ).n,
    ).toBe(0)
  })
})
