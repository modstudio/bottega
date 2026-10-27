import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import {
  createTrackerTask,
  resolveTrackerAgentActions,
  type ToolCaller,
  TrackerLookupUnverifiable,
  type TrackerProject,
  trackerCreatedTaskKey,
  trackerSourceFor,
  trackerWireAction,
  updateArrayMcpTaskStatus,
  WORKSPACE_LOOKUP_PAGE_SIZE,
} from './trackers.ts'

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

    await updateArrayMcpTaskStatus(
      fixture.caller,
      project('adanim', 'array-mcp'),
      '01990000-0000-7000-8000-000000001659',
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
        if (name === 'get-task-tool') return { id: 'other-uuid', short_id: 'STAR-120', status: 'todo' }
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
      const tasks = await source.fetch({ callTool: async () => entry.reply })
      expect(tasks.map((task) => task.externalId)).toEqual([`${entry.protocol.split('-')[0]}-uuid`])
    }
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
