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
        states: { active: 'active', review: 'review', done: 'done' },
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

  test('resolves protocol defaults and replaces only an overridden action', () => {
    const expected = {
      'workspace-mcp': {
        search: 'list-tasks-tool',
        get: 'get-task-tool',
        create: 'create-task-tool',
        update: 'update-task-tool',
        status: 'update-task-tool',
        comment: 'create-task-comment-tool',
      },
      'cursor-mcp': {
        search: 'task_list',
        get: 'task_getByKey',
        create: 'task_create',
        update: 'task_update',
        status: 'task_update',
        comment: 'comment_add',
      },
      'array-mcp': {
        search: 'task_list',
        get: 'task_list',
        create: 'task_create',
        update: 'task_update',
      },
      hub: {
        search: 'hub task list --project fixture',
        get: 'hub task show {key}',
        create: 'hub task new --project fixture',
        update: 'hub task set {key}',
        status: 'hub task set {key} --status',
        comment: 'hub task comment {key}',
      },
    } as const
    for (const protocol of Object.keys(expected) as (keyof typeof expected)[]) {
      const tracker = resolveInjection(
        {
          name: 'fixture',
          stack: 'node',
          settings: {
            tracker: {
              kind: protocol === 'hub' ? 'hub' : 'fixture',
              protocol,
              actions: { status: 'custom-status' },
            },
          },
        },
        ['tracker'],
      ).tracker
      expect(tracker.actions).toEqual({ ...expected[protocol], status: 'custom-status' })
      expect(tracker.server).toBe(protocol === 'hub' ? undefined : 'fixture')
    }
  })

  test('derives the first raw state in each category and gives hub vocabulary defaults', () => {
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
