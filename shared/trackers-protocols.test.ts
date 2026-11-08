import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { createTrackerTask, trackerCreatedTaskKey } from './tracker-create.ts'
import {
  categoryForTrackerRead,
  MAX_PAGES,
  resolveTrackerAgentActions,
  type ToolCaller,
  TrackerLookupUnverifiable,
  type TrackerProject,
  trackerSourceFor,
  trackerWireAction,
  WORKSPACE_LOOKUP_PAGE_SIZE,
} from './trackers.ts'

describe('incremental tracker read policy', () => {
  const states = { todo: 'open', done: 'done' } as const
  const cases = [
    { name: 'full read with unknown status', incremental: false, status: 'unknown', want: 'open' },
    { name: 'incremental with unknown status', incremental: true, status: 'unknown', want: null },
    { name: 'incremental with no status', incremental: true, status: undefined, want: null },
    { name: 'incremental with mapped status', incremental: true, status: 'done', want: 'done' },
  ] as const

  for (const { name, incremental, status, want } of cases) {
    test(name, () => {
      expect(categoryForTrackerRead(incremental, status, status, 'todo', states)).toBe(want)
    })
  }
})

describe('tracker action names', () => {
  test('uses the agent name as the wire-name fallback', () => {
    expect(trackerWireAction('workspace-mcp', 'search')).toBe('list-tasks-tool')
  })

  test('keeps cursor agent and wire names distinct', () => {
    expect(resolveTrackerAgentActions('cursor-mcp').get).toBe('task_getByKey')
    expect(trackerWireAction('cursor-mcp', 'get')).toBe('task.getByKey')
  })

  test('refuses an action unsupported by the protocol', () => {
    expect(() => trackerWireAction('array-mcp', 'comment')).toThrow(
      'tracker protocol array-mcp has no comment action',
    )
  })

  test('agent action overrides replace defaults and add declared capabilities', () => {
    expect(
      resolveTrackerAgentActions('array-mcp', {
        update: 'custom_update',
        status: 'custom_status',
      }),
    ).toMatchObject({ update: 'custom_update', status: 'custom_status' })
  })
})

describe('created tracker task keys', () => {
  test('reads the workspace-mcp short id', () => {
    expect(
      trackerCreatedTaskKey('workspace-mcp', {
        id: '01a0c96f-example',
        short_id: 'STAR-5557',
        message: 'Task created successfully.',
      }),
    ).toBe('STAR-5557')
  })

  test('reads the array-mcp key', () => {
    expect(trackerCreatedTaskKey('array-mcp', { key: 'adn-42' })).toBe('ADN-42')
  })

  test('reads the cursor-mcp create envelope', () => {
    expect(trackerCreatedTaskKey('cursor-mcp', { data: { humanKey: 'sto-17' } })).toBe('STO-17')
  })

  test('leaves missing and empty protocol keys undefined', () => {
    expect(trackerCreatedTaskKey('workspace-mcp', { id: '01a0c96f-example' })).toBeUndefined()
    expect(trackerCreatedTaskKey('array-mcp', { key: '  ' })).toBeUndefined()
    expect(trackerCreatedTaskKey('cursor-mcp', { data: {} })).toBeUndefined()
    expect(trackerCreatedTaskKey('hub', { key: 'HUB-1' })).toBeUndefined()
  })
})

const task = { title: 'Move the adapter', body: 'Protocol-neutral body', status: 'todo' }

const project = (name: string, protocol?: string): TrackerProject => ({
  name,
  settings: protocol
    ? {
        tracker: {
          protocol,
          ...(protocol === 'workspace-mcp' ? { team: 'Platform' } : {}),
          ...(protocol === 'cursor-mcp'
            ? { projectId: '019d9699-a223-729f-a032-50de9fdf4303' }
            : {}),
          envPrefix: 'FIXTURE',
          openStatuses: ['todo'],
          states: { todo: 'open', done: 'done' },
        },
      }
    : {},
})

const fixtureCaller = () => {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const caller: ToolCaller = {
    async callTool(name, args) {
      calls.push({ name, args })
      return { key: 'ADN-1' }
    },
  }
  return { caller, calls }
}

