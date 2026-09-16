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
  protocol: 'mcp',
  server: 'fixture',
  read: ['get_doc'],
  write: ['set_doc'],
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

  test('resolves every requested fact with its stored type', () => {
    const project: Project = {
      id: 1,
      name: 'fixture',
      path: '/fixture',
      stack: 'node',
      canon: true,
      retiredAt: null,
      settings: {
        tracker: { kind: 'fixture', protocol: 'array-mcp' },
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
    const typedDocs: DocsSettings = resolved.docs

    expect({ ...resolved, release: typedRelease, docs: typedDocs }).toEqual({
      tracker: { kind: 'fixture', protocol: 'array-mcp' },
      gate: 'bun run check',
      worktree: { branch: '{key}-orch-{id}' },
      release,
      docs,
      stack: 'node',
    })
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
        `- docs; set with: orch project set fixture --settings '{"docs":{"protocol":"<orch-docs|mcp>"}}'\n` +
        '- stack; set with: orch project set fixture --stack <stack>',
    )
  })
})
