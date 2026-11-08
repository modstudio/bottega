import { describe, expect, test } from 'bun:test'
import { addProject } from '../../test/fixtures/offline-branch-landing.ts'
import { db } from '../database/db.ts'
import { admitNewRunReference, RUN_REFERENCE_REFUSAL } from './run-task-reference.ts'

describe('run task reference', () => {
  test('resolves a record id within the recorded project for the run claim', async () => {
    const task = {
      record_id: '01990000-0000-7000-8000-000000000895',
      key: 'SHARED-42',
      project: 'beta',
    }

    expect(
      await admitNewRunReference({
        projectName: 'beta',
        projectRecordId: null,
        key: 'SHARED-42',
        cwd: null,
        launchCwd: null,
        probe: false,
        hubTaskReader: async () => [task],
      }),
    ).toMatchObject({ taskRecordId: '01990000-0000-7000-8000-000000000895' })
  })

  test('resolves a project-less key through its sole registered prefix owner', async () => {
    const projectRecordId = addProject('prefix-owner', '/work/prefix-owner')
    db()
      .query('UPDATE project SET settings=? WHERE record_id=?')
      .run(JSON.stringify({ trunk: 'main', keyPrefixes: ['OWNED'] }), projectRecordId)

    expect(
      await admitNewRunReference({
        projectName: null,
        projectRecordId: null,
        key: 'OWNED-42',
        cwd: null,
        launchCwd: null,
        probe: false,
        hubTaskReader: async (project) => [{ record_id: 'owned-task', key: 'OWNED-42', project }],
      }),
    ).toEqual({ taskRecordId: 'owned-task', projectRecordId })
  })

  test('refuses a project-less key when more than one project declares its prefix', async () => {
    for (const name of ['duplicate-prefix-one', 'duplicate-prefix-two']) {
      const recordId = addProject(name, `/work/${name}`)
      db()
        .query('UPDATE project SET settings=? WHERE record_id=?')
        .run(JSON.stringify({ trunk: 'main', keyPrefixes: ['DUP'] }), recordId)
    }

    await expect(
      admitNewRunReference({
        projectName: null,
        projectRecordId: null,
        key: 'DUP-42',
        cwd: null,
        launchCwd: null,
        probe: false,
        hubTaskReader: async () => {
          throw new Error('an ambiguous prefix must not read either project')
        },
      }),
    ).rejects.toThrow(RUN_REFERENCE_REFUSAL)
  })

  test('refuses with the remedy when hub is unavailable and no project can be derived', async () => {
    expect(
      admitNewRunReference({
        projectName: 'beta',
        projectRecordId: null,
        key: 'SHARED-42',
        cwd: null,
        launchCwd: null,
        probe: false,
        hubTaskReader: async () => {
          throw new Error('hub unavailable')
        },
      }),
    ).rejects.toThrow(RUN_REFERENCE_REFUSAL)
  })

  test('admits a turn with the links already read from its parent', async () => {
    expect(
      await admitNewRunReference({
        inheritedTaskRecordId: 'parent-task',
        inheritedProjectRecordId: 'parent-project',
        projectName: null,
        projectRecordId: null,
        key: null,
        cwd: null,
        launchCwd: null,
        probe: false,
      }),
    ).toEqual({ taskRecordId: 'parent-task', projectRecordId: 'parent-project' })
  })
})
