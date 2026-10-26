import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addProject } from '../../test/fixtures/offline-branch-landing.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import {
  deriveRunLinks,
  type HubTaskReference,
  linkRunTasks,
  type RunLinkFacts,
} from './run-task-linking.ts'

const project = (name: string, path: string, recordId = `${name}-id`) =>
  ({ recordId, name, path, stack: null, canon: false, retiredAt: null, settings: {} }) as Project

const task = (key: string, projectName = 'alpha'): HubTaskReference => ({
  key,
  record_id: `${key}-id`,
  project: projectName,
})

const facts = (overrides: Partial<RunLinkFacts> = {}): RunLinkFacts => ({
  record_id: 'run-1',
  job: 'implement',
  launch_key: null,
  review_ref: null,
  branch: null,
  cwd: null,
  launch_cwd: null,
  probe: 0,
  parent_run_record_id: null,
  task_record_id: null,
  project_record_id: null,
  ...overrides,
})

const taskMap = (...rows: HubTaskReference[]) => new Map(rows.map((row) => [row.key, row]))

describe('run link derivation', () => {
  test('uses an exact launch key before review and branch tokens', () => {
    const rows = [task('DEV-1'), task('DEV-2'), task('DEV-3')]
    expect(
      deriveRunLinks(
        [facts({ launch_key: 'DEV-1', review_ref: 'review/DEV-2', branch: 'DEV-3-work' })],
        taskMap(...rows),
        [project('alpha', '/work/alpha')],
      )[0],
    ).toMatchObject({ task_record_id: 'DEV-1-id', task_source: 'launch_key' })
  })

  test('uses the first known key token in the review ref', () => {
    expect(
      deriveRunLinks(
        [facts({ review_ref: 'review/MISSING-9/DEV-2', branch: 'DEV-3-work' })],
        taskMap(task('DEV-2'), task('DEV-3')),
        [],
      )[0],
    ).toMatchObject({ task_record_id: 'DEV-2-id', task_source: 'review_ref' })
  })

  test('uses a known branch key token after earlier sources yield none', () => {
    expect(
      deriveRunLinks(
        [facts({ launch_key: 'missing DEV-1', review_ref: 'none', branch: 'topic/DEV-3-work' })],
        taskMap(task('DEV-1'), task('DEV-3')),
        [],
      )[0],
    ).toMatchObject({ task_record_id: 'DEV-3-id', task_source: 'branch' })
  })

  test('a turn inherits a root task resolved in the same pass', () => {
    const root = facts({ record_id: 'root', launch_key: 'DEV-4' })
    const turn = facts({ record_id: 'turn', parent_run_record_id: 'root' })
    const result = deriveRunLinks([turn, root], taskMap(task('DEV-4')), [])
    expect(result.find((row) => row.record_id === 'turn')).toMatchObject({
      task_record_id: 'DEV-4-id',
      task_source: 'turn',
    })
  })

  test('derives a registered project from the newly linked task', () => {
    expect(
      deriveRunLinks([facts({ launch_key: 'DEV-5' })], taskMap(task('DEV-5')), [
        project('alpha', '/work/alpha'),
      ])[0],
    ).toMatchObject({ project_record_id: 'alpha-id', project_source: 'task-project' })
  })

  test('uses the longest project path on a path-segment boundary', () => {
    expect(
      deriveRunLinks([facts({ cwd: '/work/alpha/component/src' })], new Map(), [
        project('alpha', '/work/alpha'),
        project('component', '/work/alpha/component'),
      ])[0],
    ).toMatchObject({ project_record_id: 'component-id', project_source: 'cwd' })
    expect(
      deriveRunLinks([facts({ cwd: '/work/alphax' })], new Map(), [
        project('alpha', '/work/alpha'),
      ])[0],
    ).toEqual({ record_id: 'run-1' })
  })

  test('matches an encoded scratchpad project only on a dash boundary', () => {
    expect(
      deriveRunLinks([facts({ cwd: '/tmp/session/-Users-sam-Projects-alpha/work' })], new Map(), [
        project('prefix', '/Users/sam/Projects/al'),
        project('alpha', '/Users/sam/Projects/alpha'),
      ])[0],
    ).toMatchObject({ project_record_id: 'alpha-id', project_source: 'scratchpad-cwd' })
    expect(
      deriveRunLinks([facts({ cwd: '/tmp/session/-Users-sam-Projects-alx/work' })], new Map(), [
        project('prefix', '/Users/sam/Projects/al'),
      ])[0],
    ).toEqual({ record_id: 'run-1' })
  })

  test('never overwrites links and never links a probe', () => {
    const result = deriveRunLinks(
      [
        facts({ task_record_id: 'existing-task', project_record_id: 'existing-project' }),
        facts({ record_id: 'probe', probe: 1, launch_key: 'DEV-6', cwd: '/work/alpha' }),
      ],
      taskMap(task('DEV-6')),
      [project('alpha', '/work/alpha')],
    )
    expect(result[0]).toEqual({ record_id: 'run-1' })
    expect(result[1]).toEqual({ record_id: 'probe' })
  })
})

