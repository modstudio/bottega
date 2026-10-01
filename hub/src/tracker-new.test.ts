import { describe, expect, test } from 'bun:test'
import type { TrackerProject } from '../../shared/trackers.ts'
import type { McpTool } from './mcp.ts'
import {
  createAdvertisedTrackerTask,
  taskCreationDestination,
  trackerTaskInput,
} from './tracker-new.ts'

describe('tracker-new MCP creation', () => {
  const trackerProject: TrackerProject = {
    name: 'tasks',
    settings: {
      tracker: {
        kind: 'Array',
        protocol: 'array-mcp',
        openStatuses: ['Todo'],
        states: { Todo: 'open', Doing: 'active', Done: 'done' },
      },
    },
  }

  test('chooses the owner of task creation', () => {
    expect(taskCreationDestination(trackerProject)).toBe('tracker')
    for (const protocol of ['workspace-mcp', 'cursor-mcp', 'array-mcp'] as const) {
      expect(
        taskCreationDestination({
          name: protocol,
          settings: { tracker: { protocol, openStatuses: ['open'] } },
        }),
      ).toBe('tracker')
    }
    expect(
      taskCreationDestination({
        name: 'custom',
        settings: { tracker: { protocol: 'custom-mcp', actions: { create: 'task_create' } } },
      }),
    ).toBe('tracker')
    expect(
      taskCreationDestination({ name: 'hub', settings: { tracker: { protocol: 'hub' } } }),
    ).toBe('hosted')
    expect(
      taskCreationDestination({ name: 'read-only', settings: { tracker: { protocol: 'custom' } } }),
    ).toBe('hosted')
    expect(taskCreationDestination({ name: 'hosted', settings: {} })).toBe('hosted')
  })

  test('maps requested and default statuses into tracker vocabulary', () => {
    expect(trackerTaskInput(trackerProject, { title: 'Mapped', status: 'active' }).status).toBe(
      'Doing',
    )
    expect(trackerTaskInput(trackerProject, { title: 'Default' }).status).toBe('Todo')
    expect(() => trackerTaskInput(trackerProject, { title: 'Bad', status: 'review' })).toThrow(
      "status 'review' does not map",
    )
  })

  test('refuses parent creation in the external tracker', () => {
    expect(() => trackerTaskInput(trackerProject, { title: 'Child', parent: 'TSK-1' })).toThrow(
      'set the parent in the Array tracker',
    )
  })

  test('uses the configured create tool live schema before calling it', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const listed: McpTool[] = [
      {
        name: 'custom-create',
        inputSchema: {
          type: 'object',
          properties: { summary: {}, description: {}, team_id: {}, task_status_id: {} },
        },
      },
    ]
    const project: TrackerProject = {
      name: 'fixture',
      settings: {
        tracker: {
          protocol: 'workspace-mcp',
          team: '00000000-0000-0000-0000-000000000001',
          openStatuses: ['Todo'],
          actions: { create: 'custom-create' },
        },
      },
    }

    const result = await createAdvertisedTrackerTask(
      {
        async listTools() {
          return listed
        },
        async callTool(name, args) {
          calls.push({ name, args })
          return { short_id: 'FIX-1' }
        },
      },
      project,
      { title: 'Title', body: 'Body', status: 'Todo' },
    )

    expect(result).toEqual({ short_id: 'FIX-1' })
    expect(calls).toEqual([
      {
        name: 'custom-create',
        args: {
          summary: 'Title',
          description: 'Body',
          team_id: '00000000-0000-0000-0000-000000000001',
          task_status_id: 'Todo',
        },
      },
    ])
  })
})
