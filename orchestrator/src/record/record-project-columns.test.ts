import { describe, expect, test } from 'bun:test'
import {
  type HostedProjectColumns,
  hostedProjectColumns,
  hostedProjectSettings,
  PROJECT_SETTING_COLUMNS,
  PROJECT_SETTINGS_NOT_IMPORTED,
} from './record-project-columns.ts'

const samples = {
  visibility: { setting: 'public', column: 'visibility', value: 'public' },
  color: { setting: '#fff', column: 'color', value: '#fff' },
  colorDark: { setting: '#000', column: 'colorDark', value: '#000' },
  docs: { setting: { path: 'docs' }, column: 'docs', value: { path: 'docs' } },
  envPrefix: { setting: 'PROBE', column: 'envPrefix', value: 'PROBE' },
  gate: { setting: 'bun run check', column: 'gate', value: 'bun run check' },
  focusedTests: {
    setting: { command: 'scripts/test-focused', args: ['--ci'] },
    column: 'focusedTests',
    value: { command: 'scripts/test-focused', args: ['--ci'] },
  },
  keyPrefixes: { setting: ['DEV'], column: 'keyPrefixes', value: ['DEV'] },
  managedContext: { setting: true, column: 'managedContext', value: true },
  mcp: { setting: { probe_tool: 'ping' }, column: 'mcpProbeTool', value: 'ping' },
  mcpServer: { setting: 'orch', column: 'mcpServer', value: 'orch' },
  productionBranch: { setting: 'production', column: 'productionBranch', value: 'production' },
  reference: {
    setting: { directory: 'docs/reference', publish: 'publish-reference' },
    column: 'reference',
    value: { directory: 'docs/reference', publish: 'publish-reference' },
  },
  release: {
    setting: { mergeQueue: true },
    column: 'release',
    value: { mergeQueue: true },
  },
  requireCleanMain: { setting: false, column: 'requireCleanMain', value: false },
  secretPaths: { setting: ['secret'], column: 'secretPaths', value: ['secret'] },
  signals: {
    setting: { sources: [{ name: 'errors', list: 'error_list' }] },
    column: 'signals',
    value: { sources: [{ name: 'errors', list: 'error_list' }] },
  },
  review: {
    setting: { lenses: [{ lens: 'correctness' }] },
    column: 'review',
    value: { lenses: [{ lens: 'correctness' }] },
  },
  testSubstance: {
    setting: { phpPolicyRules: ['createMock'] },
    column: 'testSubstance',
    value: { phpPolicyRules: ['createMock'] },
  },
  mechanicalChecks: {
    setting: { naming: { tool: 'custom names' } },
    column: 'mechanicalChecks',
    value: { naming: { tool: 'custom names' } },
  },
  states: { setting: { todo: 'open' }, column: 'states', value: { todo: 'open' } },
  tracker: { setting: { kind: 'hub' }, column: 'tracker', value: { kind: 'hub' } },
  trunk: { setting: 'develop', column: 'landingBranch', value: 'develop' },
  worktree: {
    setting: { notes: 'plain git' },
    column: 'worktree',
    value: { notes: 'plain git' },
  },
  workerMcpServers: { setting: ['orch'], column: 'workerMcpServers', value: ['orch'] },
} satisfies Record<
  keyof typeof PROJECT_SETTING_COLUMNS,
  { setting: unknown; column: keyof HostedProjectColumns; value: unknown }
>

describe('hostedProjectColumns', () => {
  test('maps every settings key onto its hosted column', () => {
    expect(Object.keys(samples).sort()).toEqual(Object.keys(PROJECT_SETTING_COLUMNS).sort())
    for (const key of Object.keys(samples) as Array<keyof typeof samples>) {
      const sample = samples[key]
      const column = PROJECT_SETTING_COLUMNS[key]
      expect(column, key).toBe(sample.column)
      const columns = hostedProjectColumns({ [key]: sample.setting }, 'mapped')
      expect(columns[column], key).toEqual(sample.value)
    }
  })

  test('refuses unknown settings keys as import refuses them', () => {
    expect(() => hostedProjectColumns({ mystery: true, also: 1 }, 'probe')).toThrow(
      'project probe has unmapped settings keys: also, mystery',
    )
  })

  test('ignores local-only settings keys', () => {
    const notImported = Object.fromEntries(
      PROJECT_SETTINGS_NOT_IMPORTED.map(({ key }) => [key, { ignored: true }]),
    )
    expect(hostedProjectColumns(notImported, 'local-only')).toMatchObject({
      keyPrefixes: [],
      managedContext: false,
      requireCleanMain: true,
      landingBranch: null,
    })
  })

  test('defaults managedContext off and requireCleanMain on', () => {
    expect(hostedProjectColumns({}, 'defaults')).toMatchObject({
      managedContext: false,
      requireCleanMain: true,
      keyPrefixes: [],
    })
  })

  test('round trips probe and reader MCP settings through separate hosted columns', () => {
    const mcp = {
      probe_tool: 'ping',
      reader_tools: { starship: ['get-task', 'list-tasks'], hosted: ['search'] },
    }
    const columns = hostedProjectColumns({ mcp }, 'round-trip')
    expect(columns.mcpProbeTool).toBe('ping')
    expect(columns.mcpReaderTools).toEqual({
      starship: ['get-task', 'list-tasks'],
      hosted: ['search'],
    })
    expect({
      probe_tool: columns.mcpProbeTool,
      reader_tools: columns.mcpReaderTools,
    }).toEqual(mcp)
  })

  test('absent MCP settings keep both hosted columns null', () => {
    const columns = hostedProjectColumns({}, 'absent')
    expect(columns.mcpProbeTool).toBeNull()
    expect(columns.mcpReaderTools).toBeNull()
  })

  test('maps hosted columns back to local project settings', () => {
    const columns = hostedProjectColumns(
      {
        trunk: 'main',
        managedContext: true,
        requireCleanMain: false,
        mcp: { probe_tool: 'ping', reader_tools: { orch: ['list'] } },
      },
      'round-trip',
    )
    expect(hostedProjectSettings(columns)).toMatchObject({
      trunk: 'main',
      managedContext: true,
      requireCleanMain: false,
      mcp: { probe_tool: 'ping', reader_tools: { orch: ['list'] } },
    })
  })
})
