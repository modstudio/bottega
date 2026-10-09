import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db, sessionId } from '../database/db.ts'
import { applyMigrations } from '../database/migrations.ts'
import { upsertProject } from '../project/projects.ts'
import {
  chooseLensProfile,
  listLenses,
  resolveLens,
  selectProjectProfile,
  setLens,
  setProfile,
} from './lenses.ts'

describe('lens catalogue', () => {
  test('six seeded cores render their default profile for every registered project', () => {
    upsertProject({ name: 'one', path: '/tmp/one', settings: {} })
    upsertProject({ name: 'two', path: '/tmp/two', settings: {} })
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

  test('an enabled stack profile wins while a disabled one falls through to generic', () => {
    upsertProject({ name: 'stacked', path: '/tmp/stacked', stack: 'node', settings: {} })
    setProfile({
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
    setProfile({
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

  test('renders declared slots in schema order and omits empty sections', () => {
    setLens({
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
    setProfile({
      lensId: 'custom-sections',
      axis: 'framework',
      name: 'default',
      body: '{"looks_for":"Boundary leaks.","empty_slot":""}',
      enabled: true,
      reason: 'custom section fixture',
    })
    expect(resolveLens('custom-sections', null)!.body).toBe('LOOKS FOR\nBoundary leaks.')
  })

  test('profile validation refuses undeclared slots and project selection binds one shared row', () => {
    upsertProject({ name: 'one', path: '/tmp/one', settings: {} })
    upsertProject({ name: 'two', path: '/tmp/two', settings: {} })
    expect(() =>
      setProfile({
        lensId: 'correctness',
        axis: 'framework',
        name: 'node',
        body: '{"not_declared":"x"}',
        enabled: true,
        reason: 'test',
      }),
    ).toThrow('undeclared slot')
    setProfile({
      lensId: 'correctness',
      axis: 'framework',
      name: 'node',
      body: '{"framework_guidance":"Node.","commands":"bun test"}',
      enabled: true,
      reason: 'test',
    })
    selectProjectProfile({
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
    selectProjectProfile({
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
    selectProjectProfile({
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

  test('unknown lenses remain free-form while disabled catalogue content refuses', () => {
    expect(resolveLens('a-live-ad-hoc-calibration-key', 'one')).toBeNull()
    const correctness = listLenses().find((lens) => lens.id === 'correctness')!
    setLens({
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

  test('a disabled unselected profile does not introduce its axis', () => {
    upsertProject({ name: 'one', path: '/tmp/one', settings: {} })
    const before = resolveLens('correctness', 'one')
    setProfile({
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
    upsertProject({ name: 'one', path: '/tmp/one', settings: {} })
    upsertProject({ name: PLATFORM_SLUG, path: `/tmp/${PLATFORM_SLUG}`, settings: {} })
    const runId = addRun({ agent: 'codex', job: 'review-lens', repo: 'one' })
    const renamedRunId = addRun({ agent: 'codex', job: 'review-lens', repo: 'devbox' })
    const live = db()
    live.exec('PRAGMA foreign_keys=ON')
    live.query('UPDATE run SET project_id=NULL WHERE id=?').run(runId)
    live.query('UPDATE run SET project_id=NULL WHERE id=?').run(renamedRunId)
    live
      .query(`INSERT INTO canon_pack (id,job,project,sha256,bytes,doc_count,doc_revisions,compiled_at,findings,project_id)
      VALUES (8001,'review-lens','one','sha',1,1,'[]','now',0,NULL)`)
      .run()
    live.query(`INSERT INTO review (id,recorded_at,project_id) VALUES (8002,'now',NULL)`).run()
    live
      .query(`INSERT INTO review_lens (review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
      VALUES (8002,?,'correctness','codex','[]','[]','[]','[]')`)
      .run(runId)
    live
      .query(
        `INSERT INTO landing (id,project,branch,status,started_at,project_id) VALUES (8003,'one','branch','queued','now',NULL)`,
      )
      .run()
    live
      .query(`INSERT INTO landing_override (id,project,branch,tip,tree,reason,at,project_id)
      VALUES (8004,'one','branch','tip','tree','test','now',NULL)`)
      .run()
    live
      .query(`INSERT INTO landing_review_carry
      (id,project,branch,tip,tree,review_id,reviewed_commit,reviewed_tree,patch_id,old_base,new_base,at,project_id)
      VALUES (8005,'one','branch','tip','tree',8002,'commit','tree','patch','old','new','now',NULL)`)
      .run()
    live
      .query(`INSERT INTO doc (id,scope,subject,slug,title,body,audiences,created_at,updated_at,project_id,record_id)
      VALUES (8006,'project','one','probe','Probe','body','["technical"]','now','now',NULL,?)`)
      .run(newRecordId())
    live
      .query(`INSERT INTO doc_revision
      (id,doc_id,scope,subject,slug,op,title,body,audiences,author,reason,at,project_id)
      VALUES (8007,8006,'project','one','probe','create','Probe','body','["technical"]','test','test','now',NULL)`)
      .run()

    expect(applyMigrations(live)).toEqual([])
    expect(live.query('SELECT project_id FROM run WHERE id=?').get(renamedRunId)).toEqual({
      project_id: (
        live.query(`SELECT id FROM project WHERE name='${PLATFORM_SLUG}'`).get() as { id: number }
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
            .query(`SELECT COUNT(*) n FROM ${table} WHERE ${where} AND project_id IS NULL`)
            .get() as { n: number }
        ).n,
        table,
      ).toBe(0)
    expect(
      (
        live
          .query(`SELECT COUNT(*) n FROM review rv WHERE rv.project_id IS NULL
        AND 1=(SELECT COUNT(DISTINCT r.project_id) FROM review_lens rl JOIN run r ON r.id=rl.run_id WHERE rl.review_id=rv.id)
        AND 0=(SELECT COUNT(*) FROM review_lens rl JOIN run r ON r.id=rl.run_id WHERE rl.review_id=rv.id AND r.project_id IS NULL)`)
          .get() as { n: number }
      ).n,
    ).toBe(0)
  })
})
