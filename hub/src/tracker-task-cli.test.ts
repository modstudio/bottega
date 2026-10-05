import { describe, expect, test } from 'bun:test'
import type { TrackerSource, TrackerTask } from '../../shared/trackers.ts'
import type { RegisteredProject } from './projects.ts'
import { refreshTrackerTask } from './tracker-task-cli.ts'

const project = {
  name: 'fixture',
  path: '/fixture',
  repository: true,
  settings: {
    keyPrefixes: ['FIX'],
    tracker: { protocol: 'workspace-mcp', envPrefix: 'FIXTURE' },
  },
} as RegisteredProject

const task: TrackerTask = {
  externalId: 'task-1',
  key: 'FIX-1',
  project: 'fixture',
  title: 'Fresh task',
  status: 'In Progress',
  category: 'active',
  updatedAt: null,
  assignee: null,
}

const source = (lookup: TrackerSource['lookup']): TrackerSource => ({
  project: 'fixture',
  env: 'FIXTURE',
  fetch: async () => [],
  lookup,
})

const dependencies = (lookup: TrackerSource['lookup']) => ({
  registeredProjects: () => [project],
  sourceFor: () => source(lookup),
  readCredentials: async () => ({ url: 'https://tracker.invalid/mcp', token: 'fixture' }),
  connect: async () => ({
    callTool: async () => ({}),
    close: async () => {},
  }),
})

describe('fresh tracker task read', () => {
  test('upserts a task returned by the registered source lookup', async () => {
    const upserted: TrackerTask[] = []
    const result = await refreshTrackerTask('FIX-1', undefined, {
      ...dependencies(async () => task),
      upsert: (value) => {
        upserted.push(value)
      },
    })
    expect(upserted).toEqual([task])
    expect(result).toEqual({ trackerRead: true, commentsVerifiable: false })
  })

  test('refuses when the source lookup does not find the task', async () => {
    await expect(
      refreshTrackerTask(
        'FIX-404',
        undefined,
        dependencies(async () => null),
      ),
    ).rejects.toThrow(
      "task FIX-404 was not found in project fixture's tracker by its single-task lookup",
    )
  })

  test('refuses when the tracker cannot be reached', async () => {
    await expect(
      refreshTrackerTask('FIX-1', undefined, {
        ...dependencies(async () => task),
        connect: async () => {
          throw new Error('tracker unavailable')
        },
      }),
    ).rejects.toThrow('tracker unavailable')
  })
})