describe('run task linking service', () => {
  test('writes derived links once and is idempotent', async () => {
    const projectId = addProject('link-write', '/work/link-write')
    const migrationSql = readFileSync(
      new URL('../../migrations/0167_run_task_or_project.sql', import.meta.url),
      'utf8',
    )
    const insertTriggerSql = migrationSql.split('--> statement-breakpoint')[0]!
    db().exec('DROP TRIGGER run_require_task_or_project_insert')
    let runId: string
    try {
      runId = addRun({ agent: 'codex', job: 'implement', projectRecordId: null })
    } finally {
      db().exec(insertTriggerSql)
    }
    db().query('UPDATE run SET launch_key=? WHERE record_id=?').run('WRITE-1', runId)
    const hubReader = async () => [
      { key: 'WRITE-1', record_id: 'write-task-id', project: 'link-write' },
    ]

    const first = await linkRunTasks({ dryRun: false }, { hubReader })
    expect(first.task_links_by_source.launch_key).toBe(1)
    expect(first.project_links_by_source['task-project']).toBe(1)
    expect(
      db().query('SELECT task_record_id,project_record_id FROM run WHERE record_id=?').get(runId),
    ).toEqual({ task_record_id: 'write-task-id', project_record_id: projectId })

    const second = await linkRunTasks({ dryRun: false }, { hubReader })
    expect(second.task_links_by_source).toEqual({
      launch_key: 0,
      review_ref: 0,
      branch: 0,
      turn: 0,
    })
    expect(second.project_links_by_source).toEqual({
      'task-project': 0,
      cwd: 0,
      'scratchpad-cwd': 0,
    })
  })

  test('dry run reports links without writing them', async () => {
    addProject('link-dry', '/work/link-dry')
    const runId = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET launch_key=? WHERE record_id=?').run('DRY-2', runId)
    const orphanId = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET launch_key=? WHERE record_id=?').run('GONE-7', orphanId)
    const probeId = addRun({ agent: 'codex', job: 'review-lens', projectRecordId: null, probe: 1 })
    db().query('UPDATE run SET launch_key=? WHERE record_id=?').run('DRY-2', probeId)
    const lostProbeId = addRun({
      agent: 'codex',
      job: 'review-lens',
      projectRecordId: null,
      probe: 1,
    })
    db().query('UPDATE run SET launch_key=? WHERE record_id=?').run('MISSING-3', lostProbeId)

    const report = await linkRunTasks(
      { dryRun: true },
      {
        hubReader: async () => [{ key: 'DRY-2', record_id: 'dry-task-id', project: 'link-dry' }],
      },
    )
    expect(report.task_links_by_source.launch_key).toBe(1)
    expect(report.keys_without_task['GONE-7']).toBe(1)
    expect(report.keys_without_task['DRY-2']).toBeUndefined()
    expect(report.keys_without_task['MISSING-3']).toBe(1)
    expect(db().query('SELECT task_record_id FROM run WHERE record_id=?').get(runId)).toEqual({
      task_record_id: null,
    })
  })

  test('links related task references once and reports unmatched keys per table', async () => {
    const projectId = addProject('related-links', '/work/related-links')
    const runId = addRun({ agent: 'codex', job: 'implement', projectRecordId: projectId })
    db().exec('PRAGMA foreign_keys=OFF')
    try {
      db()
        .query(
          `INSERT INTO workflow_cursor
          (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
           workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,total_steps,created_at,updated_at)
         VALUES ('cursor-related',991,'related-links',?,'flow','default','REL-1','','workflow-version','catalogue-version','{}',0,'step','running','[]',1,'t','t')`,
        )
        .run(projectId)
      db()
        .query(
          `INSERT INTO question
          (record_id,number,workflow_cursor_record_id,workflow_key,asked_at,question,asked_via)
         VALUES ('question-related',991,'cursor-related','REL-1','t','question','live')`,
        )
        .run()
      db()
        .query(
          `INSERT INTO port_ref
          (record_id,task_key,target_project_record_id,note,created_at)
         VALUES ('port-related','MISSING-1',?,'note','t')`,
        )
        .run(projectId)
      db()
        .query(
          `INSERT INTO presence
          (session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,last_seen)
         VALUES ('related-session','claude','architect','machine','related-links',?,'/work/related-links','REL-1','t')`,
        )
        .run(projectId)
    } finally {
      db().exec('PRAGMA foreign_keys=ON')
    }
    const hubReader = async () => [
      { key: 'REL-1', record_id: 'related-task-id', project: 'related-links' },
    ]

    const first = await linkRunTasks({ dryRun: false }, { hubReader })
    expect(first.local_task_links).toEqual({
      workflow_cursor: { linked: 1, unmatched_keys: {} },
      question: { linked: 1, unmatched_keys: {} },
      port_ref: { linked: 0, unmatched_keys: { 'MISSING-1': 1 } },
      presence: { linked: 1, unmatched_keys: {} },
    })
    expect(
      db()
        .query(
          `SELECT
          (SELECT task_record_id FROM workflow_cursor WHERE record_id='cursor-related') cursor_task,
          (SELECT workflow_task_record_id FROM question WHERE record_id='question-related') question_task,
          (SELECT revision FROM question WHERE record_id='question-related') question_revision,
          (SELECT COUNT(*) FROM outbox WHERE kind='question' AND row_id='question-related') question_outbox,
          (SELECT current_task_record_id FROM presence WHERE session_id='related-session') presence_task`,
        )
        .get(),
    ).toEqual({
      cursor_task: 'related-task-id',
      question_task: 'related-task-id',
      question_revision: 2,
      question_outbox: 1,
      presence_task: 'related-task-id',
    })

    const second = await linkRunTasks({ dryRun: false }, { hubReader })
    expect(second.local_task_links.workflow_cursor.linked).toBe(0)
    expect(second.local_task_links.question.linked).toBe(0)
    expect(second.local_task_links.presence.linked).toBe(0)
    expect(second.local_task_links.port_ref.unmatched_keys).toEqual({ 'MISSING-1': 1 })
  })

  test('leaves a task key shared by projects unlinked and reports it as unmatched', async () => {
    const alpha = addProject('ambiguous-alpha', '/work/ambiguous-alpha')
    const beta = addProject('ambiguous-beta', '/work/ambiguous-beta')
    const insert = db().query(
      `INSERT INTO port_ref (record_id,task_key,target_project_record_id,note,created_at)
       VALUES (?,?,?,?, 't')`,
    )
    insert.run('ambiguous-ref-alpha', 'SHARED-1', alpha, 'alpha')
    insert.run('ambiguous-ref-beta', 'SHARED-1', beta, 'beta')

    const report = await linkRunTasks(
      { dryRun: false },
      {
        hubReader: async (project) =>
          project.startsWith('ambiguous-')
            ? [{ key: 'SHARED-1', record_id: `task-${project}`, project }]
            : [],
      },
    )

    expect(report.local_task_links.port_ref).toEqual({
      linked: 0,
      unmatched_keys: { 'SHARED-1': 2 },
    })
    expect(
      db()
        .query('SELECT task_record_id FROM port_ref WHERE task_key=? ORDER BY record_id')
        .all('SHARED-1'),
    ).toEqual([{ task_record_id: null }, { task_record_id: null }])
  })

  test('refuses with a project-scoped remedy when the hub reader fails', async () => {
    addProject('link-failure', '/work/link-failure')
    await expect(
      linkRunTasks(
        { dryRun: true },
        { hubReader: async () => Promise.reject(new Error('hub unavailable')) },
      ),
    ).rejects.toThrow(
      `could not read task data for project link-failure: hub unavailable; retry: ${PLATFORM_SLUG} task list --project link-failure --json`,
    )
  })
})
