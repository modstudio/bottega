import { describe, expect, test } from 'bun:test'
import {
  CURSOR_CREATE_REFUSAL,
  createTrackerTask,
  documentsRefusal,
  GIT_WRITE_REFUSAL,
  resolveTrackerAgentActions,
  TASK_STATUSES,
  type ToolCaller,
  TRACKER_COMMENT_WRITE_REFUSAL,
  TRACKER_STATUS_WRITE_REFUSAL,
  TRACKER_TITLE_WRITE_REFUSAL,
  type TrackerProject,
  trackerCapabilities,
  trackerCreatedTaskKey,
  trackerSourceFor,
  trackerWireAction,
  UNKNOWN_TRACKER_REFUSAL,
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
    ).rejects.toThrow(`orch project set starship --settings '{"tracker":{"team":"…"}}'`)
    expect(fixture.calls).toEqual([])
  })

  test('cursor-mcp refuses the required field absent from the register', async () => {
    const fixture = fixtureCaller()

    await expect(
      createTrackerTask(fixture.caller, project('stopal', 'cursor-mcp'), task),
    ).rejects.toThrow('cursor-mcp create refused: required projectId')
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

describe('tracker source construction', () => {
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

describe('tracker capabilities', () => {
  test('local records expose every hub write', () => {
    expect(trackerCapabilities({ source: 'local', project: project('workshop') })).toEqual({
      create: { allowed: true },
      setStatus: { allowed: true },
      setTitle: { allowed: true },
      comment: { allowed: true },
      documents: { allowed: true },
      statusVocabulary: [...TASK_STATUSES],
      keyFormat: null,
    })
  })

  for (const protocol of ['workspace-mcp', 'cursor-mcp', 'array-mcp'] as const) {
    test(`${protocol} exposes only its evidenced create support`, () => {
      const capabilities = trackerCapabilities({
        source: 'mcp',
        project: project('external', protocol),
      })
      expect(capabilities).toEqual({
        create:
          protocol === 'array-mcp' || protocol === 'workspace-mcp'
            ? { allowed: true }
            : { allowed: false, reason: CURSOR_CREATE_REFUSAL },
        setStatus: { allowed: false, reason: TRACKER_STATUS_WRITE_REFUSAL },
        setTitle: { allowed: false, reason: TRACKER_TITLE_WRITE_REFUSAL },
        comment: { allowed: false, reason: TRACKER_COMMENT_WRITE_REFUSAL },
        documents: { allowed: false, reason: documentsRefusal(protocol) },
        statusVocabulary: ['todo', 'done'],
        keyFormat: null,
      })
    })
  }

  test('git and unknown MCP provenance are read-only with their own exact reasons', () => {
    const git = trackerCapabilities({
      source: 'git',
      project: {
        name: 'old',
        settings: {
          keyPrefixes: ['OLD', 'LEG'],
          tracker: { protocol: 'array-mcp' },
        },
      },
    })
    expect(git.keyFormat).toBe('OLD-* | LEG-*')
    expect(git.setTitle).toEqual({ allowed: false, reason: GIT_WRITE_REFUSAL })

    for (const unknown of [
      trackerCapabilities({ source: 'mcp', project: null }),
      trackerCapabilities({ source: 'git', project: null }),
      trackerCapabilities({ source: 'git', project: project('protocol-less') }),
    ]) {
      expect(unknown.statusVocabulary).toBeNull()
      expect(unknown.keyFormat).toBeNull()
      expect(unknown.setTitle).toEqual({ allowed: false, reason: UNKNOWN_TRACKER_REFUSAL })
    }
  })
})
