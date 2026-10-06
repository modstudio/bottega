import { describe, expect, test } from 'bun:test'
import {
  type DocsSettings,
  type ReleaseSettings,
  resolveDeclaredFacts,
  resolveInjection,
} from './project-injection.ts'
import { type Project, validateProjectSettings } from './projects.ts'

const release: ReleaseSettings = {
  rungs: [
    {
      name: 'production',
      branch: 'production',
      deploy: 'bun run deploy',
      live: 'curl -fsS https://example.test/version | jq -r .commit',
    },
  ],
  mergeMethod: 'squash',
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

  test('validates a rung live command as a non-empty string', () => {
    expect(
      validateProjectSettings({
        release: { ...release, rungs: [{ ...release.rungs[0]!, live: ' ' }] },
      }),
    ).toEqual([expect.stringContaining('release.rungs.0.live: Too small')])
  })

  test('refuses the retired release.deployCommand instead of silently accepting it', () => {
    expect(
      validateProjectSettings({
        release: { ...release, deployCommand: 'bun run deploy' },
      } as Parameters<typeof validateProjectSettings>[0]),
    ).toEqual([
      'release.deployCommand: retired; move the command onto a rung: release.rungs[].deploy',
    ])
  })

  test('accepts a sole landing-branch rung carrying deploy (mutation: remove rungs[].deploy)', () => {
    expect(
      validateProjectSettings({
        trunk: 'main',
        release: {
          rungs: [{ name: 'production', branch: 'main', deploy: 'bun run deploy' }],
          mergeMethod: 'squash',
          requiredChecks: ['gate'],
        },
      }),
    ).toEqual([])
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

  test('validates tracker team as a non-empty register string', () => {
    expect(
      validateProjectSettings({ tracker: { protocol: 'workspace-mcp', team: 'Platform' } }),
    ).toEqual([])
    expect(validateProjectSettings({ tracker: { protocol: 'workspace-mcp', team: ' ' } })).toEqual([
      expect.stringContaining('tracker.team: Too small'),
    ])
  })

  test('accepts a cursor-mcp project UUID and refuses invalid or cross-protocol values', () => {
    expect(
      validateProjectSettings({
        tracker: {
          protocol: 'cursor-mcp',
          projectId: '019d9699-a223-729f-a032-50de9fdf4303',
        },
      }),
    ).toEqual([])
    expect(
      validateProjectSettings({
        tracker: { protocol: 'cursor-mcp', projectId: 'not-a-uuid' },
      }),
    ).toEqual([expect.stringContaining('tracker.projectId: Invalid UUID')])
    expect(
      validateProjectSettings({
        tracker: {
          protocol: 'workspace-mcp',
          projectId: '019d9699-a223-729f-a032-50de9fdf4303',
        },
      }),
    ).toEqual([expect.stringContaining('tracker.projectId: projectId is accepted only by')])
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
          status: 'task_update',
          document: 'task_addDocument',
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

  test('workspace facts include the document action (mutation: drop the action)', () => {
    const { facts } = resolveDeclaredFacts(
      {
        name: 'starship',
        stack: 'php-laravel-vue',
        settings: { tracker: { protocol: 'workspace-mcp' } },
      },
      ['tracker'],
    )

    expect(facts.tracker?.actions.document).toBe('create-task-document-tool')
  })

  test('facts omit an unsupported document action (mutation: invent a cursor action)', () => {
    const { facts } = resolveDeclaredFacts(
      {
        name: 'stopal',
        stack: 'node-drizzle',
        settings: { tracker: { protocol: 'cursor-mcp' } },
      },
      ['tracker'],
    )

    expect(facts.tracker?.actions).not.toHaveProperty('document')
  })

  test('register document override replaces the default (mutation: ignore the override)', () => {
    const tracker = { protocol: 'workspace-mcp' as const, actions: { document: 'custom_document' } }
    expect(validateProjectSettings({ tracker })).toEqual([])

    const { facts } = resolveDeclaredFacts(
      {
        name: 'starship',
        stack: 'php-laravel-vue',
        settings: { tracker },
      },
      ['tracker'],
    )

    expect(facts.tracker?.actions.document).toBe('custom_document')
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

  test('the register edge refuses a blank or non-string trunk', () => {
    for (const trunk of ['', '   ', 42]) {
      expect(
        validateProjectSettings({ trunk } as Parameters<typeof validateProjectSettings>[0]).join(
          '\n',
        ),
      ).toContain('trunk')
    }
  })

  test('the register edge refuses a missing or unsupported tracker protocol', () => {
    expect(validateProjectSettings({ tracker: {} }).join('\n')).toContain('tracker.protocol')
    expect(validateProjectSettings({ tracker: { protocol: 'made-up' } }).join('\n')).toContain(
      'tracker.protocol',
    )
  })

  test('the register edge refuses shell syntax in a tracker kind or state name', () => {
    expect(
      validateProjectSettings({ tracker: { protocol: 'hub', kind: 'hub; cat secrets' } }).join(
        '\n',
      ),
    ).toContain('must be a plain name')
    expect(
      validateProjectSettings({
        tracker: { protocol: 'workspace-mcp', states: { 'active; cat secrets': 'active' } },
      }).join('\n'),
    ).toContain('Invalid key in record')
    expect(
      validateProjectSettings({
        tracker: { protocol: 'cursor-mcp', kind: 'stopal', states: { 'In Progress': 'active' } },
      }),
    ).toEqual([])
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
