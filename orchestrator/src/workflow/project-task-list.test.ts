import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readProjectTaskList } from './project-task-list.ts'
import { installTaskReader, type TaskReadPort } from './task-read-port.ts'

const invalidRowPort: TaskReadPort = {
  listLocal: async () => [],
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

let previousTaskReader: TaskReadPort | undefined
beforeAll(() => {
  previousTaskReader = installTaskReader(invalidRowPort)
})
afterAll(() => {
  installTaskReader(previousTaskReader)
})

test('project-wide task lists validate every returned row', async () => {
  await expect(readProjectTaskList('fixture')).rejects.toThrow(
    'response contained an invalid task status category',
  )
})
