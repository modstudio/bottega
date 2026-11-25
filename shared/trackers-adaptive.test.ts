import { describe, expect, test } from 'bun:test'
import { ToolCallRefused } from './tracker-list-scope.ts'
import { type TrackerProject, trackerSourceFor } from './trackers.ts'

const project = (name: string, protocol: 'cursor-mcp' | 'workspace-mcp'): TrackerProject => ({
  name,
  settings: {
    tracker: {
      protocol,
      envPrefix: 'FIXTURE',
      openStatuses: ['todo'],
      states: { todo: 'open' },
      ...(protocol === 'cursor-mcp'
        ? { projectId: '019d9699-a223-729f-a032-50de9fdf4303' }
        : { team: 'Platform' }),
    },
  },
})

const scopeTools = async () => [
  { name: 'list-tasks-tool', inputSchema: { properties: { team_id: {} } } },
  { name: 'task_list', inputSchema: { properties: { projectId: {} } } },
]

describe('adaptive tracker paging', () => {
  test('cursor paging halves refusals at the same cursor and returns the working size', async () => {
    const source = trackerSourceFor(project('stopal', 'cursor-mcp'))!
    const calls: Record<string, unknown>[] = []
    const fetched = await source.fetch({
      listTools: scopeTools,
      async callTool(_name, args) {
        calls.push(args)
        if ((args.limit as number) > 2) throw new ToolCallRefused('fixture page too large')
        const index = Number(args.cursor ?? 0)
        return {
          data: {
            items: [{ id: `row-${index}`, humanKey: `STO-${index + 1}`, status: 'todo' }],
            ...(index < 3 ? { nextCursor: String(index + 1) } : {}),
          },
        }
      },
    })
    expect(fetched.tasks.map((task) => task.key)).toEqual(['STO-1', 'STO-2', 'STO-3', 'STO-4'])
    expect(fetched.complete).toBeTrue()
    expect(fetched.pageSize).toBe(1)
    expect(calls.slice(-4).map((call) => call.cursor)).toEqual([undefined, '1', '2', '3'])
  })

  test('workspace paging carries its row offset when a later page halves', async () => {
    const source = trackerSourceFor(project('starship', 'workspace-mcp'))!
    const calls: Record<string, unknown>[] = []
    const rows = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `row-${start + index}`,
        short_id: `STAR-${start + index + 1}`,
        status: 'todo',
      }))
    const fetched = await source.fetch({
      listTools: scopeTools,
      async callTool(_name, args) {
        calls.push(args)
        if (args.page === 2 && args.per_page === 100)
          throw new ToolCallRefused('fixture page too large')
        if (args.page === 1) return { tasks: rows(0, 100), last_page: 3 }
        return { tasks: rows(100, 50), last_page: 3 }
      },
    })
    expect(fetched.tasks).toHaveLength(150)
    expect(fetched.complete).toBeTrue()
    expect(fetched.pageSize).toBe(50)
    expect(calls.map(({ page, per_page }) => ({ page, per_page }))).toEqual([
      { page: 1, per_page: 100 },
      { page: 2, per_page: 100 },
      { page: 3, per_page: 50 },
    ])
  })

  test('workspace paging advances from the page actually read after repeated halving', async () => {
    const source = trackerSourceFor(project('starship', 'workspace-mcp'))!
    const allRows = Array.from({ length: 60 }, (_, index) => ({
      id: `row-${index}`,
      short_id: `STAR-${index + 1}`,
      status: 'todo',
    }))
    const fetched = await source.fetch({
      listTools: scopeTools,
      async callTool(_name, args) {
        const pageSize = args.per_page as number
        const start = ((args.page as number) - 1) * pageSize
        if (pageSize > 25 || (start >= 25 && pageSize === 25) || (start >= 36 && pageSize > 1))
          throw new ToolCallRefused('fixture page too large')
        return {
          tasks: allRows.slice(start, start + pageSize),
          last_page: Math.ceil(allRows.length / pageSize),
        }
      },
    })

    expect(fetched.complete).toBeTrue()
    expect(new Set(fetched.tasks.map((task) => task.key))).toEqual(
      new Set(allRows.map((_, index) => `STAR-${index + 1}`)),
    )
  })

  test('a refusal at page size one leaves prior rows intact and reports its position', async () => {
    const source = trackerSourceFor(project('stopal', 'cursor-mcp'))!
    const fetched = await source.fetch({
      listTools: scopeTools,
      async callTool(_name, args) {
        if (!args.cursor)
          return {
            data: {
              items: [{ id: 'row-1', humanKey: 'STO-1', status: 'todo' }],
              nextCursor: 'second',
            },
          }
        throw new ToolCallRefused('fixture row too large')
      },
    })
    expect(fetched.tasks.map((task) => task.key)).toEqual(['STO-1'])
    expect(fetched.complete).toBeFalse()
    expect(fetched.error).toBe(
      'cursor-mcp page index 1 after 1 rows in status todo was refused at page size 1',
    )
  })
})
