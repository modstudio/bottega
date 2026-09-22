import { describe, expect, test } from 'bun:test'
import type { TrackerProject } from '../../shared/trackers.ts'
import type { McpTool } from './mcp.ts'
import { createAdvertisedTrackerTask } from './tracker-new.ts'

describe('tracker-new MCP creation', () => {
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
