import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { projectCommand } from './project-commands.ts'
import { projectByName, upsertProject } from './projects.ts'

async function renameTasks(settings?: string): Promise<string> {
  const output: string[] = []
  await projectCommand(
    'set',
    ['project', 'set', 'tasks'],
    {
      has: (name) => name === 'name' || (name === 'settings' && settings !== undefined),
      flag: (name) =>
        name === 'name' ? 'renamed-tasks' : name === 'settings' ? settings : undefined,
    },
    { log: (...parts) => output.push(parts.join(' ')), cwd: () => process.cwd() },
    { requireSpaceMembership: async () => {} },
  )
  return output.join('\n')
}

test('renaming tasks refuses its carried TASK prefix under the new name', async () => {
  installRecordApiClient(createMemoryRecordApiClient())
  upsertProject({
    recordId: newRecordId(),
    name: 'tasks',
    path: '/w/tasks',
    settings: { keyPrefixes: ['TASK'] },
  })
  await expect(renameTasks()).rejects.toThrow('key prefix TASK is reserved')
  expect(projectByName('tasks')).not.toBeNull()
})

test('renaming tasks accepts a simultaneous non-reserved prefix patch', async () => {
  installRecordApiClient(createMemoryRecordApiClient())
  upsertProject({
    recordId: newRecordId(),
    name: 'tasks',
    path: '/w/tasks',
    settings: { keyPrefixes: ['TASK'] },
  })
  expect(await renameTasks(JSON.stringify({ keyPrefixes: ['RENAMED'] }))).toBe(
    'updated renamed-tasks\n               changed keyPrefixes',
  )
  expect(projectByName('renamed-tasks')?.settings.keyPrefixes).toEqual(['RENAMED'])
})
