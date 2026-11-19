import type { Database } from 'bun:sqlite'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StateEnvironment } from '../../../shared/state-directory.ts'
import {
  DEFAULT_LOCAL_PROJECT_SETTINGS,
  defaultLocalProjectPath,
  writeProjectRegisterRow,
} from '../database/project-register-store.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { retireUnusedDefaultLocalProject } from './default-local-project-retirement.ts'
import type { ProjectSettings } from './project-settings.ts'

const database = testDatabaseFixture(() => {})
const projectDirectories: string[] = []

afterEach(() => {
  for (const path of projectDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const noTasks = async () => []

function registerDefault(
  database: Database,
  prefix: string,
  options: { path?: string; settings?: ProjectSettings } = {},
): { environment: StateEnvironment; path: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const environment = { BOTTEGA_STATE_HOME: root }
  const path = options.path ?? defaultLocalProjectPath(environment)
  mkdirSync(path, { recursive: true })
  projectDirectories.push(root)
  writeProjectRegisterRow(database, {
    recordId: '00000000-0000-7000-8000-000000000001',
    name: 'tasks',
    path,
    settings: options.settings ?? DEFAULT_LOCAL_PROJECT_SETTINGS,
  })
  return { environment, path, root }
}

test('sign-in removes an unused built-in project and its empty directory', async () => {
  const d = database()
  const { environment, path } = registerDefault(d, 'orch-default-retire-')

  expect(await retireUnusedDefaultLocalProject(d, environment, noTasks)).toBe(true)
  expect(d.query("SELECT name FROM project WHERE name='tasks'").get()).toBeNull()
  expect(existsSync(path)).toBe(false)
  expect(await retireUnusedDefaultLocalProject(d, environment, noTasks)).toBe(false)
})

test('sign-in keeps a built-in project referenced by a run', async () => {
  const d = database()
  const { environment, path } = registerDefault(d, 'orch-default-used-')
  d.query(
    `INSERT INTO run
       (record_id,number,started_at,agent,job,repo,cwd,project_record_id,prompt_sha,prompt_bytes,
        prompt_head,status,latency_ms,probe,turn,transport)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    '00000000-0000-7000-8000-000000000002',
    1,
    '2026-11-19T00:00:00.000Z',
    'codex',
    'implement',
    'tasks',
    path,
    '00000000-0000-7000-8000-000000000001',
    'sha',
    1,
    'prompt',
    'ok',
    1,
    0,
    1,
    'cli',
  )

  expect(await retireUnusedDefaultLocalProject(d, environment, noTasks)).toBe(false)
  expect(d.query("SELECT name FROM project WHERE name='tasks'").get()).toEqual({
    name: 'tasks',
  })
})

test('sign-in keeps a built-in project referenced by a workflow cursor', async () => {
  const d = database()
  const { environment } = registerDefault(d, 'orch-default-cursor-')
  d.exec('PRAGMA foreign_keys=OFF')
  try {
    d.query(
      `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,
        task_record_id,task_flow_record_id,instance_id,session_id,workflow_version_record_id,
        catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,total_steps,
        created_at,updated_at,enforcement,opened_machine_id,last_advanced_machine_id,revision)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      '00000000-0000-7000-8000-000000000003',
      1,
      'tasks',
      '00000000-0000-7000-8000-000000000001',
      'explore',
      'default',
      'TASK-1',
      null,
      null,
      '',
      'session',
      '00000000-0000-7000-8000-000000000004',
      '00000000-0000-7000-8000-000000000005',
      '{}',
      'guided',
      0,
      'plan',
      'running',
      '[]',
      null,
      1,
      '2026-11-19T00:00:00.000Z',
      '2026-11-19T00:00:00.000Z',
      'floors',
      '00000000-0000-7000-8000-000000000006',
      '00000000-0000-7000-8000-000000000006',
      1,
    )
  } finally {
    d.exec('PRAGMA foreign_keys=ON')
  }

  expect(await retireUnusedDefaultLocalProject(d, environment, noTasks)).toBe(false)
  expect(d.query("SELECT name FROM project WHERE name='tasks'").get()).toEqual({
    name: 'tasks',
  })
})

test('sign-in keeps a user project named tasks at another path', async () => {
  const d = database()
  const root = mkdtempSync(join(tmpdir(), 'orch-default-user-path-'))
  projectDirectories.push(root)
  const environment = { BOTTEGA_STATE_HOME: root }
  const path = join(root, 'user-checkout')
  mkdirSync(path)
  writeProjectRegisterRow(d, {
    recordId: '00000000-0000-7000-8000-000000000001',
    name: 'tasks',
    path,
    settings: DEFAULT_LOCAL_PROJECT_SETTINGS,
  })

  expect(await retireUnusedDefaultLocalProject(d, environment, noTasks)).toBe(false)
  expect(d.query("SELECT name FROM project WHERE name='tasks'").get()).toEqual({
    name: 'tasks',
  })
})

test('sign-in keeps the built-in project when its default settings were changed', async () => {
  const d = database()
  const { environment } = registerDefault(d, 'orch-default-changed-', {
    settings: { ...DEFAULT_LOCAL_PROJECT_SETTINGS, keyPrefixes: ['CHANGED'] },
  })

  expect(await retireUnusedDefaultLocalProject(d, environment, noTasks)).toBe(false)
  expect(d.query("SELECT name FROM project WHERE name='tasks'").get()).toEqual({
    name: 'tasks',
  })
})

test('retirement leaves a non-empty default project directory intact', async () => {
  const d = database()
  const { environment, path } = registerDefault(d, 'orch-default-nonempty-')
  mkdirSync(join(path, 'kept'))
  writeFileSync(join(path, 'kept', 'data'), 'unique')

  expect(await retireUnusedDefaultLocalProject(d, environment, noTasks)).toBe(true)
  expect(existsSync(path)).toBe(true)
})

test('sign-in keeps a built-in project that holds a task', async () => {
  const d = database()
  const { environment } = registerDefault(d, 'orch-default-task-')

  expect(
    await retireUnusedDefaultLocalProject(d, environment, async () => [
      {
        key: 'TASK-1',
        record_id: '00000000-0000-7000-8000-000000000009',
        project: 'tasks',
      },
    ]),
  ).toBe(false)
  expect(d.query("SELECT name FROM project WHERE name='tasks'").get()).toEqual({
    name: 'tasks',
  })
})

test('an unreadable task list keeps the project', async () => {
  const d = database()
  const { environment } = registerDefault(d, 'orch-default-task-failure-')
  const warning = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(
      await retireUnusedDefaultLocalProject(d, environment, async () => {
        throw new Error('hub task store unavailable')
      }),
    ).toBe(false)
    expect(warning).toHaveBeenCalledWith(
      'default local project task read failed; keeping project: hub task store unavailable',
    )
  } finally {
    warning.mockRestore()
  }
  expect(d.query("SELECT name FROM project WHERE name='tasks'").get()).toEqual({
    name: 'tasks',
  })
})