const scopeTools = async () => [
  { name: 'list-tasks-tool', inputSchema: { properties: { team_id: {} } } },
  { name: 'task.list', inputSchema: { properties: { projectId: {} } } },
]

describe('tracker create protocols', () => {
  test('array-mcp uses its underscored tool and evidenced payload', async () => {
    const fixture = fixtureCaller()

    expect(await createTrackerTask(fixture.caller, project('adanim', 'array-mcp'), task)).toEqual({
      key: 'ADN-1',
    })
    expect(fixture.calls).toEqual([
      {
        name: 'task_create',
        args: {
          title: 'Move the adapter',
          description: 'Protocol-neutral body',
          status: 'todo',
        },
      },
    ])
  })

  test('workspace-mcp status schema sends status and team (mutation: send task_status_id to starship)', async () => {
    const fixture = fixtureCaller()

    expect(
      await createTrackerTask(fixture.caller, project('starship', 'workspace-mcp'), task, {
        properties: { summary: {}, description: {}, team: {}, status: {} },
      }),
    ).toEqual({ key: 'ADN-1' })
    expect(fixture.calls).toEqual([
      {
        name: 'create-task-tool',
        args: {
          summary: 'Move the adapter',
          description: 'Protocol-neutral body',
          team: 'Platform',
          status: 'todo',
        },
      },
    ])
  })

  test('workspace-mcp task_status_id schema sends task_status_id and team_id (mutation: send status to alephbeis)', async () => {
    const fixture = fixtureCaller()

    await createTrackerTask(fixture.caller, project('alephbeis', 'workspace-mcp'), task, {
      properties: { summary: {}, description: {}, team_id: {}, task_status_id: {} },
    })
    expect(fixture.calls).toEqual([
      {
        name: 'create-task-tool',
        args: {
          summary: 'Move the adapter',
          description: 'Protocol-neutral body',
          team_id: 'Platform',
          task_status_id: 'todo',
        },
      },
    ])
  })

  test('cursor-mcp passes the registered project id to task.create', async () => {
    const fixture = fixtureCaller()

    await createTrackerTask(fixture.caller, project('stopal', 'cursor-mcp'), task)
    expect(fixture.calls).toEqual([
      {
        name: 'task.create',
        args: {
          projectId: '019d9699-a223-729f-a032-50de9fdf4303',
          title: 'Move the adapter',
          description: 'Protocol-neutral body',
          status: 'todo',
        },
      },
    ])
  })

  for (const [label, properties] of [
    ['both status fields', { team: {}, status: {}, task_status_id: {} }],
    ['neither status field', { summary: {}, description: {}, team: {} }],
  ] as const) {
    test(`workspace-mcp refuses ${label} and names the fields seen (mutation: guess a status field)`, async () => {
      const fixture = fixtureCaller()

      await expect(
        createTrackerTask(fixture.caller, project('starship', 'workspace-mcp'), task, {
          properties,
        }),
      ).rejects.toThrow(`fields seen: ${Object.keys(properties).sort().join(', ')}`)
      expect(fixture.calls).toEqual([])
    })
  }

  test('workspace-mcp refuses a missing team with the register remedy (mutation: default team to OPS)', async () => {
    const fixture = fixtureCaller()
    const missingTeam = project('starship', 'workspace-mcp')
    delete missingTeam.settings.tracker!.team

    await expect(
      createTrackerTask(fixture.caller, missingTeam, task, {
        properties: { summary: {}, description: {}, team: {}, status: {} },
      }),
    ).rejects.toThrow(`${PLATFORM_SLUG} project set starship --settings '{"tracker":{"team":"…"}}'`)
    expect(fixture.calls).toEqual([])
  })

  test('cursor-mcp refuses the required field absent from the register', async () => {
    const fixture = fixtureCaller()
    const missingProjectId = project('stopal', 'cursor-mcp')
    delete missingProjectId.settings.tracker!.projectId

    await expect(createTrackerTask(fixture.caller, missingProjectId, task)).rejects.toThrow(
      `${PLATFORM_SLUG} project set stopal --settings '{"tracker":{"projectId":"…"}}'`,
    )
    expect(fixture.calls).toEqual([])
  })

  test('a project with no tracker refuses and names the project', async () => {
    const fixture = fixtureCaller()

    await expect(createTrackerTask(fixture.caller, project('untracked'), task)).rejects.toThrow(
      'project untracked has no tracker configured',
    )
    expect(fixture.calls).toEqual([])
  })

  test('an unsupported protocol refuses instead of silently succeeding', async () => {
    const fixture = fixtureCaller()

    await expect(
      createTrackerTask(fixture.caller, project('future', 'future-mcp'), task),
    ).rejects.toThrow('tracker protocol future-mcp has no create support')
    expect(fixture.calls).toEqual([])
  })
})

