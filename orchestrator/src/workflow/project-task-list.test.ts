import { expect, test } from 'bun:test'
import { readProjectTaskList } from './project-task-list.ts'
import { installTaskReader, type TaskReadPort } from './task-read-port.ts'

const invalidRowPort: TaskReadPort = {
  lookup: async () => [],
  list: async () => [
    {
      key: 'DEV-1',
      record_id: 'task-1',
      project: 'fixture',
      title: null,
      parent_key: null,
      source: null,
      status: null,
      status_category: 42 as unknown as string,
      last_seen: null,
      body: null,
      opened_at: null,
    },
  ],
  show: async () => {
    throw new Error('not used')
  },
  duplicates: async () => [],
  documents: async () => [],
  document: async () => {
    throw new Error('not used')
  },
}

test('project-wide task lists validate every returned row', async () => {
  installTaskReader(invalidRowPort)
  await expect(readProjectTaskList('fixture')).rejects.toThrow(
    'response contained an invalid task status category',
  )
})
