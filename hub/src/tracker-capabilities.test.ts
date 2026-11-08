import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  CURSOR_CREATE_REFUSAL,
  TASK_STATUSES,
  TRACKER_PROTOCOLS,
  type TrackerProject,
  trackerSourceFor,
} from '../../shared/trackers.ts'
import {
  documentsRefusal,
  GIT_WRITE_REFUSAL,
  TRACKER_BODY_WRITE_REFUSAL,
  TRACKER_COMMENT_WRITE_REFUSAL,
  TRACKER_TITLE_WRITE_REFUSAL,
  trackerCapabilities,
  UNKNOWN_TRACKER_REFUSAL,
} from './tracker-capabilities.ts'

const project = (
  name: string,
  protocol?: 'workspace-mcp' | 'cursor-mcp' | 'array-mcp',
): TrackerProject => ({
  name,
  settings: protocol
    ? {
        tracker: {
          protocol,
          envPrefix: 'FIXTURE',
          team: 'team',
          projectId: '019d9699-a223-729f-a032-50de9fdf4303',
          openStatuses: ['todo'],
          states: { todo: 'backlog', done: 'done' },
        },
      }
    : {},
})

describe('tracker capabilities', () => {
  test('every protocol derives status capability from its source and scopes list requests', async () => {
    for (const protocol of TRACKER_PROTOCOLS) {
      const fixture = project(protocol, protocol === 'hub' ? undefined : protocol)
      if (protocol === 'hub') fixture.settings.tracker = { protocol: 'hub' }
      const source = trackerSourceFor(fixture)
      expect(
        trackerCapabilities({ source: 'mcp', project: fixture }).setStatus.allowed,
        protocol,
      ).toBe(source?.writeStatus !== undefined)
      if (!source) continue
      const calls: { name: string; args: Record<string, unknown> }[] = []
      await source.fetch({
        async listTools() {
          return [
            {
              name:
                protocol === 'workspace-mcp'
                  ? 'list-tasks-tool'
                  : protocol === 'cursor-mcp'
                    ? 'task.list'
                    : 'task_list',
              inputSchema: {
                properties:
                  protocol === 'workspace-mcp'
                    ? { team_id: {} }
                    : protocol === 'cursor-mcp'
                      ? { projectId: {} }
                      : {},
              },
            },
          ]
        },
        async callTool(name, args) {
          calls.push({ name, args })
          if (protocol === 'workspace-mcp') return { tasks: [] }
          if (protocol === 'cursor-mcp') return { data: { items: [] } }
          return []
        },
      })
      if (protocol === 'workspace-mcp') expect(calls[0]?.args.team_id).toBe('team')
      if (protocol === 'cursor-mcp') {
        expect(calls[0]?.args.projectId).toBe('019d9699-a223-729f-a032-50de9fdf4303')
      }
    }
  })

  test('local records expose every hub write', () => {
    expect(trackerCapabilities({ source: 'local', project: project('workshop') })).toEqual({
      create: { allowed: true },
      setStatus: { allowed: true },
      setTitle: { allowed: true },
      setBody: { allowed: true },
      comment: { allowed: true },
      documents: { allowed: true },
      statusVocabulary: [...TASK_STATUSES],
      keyFormat: null,
    })
  })

  for (const protocol of ['workspace-mcp', 'cursor-mcp'] as const) {
    test(`${protocol} exposes its evidenced create and status support`, () => {
      expect(
        trackerCapabilities({ source: 'mcp', project: project('external', protocol) }),
      ).toEqual({
        create: { allowed: true },
        setStatus: { allowed: true },
        setTitle: { allowed: false, reason: TRACKER_TITLE_WRITE_REFUSAL },
        setBody: { allowed: false, reason: TRACKER_BODY_WRITE_REFUSAL },
        comment: { allowed: false, reason: TRACKER_COMMENT_WRITE_REFUSAL },
        documents: { allowed: false, reason: documentsRefusal(protocol) },
        statusVocabulary: ['todo', 'done'],
        keyFormat: null,
      })
    })
  }

  test('array-mcp exposes its evidenced status writer', () => {
    expect(
      trackerCapabilities({ source: 'mcp', project: project('external', 'array-mcp') }),
    ).toMatchObject({
      create: { allowed: true },
      setStatus: { allowed: true },
      setTitle: { allowed: false, reason: TRACKER_TITLE_WRITE_REFUSAL },
    })
  })

  test('cursor-mcp create capability refuses without projectId and names the remedy', () => {
    const missingProjectId = project('stopal', 'cursor-mcp')
    delete missingProjectId.settings.tracker!.projectId
    expect(trackerCapabilities({ source: 'mcp', project: missingProjectId }).create).toEqual({
      allowed: false,
      reason:
        `${CURSOR_CREATE_REFUSAL}; set it with: ` +
        `${PLATFORM_SLUG} project set stopal --settings '{"tracker":{"projectId":"…"}}'`,
    })
  })

  test('status capability preserves a source-construction refusal', () => {
    const missingEnv = project('workspace', 'workspace-mcp')
    delete missingEnv.settings.tracker!.envPrefix
    expect(trackerCapabilities({ source: 'mcp', project: missingEnv }).setStatus).toEqual({
      allowed: false,
      reason: 'project workspace tracker is missing envPrefix',
    })
  })

  test('git and unknown provenance are read-only with their own exact reasons', () => {
    const git = trackerCapabilities({
      source: 'git',
      project: {
        name: 'old',
        settings: { keyPrefixes: ['OLD', 'LEG'], tracker: { protocol: 'array-mcp' } },
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