describe('tracker status protocols', () => {
  test('array-mcp updates the immutable task id and acknowledges a production write', async () => {
    const fixture = fixtureCaller()
    const source = trackerSourceFor(project('adanim', 'array-mcp'))!

    await source.writeStatus!(
      fixture.caller,
      { key: 'ADN-1', externalId: '01990000-0000-7000-8000-000000001659' },
      'done',
      'done',
      'fixture-confirmation',
    )

    expect(fixture.calls).toEqual([
      {
        name: 'task_update',
        args: {
          id: '01990000-0000-7000-8000-000000001659',
          status: 'done',
          confirm: 'fixture-confirmation',
        },
      },
    ])
  })

  test('workspace-mcp selects the proven payload by resolved action and confirms by reading', async () => {
    const cases = [
      {
        action: 'change-task-status-tool',
        payload: { id: 'WOR-1', task_status_id: 'done' },
      },
      { action: 'update-task-tool', payload: { id: 'WOR-1', status: 'done' } },
    ] as const
    for (const entry of cases) {
      const trackerProject = project('workspace', 'workspace-mcp')
      trackerProject.settings.tracker!.actions = { status: entry.action }
      const source = trackerSourceFor(trackerProject)!
      const calls: { name: string; args: Record<string, unknown> }[] = []
      const result = await source.writeStatus!(
        {
          async callTool(name, args) {
            calls.push({ name, args })
            return name === entry.action
              ? { id: 'workspace-uuid' }
              : { short_id: 'WOR-1', status: 'done', status_category: 'done' }
          },
        },
        { key: 'WOR-1', externalId: 'workspace-uuid' },
        'done',
        'done',
        'ignored',
      )
      expect(calls).toEqual([
        { name: entry.action, args: entry.payload },
        { name: 'get-task-tool', args: { id: 'WOR-1' } },
      ])
      expect(result).toEqual({ status: 'done', category: 'done' })
    }
  })

  test('workspace-mcp refuses an unproven status action and a mismatched confirming read', async () => {
    const unproven = project('workspace', 'workspace-mcp')
    unproven.settings.tracker!.actions = { status: 'custom-status-tool' }
    await expect(
      trackerSourceFor(unproven)!.writeStatus!(
        { callTool: async () => ({}) },
        { key: 'WOR-1', externalId: 'workspace-uuid' },
        'done',
        'done',
        'ignored',
      ),
    ).rejects.toThrow('action custom-status-tool has no proven status payload')

    await expect(
      trackerSourceFor(project('workspace', 'workspace-mcp'))!.writeStatus!(
        {
          callTool: async (name) =>
            name === 'update-task-tool'
              ? { id: 'workspace-uuid' }
              : { short_id: 'WOR-1', status: 'todo', status_category: 'open' },
        },
        { key: 'WOR-1', externalId: 'workspace-uuid' },
        'done',
        'done',
        'ignored',
      ),
    ).rejects.toThrow('returned category open after category done was requested')
  })

  test('cursor-mcp writes the immutable uuid and confirms the reply status', async () => {
    const source = trackerSourceFor(project('stopal', 'cursor-mcp'))!
    const fixture = fixtureCaller()
    fixture.caller.callTool = async (name, args) => {
      fixture.calls.push({ name, args })
      return { success: true, data: { status: 'done' } }
    }
    expect(
      await source.writeStatus!(
        fixture.caller,
        { key: 'STO-1', externalId: 'cursor-uuid' },
        'done',
        'done',
        'ignored',
      ),
    ).toEqual({ status: 'done', category: 'done' })
    expect(fixture.calls).toEqual([
      { name: 'task.update', args: { id: 'cursor-uuid', status: 'done' } },
    ])
    await expect(
      source.writeStatus!(
        fixture.caller,
        { key: 'STO-2', externalId: null },
        'done',
        'done',
        'ignored',
      ),
    ).rejects.toThrow('task STO-2 has no external id')
  })
})

