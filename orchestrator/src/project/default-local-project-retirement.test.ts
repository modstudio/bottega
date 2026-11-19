import type { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeProjectRegisterRow } from '../database/project-register-store.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  retireUnusedDefaultLocalProjectAtFirstBinding,
  shouldRetireDefaultLocalProject,
} from './default-local-project-retirement.ts'

const database = testDatabaseFixture(() => {})
const projectDirectories: string[] = []

afterEach(() => {
  for (const path of projectDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const facts = {
  alreadyBound: false,
  projectName: 'tasks',
  hasSpace: false,
  referenced: false,
}

test('only an unused space-less default project retires at first binding', () => {
  expect(shouldRetireDefaultLocalProject(facts)).toBe(true)
  expect(shouldRetireDefaultLocalProject({ ...facts, alreadyBound: true })).toBe(false)
  expect(shouldRetireDefaultLocalProject({ ...facts, projectName: 'other' })).toBe(false)
  expect(shouldRetireDefaultLocalProject({ ...facts, hasSpace: true })).toBe(false)
  expect(shouldRetireDefaultLocalProject({ ...facts, referenced: true })).toBe(false)
})

function registerDefault(database: Database, path: string, settings: object = {}): void {
  projectDirectories.push(path)
  writeProjectRegisterRow(database, {
    recordId: '00000000-0000-7000-8000-000000000001',
    name: 'tasks',
    path,
    settings,
  })
}

test('first binding removes an unused space-less default project and its empty directory', async () => {
  const d = database()
  const path = mkdtempSync(join(tmpdir(), 'orch-default-retire-'))
  registerDefault(d, path)

  expect(await retireUnusedDefaultLocalProjectAtFirstBinding(false, d)).toBe(true)
  expect(d.query("SELECT name FROM project WHERE name='tasks'").get()).toBeNull()
  expect(existsSync(path)).toBe(false)
})

test('first binding keeps a default project referenced by a run', async () => {
  const d = database()
  const path = mkdtempSync(join(tmpdir(), 'orch-default-used-'))
  registerDefault(d, path)
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

  expect(await retireUnusedDefaultLocalProjectAtFirstBinding(false, d)).toBe(false)
  expect(d.query("SELECT name FROM project WHERE name='tasks'").get()).toEqual({
    name: 'tasks',
  })
})

test('first binding keeps a default project referenced by a workflow cursor', async () => {
  const d = database()
  const path = mkdtempSync(join(tmpdir(), 'orch-default-cursor-'))
  registerDefault(d, path)
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

  expect(await retireUnusedDefaultLocalProjectAtFirstBinding(false, d)).toBe(false)
  expect(d.query("SELECT name FROM project WHERE name='tasks'").get()).toEqual({
    name: 'tasks',
  })
})

test('an already-bound store leaves the default project untouched', async () => {
  const d = database()
  const path = mkdtempSync(join(tmpdir(), 'orch-default-bound-'))
  registerDefault(d, path)

  expect(await retireUnusedDefaultLocalProjectAtFirstBinding(true, d)).toBe(false)
  expect(d.query("SELECT name FROM project WHERE name='tasks'").get()).toEqual({
    name: 'tasks',
  })
})

test('retirement leaves a non-empty default project directory intact', async () => {
  const d = database()
  const path = mkdtempSync(join(tmpdir(), 'orch-default-nonempty-'))
  mkdirSync(join(path, 'kept'))
  writeFileSync(join(path, 'kept', 'data'), 'unique')
  registerDefault(d, path)

  expect(await retireUnusedDefaultLocalProjectAtFirstBinding(false, d)).toBe(true)
  expect(existsSync(path)).toBe(true)
})
