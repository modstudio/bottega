import { expect, test } from 'bun:test'
import { MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { machineWithMcp, orchServer } from '../../test/fixtures/setup-engine.ts'
import { resolveWorktreeLifecycle } from '../worktree/worktree-lifecycle.ts'
import { proposeSetup, type SetupAgent } from './setup-engine.ts'

function plan(harness: 'codex' | 'grok', agents: SetupAgent[]) {
  return proposeSetup(
    resolveWorktreeLifecycle,
    machineWithMcp(harness, {
      support: 'automatic',
      registrations: { [MCP_SERVER_NAME]: { status: 'absent' } },
    }),
    [],
    [],
    agents,
    [],
    [orchServer],
  )
}

test('worker-only MCP registration needs an enabled agent using the harness', () => {
  const disabled = plan('grok', [
    { name: 'grok', harness: 'grok', enabled: false, probePassed: false },
  ])
  const enabled = plan('grok', [
    { name: 'grok', harness: 'grok', enabled: true, probePassed: false },
  ])

  expect(disabled.registrations).toEqual([])
  expect(disabled.questions).not.toContainEqual(
    expect.objectContaining({ id: 'harness:grok:mcp-register' }),
  )
  expect(enabled.registrations).toHaveLength(1)
  expect(enabled.questions).toContainEqual(
    expect.objectContaining({ id: 'harness:grok:mcp-register' }),
  )
})

test('architect-capable MCP registration does not need an agent row', () => {
  expect(plan('codex', []).registrations).toHaveLength(1)
})
