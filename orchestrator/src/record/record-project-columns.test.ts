import { describe, expect, test } from 'bun:test'
import {
  type HostedProjectColumns,
  hostedProjectColumns,
  PROJECT_SETTING_COLUMNS,
  PROJECT_SETTINGS_NOT_IMPORTED,
} from './record-project-columns.ts'

const samples = {
  color: { setting: '#fff', column: 'color', value: '#fff' },
  colorDark: { setting: '#000', column: 'colorDark', value: '#000' },
  docs: { setting: { path: 'docs' }, column: 'docs', value: '{"path":"docs"}' },
  envPrefix: { setting: 'PROBE', column: 'envPrefix', value: 'PROBE' },
  gate: { setting: 'bun run check', column: 'gate', value: 'bun run check' },
  keyPrefixes: { setting: ['DEV'], column: 'keyPrefixes', value: ['DEV'] },
  managedContext: { setting: true, column: 'managedContext', value: true },
  mcp: { setting: { probe_tool: 'ping' }, column: 'mcpProbeTool', value: 'ping' },
  mcpServer: { setting: 'orch', column: 'mcpServer', value: 'orch' },
  productionBranch: { setting: 'production', column: 'productionBranch', value: 'production' },
  release: { setting: { depth: 'pr' }, column: 'release', value: '{"depth":"pr"}' },
  requireCleanMain: { setting: false, column: 'requireCleanMain', value: false },
  secretPaths: { setting: ['secret'], column: 'secretPaths', value: ['secret'] },
  signals: {
    setting: { sources: [{ name: 'errors', list: 'error_list' }] },
    column: 'signals',
    value: '{"sources":[{"name":"errors","list":"error_list"}]}',
  },
  review: {
    setting: { lenses: [{ lens: 'correctness' }] },
    column: 'review',
    value: '{"lenses":[{"lens":"correctness"}]}',
  },
  testSubstance: {
    setting: { phpPolicyRules: ['createMock'] },
    column: 'testSubstance',
    value: '{"phpPolicyRules":["createMock"]}',
  },
  states: { setting: { todo: 'open' }, column: 'states', value: '{"todo":"open"}' },
  tracker: { setting: { kind: 'hub' }, column: 'tracker', value: '{"kind":"hub"}' },
  trunk: { setting: 'develop', column: 'landingBranch', value: 'develop' },
  worktree: { setting: { notes: 'plain git' }, column: 'worktree', value: '{"notes":"plain git"}' },
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
})
