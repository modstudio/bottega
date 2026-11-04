import { expect, test } from 'bun:test'
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