describe('tracker list scope', () => {
  const noScopeSchema = (name: string) => async () => [
    { name, inputSchema: { properties: { status: {} } } },
  ]

  test('filters workspace and cursor rows by their returned scope field', async () => {
    const workspace = trackerSourceFor(project('workspace', 'workspace-mcp'))!
    const workspaceRead = await workspace.fetch({
      listTools: noScopeSchema('list-tasks-tool'),
      callTool: async () => ({
        tasks: [
          { short_id: 'WOR-1', status: 'todo', team: 'Platform' },
          { short_id: 'OTH-1', status: 'todo', team: 'Other' },
        ],
      }),
    })
    expect(workspaceRead.tasks.map((task) => task.key)).toEqual(['WOR-1'])

    const cursor = trackerSourceFor(project('stopal', 'cursor-mcp'))!
    const cursorRead = await cursor.fetch({
      listTools: noScopeSchema('task.list'),
      callTool: async () => ({
        data: {
          items: [
            {
              humanKey: 'STO-1',
              status: 'todo',
              projectId: '019d9699-a223-729f-a032-50de9fdf4303',
            },
            { humanKey: 'OTH-1', status: 'todo', projectId: 'other' },
          ],
        },
      }),
    })
    expect(cursorRead.tasks.map((task) => task.key)).toEqual(['STO-1'])
  })

  test('refuses a collect when neither request nor rows carry the registered scope', async () => {
    await expect(
      trackerSourceFor(project('workspace', 'workspace-mcp'))!.fetch({
        listTools: noScopeSchema('list-tasks-tool'),
        callTool: async () => ({ tasks: [{ short_id: 'WOR-1', status: 'todo' }] }),
      }),
    ).rejects.toThrow('returned rows carry no team scope')
    await expect(
      trackerSourceFor(project('stopal', 'cursor-mcp'))!.fetch({
        listTools: noScopeSchema('task.list'),
        callTool: async () => ({ data: { items: [] } }),
      }),
    ).rejects.toThrow('returned rows carry no projectId scope')
  })
})

describe('tracker comment ids', () => {
  const replyCaller = (reply: unknown) => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const caller: ToolCaller = {
      async callTool(name, args) {
        calls.push({ name, args })
        return reply
      },
    }
    return { caller, calls }
  }

  test('workspace-mcp reads one task comments through its declared get tool', async () => {
    const fixture = replyCaller({
      id: '01a0c96f-example',
      short_id: 'STAR-6104',
      comments: [
        { id: '01a16517-2274-71fc-998f-2be4a598791b', body: 'first' },
        { id: 4, body: 'second' },
        { body: 'no id' },
      ],
    })
    const source = trackerSourceFor(project('starship', 'workspace-mcp'))!

    expect(await source.readCommentIds!(fixture.caller, 'STAR-6104')).toEqual([
      '01a16517-2274-71fc-998f-2be4a598791b',
      '4',
    ])
    expect(fixture.calls).toEqual([{ name: 'get-task-tool', args: { id: 'STAR-6104' } }])
  })

  test('a read that answers without a comments array reports no ids at all', async () => {
    const fixture = replyCaller({ id: '01a0c96f-example', short_id: 'STAR-6104' })
    const source = trackerSourceFor(project('starship', 'workspace-mcp'))!

    expect(await source.readCommentIds!(fixture.caller, 'STAR-6104')).toBeNull()
  })

  test('a protocol whose task read carries no comments declares no comment reader', () => {
    expect(trackerSourceFor(project('adanim', 'array-mcp'))!.readCommentIds).toBeUndefined()
    expect(trackerSourceFor(project('stopal', 'cursor-mcp'))!.readCommentIds).toBeUndefined()
  })
})

