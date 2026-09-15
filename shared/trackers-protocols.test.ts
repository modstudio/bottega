import { describe, expect, test } from 'bun:test'
import {
  CURSOR_CREATE_REFUSAL,
  createTrackerTask,
  documentsRefusal,
  GIT_WRITE_REFUSAL,
  TASK_STATUSES,
  type ToolCaller,
  TRACKER_COMMENT_WRITE_REFUSAL,
  TRACKER_STATUS_WRITE_REFUSAL,
  TRACKER_TITLE_WRITE_REFUSAL,
  type TrackerProject,
  trackerCapabilities,
  trackerSourceFor,
  UNKNOWN_TRACKER_REFUSAL,
  WORKSPACE_CREATE_REFUSAL,
} from './trackers.ts'

const task = { title: 'Move the adapter', body: 'Protocol-neutral body', status: 'todo' }

const project = (name: string, protocol?: string): TrackerProject => ({
  name,
  settings: protocol
    ? {
        tracker: {
          protocol,
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

  test('workspace-mcp refuses its incompatible evidenced status fields', async () => {
    const fixture = fixtureCaller()

    await expect(
      createTrackerTask(fixture.caller, project('starship', 'workspace-mcp'), task),
    ).rejects.toThrow('workspace-mcp create refused: the status field differs')
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
  test('names a project whose tracker is missing envPrefix', () => {
    expect(() =>
      trackerSourceFor({
        name: 'adanim',
        settings: { tracker: { protocol: 'array-mcp' } },
      }),
    ).toThrow('project adanim tracker is missing envPrefix')
  })

  test('names an unrecognised protocol', () => {
    expect(() =>
      trackerSourceFor({
        name: 'future',
        settings: { tracker: { protocol: 'future-mcp', envPrefix: 'FUTURE' } },
      }),
    ).toThrow('project future tracker has unrecognised protocol future-mcp')
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
          protocol === 'array-mcp'
            ? { allowed: true }
            : {
                allowed: false,
                reason:
                  protocol === 'workspace-mcp' ? WORKSPACE_CREATE_REFUSAL : CURSOR_CREATE_REFUSAL,
              },
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
