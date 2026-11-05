import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import type { RecordProject } from '../../../shared/record-project-contract.ts'
import { db } from '../database/db.ts'
import { projectRowByName, upsertProject } from '../project/projects.ts'
import { pullProjectRegister } from './record-cache-projects.ts'

test('pulls a linked project update and retirement through an injected client', async () => {
  upsertProject({
    recordId: 'project-pull-fixture',
    name: 'pull-fixture',
    path: '/machine/pull-fixture',
    stack: null,
    canon: false,
    settings: { checks: { spelling: true }, space: 'alpha' },
  })
  const hosted: RecordProject = {
    id: 'project-pull-fixture',
    spaceId: 'space-a',
    spaceName: 'Alpha',
    name: 'pull-fixture',
    keyPrefixes: [],
    stack: 'typescript',
    managedContext: false,
    landingBranch: null,
    color: null,
    colorDark: null,
    retiredAt: '2026-11-04T12:00:00.000Z',
    canon: false,
    settings: {},
  }

  const result = await pullProjectRegister(db(), ['space-a'], {
    listProjects: async (destination) => {
      expect(destination?.destinationSpaceId).toBe('space-a')
      return [hosted]
    },
  })

  expect(result).toEqual({
    updated: 1,
    retired: 1,
    unretired: 0,
    skipped: 0,
    warnings: [],
  })
  expect(projectRowByName('pull-fixture')).toMatchObject({
    path: '/machine/pull-fixture',
    stack: 'typescript',
    retiredAt: '2026-11-04T12:00:00.000Z',
    settings: { checks: { spelling: true }, space: 'alpha' },
  })
})

test('a hosted rename runs the local rename cascade inside the pull', async () => {
  upsertProject({
    recordId: 'project-rename-pull',
    name: 'pull-rename-old',
    path: '/machine/pull-rename-old',
    stack: null,
    canon: false,
    settings: {},
  })
  db()
    .query(
      `INSERT INTO run (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_record_id)
       VALUES (?,1,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      't',
      'codex',
      'implement',
      'sha',
      1,
      'p',
      'ok',
      'pull-rename-old',
      'project-rename-pull',
    )
  const hosted: RecordProject = {
    id: 'project-rename-pull',
    spaceId: 'space-a',
    spaceName: 'Alpha',
    name: 'pull-rename-new',
    keyPrefixes: [],
    stack: null,
    managedContext: false,
    landingBranch: null,
    color: null,
    colorDark: null,
    retiredAt: null,
    canon: false,
    settings: {},
  }

  const result = await pullProjectRegister(db(), ['space-a'], {
    listProjects: async () => [hosted],
  })

  expect(result.updated).toBe(1)
  expect(projectRowByName('pull-rename-new')?.path).toBe('/machine/pull-rename-old')
  expect(
    db().query('SELECT repo FROM run WHERE project_record_id=?').all('project-rename-pull'),
  ).toEqual([{ repo: 'pull-rename-new' }])
})
