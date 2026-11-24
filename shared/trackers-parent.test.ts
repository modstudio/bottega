import { describe, expect, test } from 'bun:test'
import type { TrackerProject } from './trackers.ts'
import { trackerSourceFor } from './trackers.ts'

const project = (protocol: string): TrackerProject => ({
  name: 'parents',
  settings: {
    tracker: {
      protocol,
      ...(protocol === 'workspace-mcp' ? { team: 'Platform' } : {}),
      ...(protocol === 'cursor-mcp' ? { projectId: '019d9699-a223-729f-a032-50de9fdf4303' } : {}),
      envPrefix: 'FIXTURE',
      openStatuses: ['todo'],
      states: { todo: 'open', done: 'done' },
    },
  },
})

const scopeTools = async () => [
  { name: 'list-tasks-tool', inputSchema: { properties: { team_id: {} } } },
  { name: 'task_list', inputSchema: { properties: { projectId: {} } } },
]

describe('tracker parent mapping', () => {
  for (const protocol of ['workspace-mcp', 'cursor-mcp', 'array-mcp'] as const) {
    const rows =
      protocol === 'workspace-mcp'
        ? [
            { short_id: 'PAR-1', status: 'todo', parent: { short_id: 'par-9' } },
            { short_id: 'PAR-2', status: 'todo', parent: null },
            { short_id: 'PAR-3', status: 'todo' },
          ]
        : protocol === 'cursor-mcp'
          ? [
              { humanKey: 'PAR-1', status: 'todo', parent: { humanKey: 'par-9' } },
              { humanKey: 'PAR-2', status: 'todo', parent: null },
              { humanKey: 'PAR-3', status: 'todo' },
            ]
          : [
              { key: 'PAR-1', status: 'todo', parent: { key: 'par-9' } },
              { key: 'PAR-2', status: 'todo', parent: null },
              { key: 'PAR-3', status: 'todo' },
            ]

    test(`${protocol} list distinguishes a parent, no parent, and an unreported parent`, async () => {
      const reply =
        protocol === 'workspace-mcp'
          ? { tasks: rows }
          : protocol === 'cursor-mcp'
            ? { data: { items: rows } }
            : rows
      const fetched = await trackerSourceFor(project(protocol))!.fetch({
        listTools: scopeTools,
        callTool: async () => reply,
      })
      expect(fetched.tasks.map((task) => task.parentKey)).toEqual(['PAR-9', null, undefined])
    })

    test(`${protocol} lookup distinguishes a parent, no parent, and an unreported parent`, async () => {
      const source = trackerSourceFor(project(protocol))!
      const results = []
      for (const row of rows) {
        const reply =
          protocol === 'cursor-mcp'
            ? { success: true, data: row }
            : protocol === 'array-mcp'
              ? [row]
              : row
        const key = 'humanKey' in row ? row.humanKey : 'short_id' in row ? row.short_id : row.key
        results.push(
          await source.lookup!({ listTools: scopeTools, callTool: async () => reply }, key),
        )
      }
      expect(results.map((task) => task?.parentKey)).toEqual(['PAR-9', null, undefined])
    })
  }
})
