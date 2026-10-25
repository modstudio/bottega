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
