import { describe, expect, test } from 'bun:test'
import { type DocsSettings, type ReleaseSettings, resolveInjection } from './project-injection.ts'
import { type Project, validateProjectSettings } from './projects.ts'

const release: ReleaseSettings = {
  rungs: [{ name: 'production', branch: 'production', deploy: 'bun run deploy' }],
  mergeMethod: 'squash',
  deployCommand: 'bun run deploy',
  requiredChecks: ['gate'],
  observationWindowHours: 24,
}

const docs: DocsSettings = {
  protocol: 'array-mcp',
}

describe('project workflow injection', () => {
  test('valid release and docs settings pass while unknown keys are refused', () => {
    expect(validateProjectSettings({ release, docs, gate: 'bun run check' })).toEqual([])

    expect(
      validateProjectSettings({
        release: { ...release, unexpected: true },
      } as Parameters<typeof validateProjectSettings>[0]),
    ).toEqual([expect.stringContaining('release: Unrecognized key')])
  })

  test('refuses an unknown tracker action override at the register edge', () => {
    expect(
      validateProjectSettings({
        tracker: {
          kind: 'fixture',
          protocol: 'workspace-mcp',
          actions: { archive: 'archive-task-tool' },
        } as Project['settings']['tracker'],
      }),
    ).toEqual([expect.stringContaining('tracker.actions: Unrecognized key')])
  })

  test('accepts only MCP tool names and refuses every hub action override with a remedy', () => {
    expect(
      validateProjectSettings({
        tracker: {
          protocol: 'workspace-mcp',
          actions: { get: 'task_get; rm -rf checkout' },
        },
      }),
    ).toEqual([expect.stringContaining('must be a plain MCP tool name')])
    expect(
      validateProjectSettings({
        tracker: { protocol: 'hub', actions: { get: 'hub task show {key}; rm -rf checkout' } },
      }).join('\n'),
    ).toContain('tracker.actions: hub protocol accepts no action overrides; remove tracker.actions')
  })

  test('resolves every requested fact with its stored type', () => {
    const project: Project = {
      id: 1,
      name: 'fixture',
      path: '/fixture',
      stack: 'node',
      canon: true,
      retiredAt: null,
      settings: {
        tracker: {
          kind: 'fixture',
          protocol: 'array-mcp',
          actions: { update: 'fixture_task_update' },
        },
        gate: 'bun run check',
        worktree: { branch: '{key}-orch-{id}' },
        release,
        docs,
      },
    }

    const resolved = resolveInjection(project, [
      'tracker',
      'gate',
      'worktree',
      'release',
      'docs',
      'stack',
    ])
    const typedRelease: ReleaseSettings = resolved.release
    const typedDocs = resolved.docs

    expect({ ...resolved, release: typedRelease, docs: typedDocs }).toEqual({
      tracker: {
        kind: 'fixture',
        protocol: 'array-mcp',
        server: 'fixture',
        actions: {
          search: 'task_list',
          get: 'task_list',
          create: 'task_create',
          update: 'fixture_task_update',
        },
        states: {},
      },
      gate: 'bun run check',
      worktree: { branch: '{key}-orch-{id}' },
      release,
      docs: {
        protocol: 'array-mcp',
        server: 'fixture',
        read: ['doc_search', 'doc_get', 'doc_list'],
        write: ['doc_create', 'doc_update'],
      },
      stack: 'node',
    })
  })

  test('replaces an action override and substitutes valid hub placeholders', () => {
    const remote = resolveInjection(
      {
        name: 'fixture',
        stack: 'node',
        settings: {
          tracker: { protocol: 'array-mcp', actions: { status: 'custom-status' } },
        },
      },
      ['tracker'],
    ).tracker
    expect(remote.actions).toMatchObject({ search: 'task_list', status: 'custom-status' })

    const hub = resolveInjection(
      {
        name: 'fixture',
        stack: 'node',
        settings: { tracker: { protocol: 'hub' } },
      },
      ['tracker'],
      { key: 'DEV-661' },
    ).tracker
    expect(hub.actions.search).toBe('hub task list --project fixture')
    expect(hub.actions.get).toBe('hub task show DEV-661')
  })

  test('derives only declared remote states and gives hub vocabulary defaults', () => {
    expect(validateProjectSettings({ tracker: { kind: 'hub', protocol: 'hub' } })).toEqual([])
    const mapped = resolveInjection(
      {
        name: 'fixture',
        stack: 'node',
        settings: {
          tracker: {
            kind: 'workspace',
            protocol: 'workspace-mcp',
            states: {
              started: 'active',
              working: 'active',
              checking: 'review',
              completed: 'done',
            },
          },
        },
      },
      ['tracker'],
    ).tracker
    expect(mapped.states).toEqual({ active: 'started', review: 'checking', done: 'completed' })

    const incomplete = resolveInjection(
      {
        name: 'fixture',
        stack: 'node',
        settings: {
          tracker: { protocol: 'workspace-mcp', states: { completed: 'done' } },
        },
      },
      ['tracker'],
    ).tracker
    expect(incomplete.states).toEqual({ done: 'completed' })

    const hub = resolveInjection(
      {
        name: 'fixture',
        stack: 'node',
        settings: { tracker: { kind: 'hub', protocol: 'hub' } },
      },
      ['tracker'],
      { key: 'DEV-661' },
    ).tracker
    expect(hub.states).toEqual({ active: 'active', review: 'review', done: 'done' })
    expect(hub.actions.get).toBe('hub task show DEV-661')
  })

  test('leaves placeholders unsubstituted for hostile project and key values', () => {
    const hostileProject = resolveInjection(
      {
        name: 'fixture; touch owned',
        stack: 'node',
        settings: { tracker: { protocol: 'hub' } },
      },
      ['tracker'],
      { key: 'DEV-661' },
    ).tracker
    expect(hostileProject.actions.search).toBe('hub task list --project {project}')

    const hostileKey = resolveInjection(
      {
        name: 'fixture',
        stack: 'node',
        settings: { tracker: { protocol: 'hub' } },
      },
      ['tracker'],
      { key: 'DEV-1; cat secrets' },
    ).tracker
    expect(hostileKey.actions.get).toBe('hub task show {key}')
  })

  test('the register edge refuses a missing or unsupported tracker protocol', () => {
    expect(validateProjectSettings({ tracker: {} }).join('\n')).toContain('tracker.protocol')
    expect(validateProjectSettings({ tracker: { protocol: 'made-up' } }).join('\n')).toContain(
      'tracker.protocol',
    )
  })

  test('substitutes underscore names and keys, and ignores a stored hub override', () => {
    const tracker = resolveInjection(
      {
        name: 'fixture_name',
        stack: 'node',
        settings: {
          tracker: { protocol: 'hub', actions: { get: 'hub task show {key}; cat secrets' } },
        },
      },
      ['tracker'],
      { key: 'DEV_661' },
    ).tracker
    expect(tracker.actions.search).toBe('hub task list --project fixture_name')
    expect(tracker.actions.get).toBe('hub task show DEV_661')
  })

  test('one refusal names every missing fact and its project update command', () => {
    const project: Project = {
      id: 1,
      name: 'fixture',
      path: '/fixture',
      stack: null,
      canon: true,
      retiredAt: null,
      settings: {},
    }

    expect(() => resolveInjection(project, ['docs', 'stack'])).toThrow(
      'project fixture is missing workflow injection facts:\n' +
        `- docs; set with: orch project set fixture --settings '{"docs":{"protocol":"<orch-docs|workspace-mcp|cursor-mcp|array-mcp>"}}'\n` +
        '- stack; set with: orch project set fixture --stack <stack>',
    )
  })
})