describe('tracker source construction', () => {
  test('workspace lookup returns a matching task from get without searching', async () => {
    const source = trackerSourceFor(project('starship', 'workspace-mcp'))!
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const caller: ToolCaller = {
      async callTool(name, args) {
        calls.push({ name, args })
        return {
          id: 'workspace-uuid',
          short_id: 'star-12',
          summary: 'Exact task',
          status: 'todo',
          status_category: 'open',
        }
      },
    }

    expect(await source.lookup!(caller, 'STAR-12')).toMatchObject({
      externalId: 'workspace-uuid',
      key: 'STAR-12',
      title: 'Exact task',
      status: 'todo',
    })
    expect(calls).toEqual([{ name: 'get-task-tool', args: { id: 'STAR-12' } }])
  })

  test('workspace lookup normalizes an object status from get without searching', async () => {
    const source = trackerSourceFor(project('alephbeis', 'workspace-mcp'))!
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const caller: ToolCaller = {
      async callTool(name, args) {
        calls.push({ name, args })
        return {
          id: 'workspace-uuid',
          short_id: 'AB-3076',
          summary: 'Completed task',
          status: { id: 'x', name: 'Complete' },
          status_category: 'completed',
        }
      },
    }

    expect(await source.lookup!(caller, 'AB-3076')).toMatchObject({
      externalId: 'workspace-uuid',
      key: 'AB-3076',
      status: 'Complete',
    })
    expect(calls).toEqual([{ name: 'get-task-tool', args: { id: 'AB-3076' } }])
  })

  test('workspace lookup searches when get returns an invalid status', async () => {
    const source = trackerSourceFor(project('alephbeis', 'workspace-mcp'))!
    const calls: string[] = []
    const caller: ToolCaller = {
      async callTool(name) {
        calls.push(name)
        if (name === 'get-task-tool') {
          return { id: 'detail-uuid', short_id: 'AB-3076', status: 42 }
        }
        return {
          tasks: [
            {
              id: 'search-uuid',
              short_id: 'AB-3076',
              status: 'Complete',
              status_category: 'completed',
            },
          ],
          last_page: 1,
        }
      },
    }

    expect(await source.lookup!(caller, 'AB-3076')).toMatchObject({
      externalId: 'search-uuid',
      key: 'AB-3076',
      status: 'Complete',
    })
    expect(calls).toEqual(['get-task-tool', 'list-tasks-tool'])
  })

  test('workspace lookup searches when get answers with another task', async () => {
    const source = trackerSourceFor(project('starship', 'workspace-mcp'))!
    const caller: ToolCaller = {
      async callTool(name) {
        if (name === 'get-task-tool')
          return { id: 'other-uuid', short_id: 'STAR-120', status: 'todo' }
        return { tasks: [{ id: 'workspace-uuid', short_id: 'STAR-12' }], last_page: 1 }
      },
    }

    expect(await source.lookup!(caller, 'STAR-12')).toMatchObject({
      externalId: 'workspace-uuid',
      key: 'STAR-12',
    })
  })

  test('workspace lookup finds an exact task on the second search page after get throws', async () => {
    const source = trackerSourceFor(project('starship', 'workspace-mcp'))!
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const caller: ToolCaller = {
      async callTool(name, args) {
        calls.push({ name, args })
        if (name === 'get-task-tool') throw new Error('unstructured missing-task response')
        return args.page === 1
          ? { tasks: [{ short_id: 'STAR-120' }], last_page: 3 }
          : {
              tasks: [
                {
                  id: 'workspace-uuid',
                  short_id: 'STAR-12',
                  summary: 'Exact task',
                  status: 'todo',
                },
              ],
              last_page: 3,
            }
      },
    }

    expect(await source.lookup!(caller, 'STAR-12')).toMatchObject({
      externalId: 'workspace-uuid',
      key: 'STAR-12',
      title: 'Exact task',
    })
    expect(
      calls.map(({ name, args }) => ({ name, page: args.page, perPage: args.per_page })),
    ).toEqual([
      { name: 'get-task-tool', page: undefined, perPage: undefined },
      { name: 'list-tasks-tool', page: 1, perPage: WORKSPACE_LOOKUP_PAGE_SIZE },
      { name: 'list-tasks-tool', page: 2, perPage: WORKSPACE_LOOKUP_PAGE_SIZE },
    ])
  })

  test('workspace lookup returns null after reading the last search page', async () => {
    const source = trackerSourceFor(project('starship', 'workspace-mcp'))!
    const pages: unknown[] = []
    const caller: ToolCaller = {
      async callTool(name, args) {
        if (name === 'get-task-tool') throw new Error('unstructured missing-task response')
        pages.push(args.page)
        return { tasks: [{ short_id: `STAR-12${args.page}` }], last_page: 3 }
      },
    }

    expect(await source.lookup!(caller, 'STAR-12')).toBeNull()
    expect(pages).toEqual([1, 2, 3])
  })

  test('workspace lookup refuses when the search paging bound is reached', async () => {
    const source = trackerSourceFor(project('starship', 'workspace-mcp'))!
    const caller: ToolCaller = {
      async callTool(name) {
        if (name === 'get-task-tool') throw new Error('unstructured missing-task response')
        return { tasks: [], last_page: Number.MAX_SAFE_INTEGER }
      },
    }

    let failure: unknown
    try {
      await source.lookup!(caller, 'STAR-12')
    } catch (cause) {
      failure = cause
    }
    expect(failure).toBeInstanceOf(TrackerLookupUnverifiable)
    expect((failure as Error).message).toBe(
      'workspace-mcp lookup for STAR-12 reached the paging bound of 40 before the last page',
    )
  })

  test('array lookup refuses to establish absence from an unexpected response', async () => {
    const source = trackerSourceFor(project('adanim', 'array-mcp'))!

    await expect(
      source.lookup!({ callTool: async () => ({ tasks: [] }) }, 'ADN-12'),
    ).rejects.toBeInstanceOf(TrackerLookupUnverifiable)
  })

  test('cursor lookup establishes absence from the typed NOT_FOUND envelope', async () => {
    const source = trackerSourceFor(project('stopal', 'cursor-mcp'))!

    expect(
      await source.lookup!(
        {
          callTool: async () => {
            throw Object.assign(new Error('Task not found: STO-12'), {
              name: 'McpToolCallError',
              structuredContent: {
                success: false,
                error: 'Task not found: STO-12',
                code: 'NOT_FOUND',
              },
            })
          },
        },
        'STO-12',
      ),
    ).toBeNull()
  })

  test('cursor lookup refuses to establish absence from an unexpected response', async () => {
    const source = trackerSourceFor(project('stopal', 'cursor-mcp'))!

    await expect(
      source.lookup!({ callTool: async () => ({ data: null }) }, 'STO-12'),
    ).rejects.toBeInstanceOf(TrackerLookupUnverifiable)
  })

  test('maps immutable external ids from each captured protocol response shape', async () => {
    const cases = [
      {
        protocol: 'workspace-mcp',
        reply: {
          tasks: [{ id: 'workspace-uuid', short_id: 'WOR-1', summary: 'One', status: 'todo' }],
        },
      },
      {
        protocol: 'cursor-mcp',
        reply: {
          data: { items: [{ id: 'cursor-uuid', humanKey: 'CUR-1', title: 'One', status: 'todo' }] },
        },
      },
      {
        protocol: 'array-mcp',
        reply: [{ id: 'array-uuid', key: 'ARR-1', title: 'One', status: 'todo' }],
      },
    ] as const
    for (const entry of cases) {
      const source = trackerSourceFor(project('identity', entry.protocol))!
      const fetched = await source.fetch({
        listTools: scopeTools,
        callTool: async () => entry.reply,
      })
      expect(fetched.tasks.map((task) => task.externalId)).toEqual([
        `${entry.protocol.split('-')[0]}-uuid`,
      ])
    }
  })

  for (const protocol of ['workspace-mcp', 'cursor-mcp'] as const) {
    test(`${protocol} incremental reads send the declared filter and page without statuses`, async () => {
      const trackerProject = project(protocol, protocol)
      trackerProject.settings.tracker!.updatedSince = true
      const source = trackerSourceFor(trackerProject)!
      const calls: Record<string, unknown>[] = []
      const fetched = await source.fetch(
        {
          listTools: scopeTools,
          async callTool(_name, args) {
            calls.push(args)
            if (protocol === 'workspace-mcp') {
              return {
                tasks: [
                  {
                    id: `workspace-${calls.length}`,
                    short_id: `WOR-${calls.length}`,
                    status: calls.length === 1 ? 'todo' : 'done',
                    updated_at: '2026-11-06T11:55:00.000Z',
                  },
                ],
                last_page: 2,
              }
            }
            return {
              data: {
                items: [
                  {
                    id: `cursor-${calls.length}`,
                    humanKey: `CUR-${calls.length}`,
                    status: calls.length === 1 ? 'todo' : 'done',
                    updatedAt: '2026-11-06T11:55:00.000Z',
                  },
                ],
                ...(calls.length === 1 ? { nextCursor: 'page-2' } : {}),
              },
            }
          },
        },
        '2026-11-06T11:50:00.000Z',
      )

      expect(calls).toEqual(
        protocol === 'workspace-mcp'
          ? [
              {
                updated_since: '2026-11-06T11:50:00.000Z',
                team_id: 'Platform',
                page: 1,
                per_page: 100,
              },
              {
                updated_since: '2026-11-06T11:50:00.000Z',
                team_id: 'Platform',
                page: 2,
                per_page: 100,
              },
            ]
          : [
              {
                updatedSince: '2026-11-06T11:50:00.000Z',
                projectId: '019d9699-a223-729f-a032-50de9fdf4303',
                limit: 100,
              },
              {
                updatedSince: '2026-11-06T11:50:00.000Z',
                projectId: '019d9699-a223-729f-a032-50de9fdf4303',
                limit: 100,
                cursor: 'page-2',
              },
            ],
      )
      expect(fetched.tasks.map((task) => [task.category, task.updatedAt])).toEqual([
        ['open', '2026-11-06T11:55:00.000Z'],
        ['done', '2026-11-06T11:55:00.000Z'],
      ])
    })
  }

  test('cursor-mcp incremental reads skip and count soft-deleted rows', async () => {
    const source = trackerSourceFor(project('stopal', 'cursor-mcp'))!
    const fetched = await source.fetch(
      {
        listTools: scopeTools,
        callTool: async () => ({
          data: {
            items: [
              { id: 'gone', humanKey: 'STO-1', deletedAt: '2026-11-06T11:59:00.000Z' },
              { id: 'kept', humanKey: 'STO-2', status: 'todo' },
            ],
          },
        }),
      },
      '2026-11-06T11:50:00.000Z',
    )
    expect(fetched.deletedKeys).toEqual(['STO-1'])
    expect(fetched.tasks.map((task) => task.key)).toEqual(['STO-2'])
  })

  test('workspace-mcp incremental reads skip rows without a status', async () => {
    const trackerProject = project('starship', 'workspace-mcp')
    trackerProject.settings.tracker!.updatedSince = true
    const source = trackerSourceFor(trackerProject)!
    const fetched = await source.fetch(
      {
        listTools: scopeTools,
        callTool: async () => ({
          tasks: [
            { id: 'missing-status', short_id: 'STAR-1', summary: 'No status' },
            { id: 'kept', short_id: 'STAR-2', summary: 'Has status', status: 'todo' },
          ],
        }),
      },
      '2026-11-06T11:50:00.000Z',
    )

    expect(fetched.tasks.map((task) => task.key)).toEqual(['STAR-2'])
    expect(fetched.complete).toBeFalse()
  })

  test('cursor-mcp incremental reads are incomplete when a row has no status', async () => {
    const trackerProject = project('stopal', 'cursor-mcp')
    trackerProject.settings.tracker!.updatedSince = true
    const source = trackerSourceFor(trackerProject)!
    const fetched = await source.fetch(
      {
        listTools: scopeTools,
        callTool: async () => ({
          data: {
            items: [
              { id: 'missing-status', humanKey: 'STO-1', title: 'No status' },
              { id: 'kept', humanKey: 'STO-2', title: 'Has status', status: 'todo' },
            ],
          },
        }),
      },
      '2026-11-06T11:50:00.000Z',
    )

    expect(fetched.tasks.map((task) => task.key)).toEqual(['STO-2'])
    expect(fetched.complete).toBeFalse()
  })

  test('incremental reads are incomplete rather than open when a status maps to no category', async () => {
    const workspace = project('starship', 'workspace-mcp')
    workspace.settings.tracker!.updatedSince = true
    const workspaceRead = await trackerSourceFor(workspace)!.fetch(
      {
        listTools: scopeTools,
        callTool: async () => ({
          tasks: [
            { id: 'unmapped', short_id: 'STAR-1', summary: 'Closed', status: 'Completed' },
            { id: 'mapped', short_id: 'STAR-2', summary: 'Done', status: 'done' },
          ],
        }),
      },
      '2026-11-06T11:50:00.000Z',
    )
    const cursor = project('stopal', 'cursor-mcp')
    cursor.settings.tracker!.updatedSince = true
    const cursorRead = await trackerSourceFor(cursor)!.fetch(
      {
        listTools: scopeTools,
        callTool: async () => ({
          data: {
            items: [
              { id: 'unmapped', humanKey: 'STO-1', title: 'Closed', status: 'Completed' },
              { id: 'mapped', humanKey: 'STO-2', title: 'Done', status: 'done' },
            ],
          },
        }),
      },
      '2026-11-06T11:50:00.000Z',
    )

    for (const read of [workspaceRead, cursorRead]) {
      expect(read.tasks.map((task) => [task.key, task.category])).toEqual([
        [read === workspaceRead ? 'STAR-2' : 'STO-2', 'done'],
      ])
      expect(read.complete).toBeFalse()
    }
  })

  test('updated-since changes a three-status two-page read from six tool calls to two', async () => {
    const trackerProject = project('starship', 'workspace-mcp')
    trackerProject.settings.tracker!.openStatuses = ['todo', 'active', 'review']
    const source = trackerSourceFor(trackerProject)!
    let calls = 0
    const caller: ToolCaller = {
      listTools: scopeTools,
      async callTool() {
        calls++
        return { tasks: [], last_page: 2 }
      },
    }
    expect((await source.fetch(caller)).complete).toBeTrue()
    expect(calls).toBe(6)
    calls = 0
    expect((await source.fetch(caller, '2026-11-06T11:50:00.000Z')).complete).toBeTrue()
    expect(calls).toBe(2)
  })

  test('a workspace read truncated at the paging bound reports partial', async () => {
    const source = trackerSourceFor(project('starship', 'workspace-mcp'))!
    let calls = 0
    const fetched = await source.fetch(
      {
        listTools: scopeTools,
        async callTool() {
          calls++
          return { tasks: [], last_page: MAX_PAGES + 1 }
        },
      },
      '2026-11-06T11:50:00.000Z',
    )
    expect(calls).toBe(MAX_PAGES)
    expect(fetched.complete).toBeFalse()
  })

  test('an incremental read reports the cursor paging bound as partial', async () => {
    const source = trackerSourceFor(project('stopal', 'cursor-mcp'))!
    let calls = 0
    const fetched = await source.fetch(
      {
        listTools: scopeTools,
        async callTool() {
          calls++
          return { data: { items: [], nextCursor: `page-${calls + 1}` } }
        },
      },
      '2026-11-06T11:50:00.000Z',
    )
    expect(calls).toBe(MAX_PAGES)
    expect(fetched.complete).toBeFalse()
  })

  test('names a project whose tracker is missing envPrefix', () => {
    expect(() =>
      trackerSourceFor({
        name: 'adanim',
        settings: { tracker: { protocol: 'array-mcp' } },
      }),
    ).toThrow('project adanim tracker is missing envPrefix')
  })

  test('names an unrecognized protocol', () => {
    expect(() =>
      trackerSourceFor({
        name: 'future',
        settings: { tracker: { protocol: 'future-mcp', envPrefix: 'FUTURE' } },
      }),
    ).toThrow('project future tracker has unrecognized protocol future-mcp')
  })

  test('a correctly configured tracker still builds', () => {
    expect(trackerSourceFor(project('working', 'array-mcp'))).toMatchObject({
      project: 'working',
      env: 'FIXTURE',
    })
  })

  test('a project with no tracker remains intentionally absent', () => {
    expect(trackerSourceFor(project('untracked'))).toBeNull()
  })
})
