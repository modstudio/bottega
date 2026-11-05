import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { claudeMcpPlacementPath } from '../../../shared/state-directory.ts'
import { stableMcpServers } from '../setup/setup-mcp.ts'
import {
  readClaudeMcpPlacement,
  reconcileClaudeMcpPlacementPlan,
  writeClaudeMcpPlacement,
} from './settings-machine-mcp-placement.ts'
import { decideMachineSettingsScope } from './settings-machine-scope.ts'

test('round trips the machine-only Claude MCP placement record', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-mcp-placement-'))
  const environment = { BOTTEGA_STATE_HOME: root }
  try {
    expect(readClaudeMcpPlacement(environment)).toBeNull()
    const placement = { scope: 'local' as const, projectPaths: ['/projects/one'] }
    writeClaudeMcpPlacement(environment, placement)
    expect(readClaudeMcpPlacement(environment)).toEqual(placement)
    expect(JSON.parse(readFileSync(claudeMcpPlacementPath(environment), 'utf8'))).toEqual(placement)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses an invalid Claude MCP placement record', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-mcp-placement-'))
  const environment = { BOTTEGA_STATE_HOME: root }
  const path = claudeMcpPlacementPath(environment)
  try {
    writeClaudeMcpPlacement(environment, { scope: 'user', projectPaths: [] })
    writeFileSync(path, '{"scope":"local","projectPaths":"wrong"}\n')
    expect(() => readClaudeMcpPlacement(environment)).toThrow(
      `invalid Claude MCP placement record ${path}`,
    )
    expect(dirname(path)).toContain('orchestrator')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('first global user placement records state without resolving or calling Claude', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-mcp-placement-'))
  const environment = { BOTTEGA_STATE_HOME: root }
  let portCalls = 0
  try {
    const results = reconcileClaudeMcpPlacementPlan(false, decideMachineSettingsScope('on', []), {
      environment,
      port: () => {
        portCalls++
        return null
      },
      server: stableMcpServers()[0]!,
      read: readClaudeMcpPlacement,
      write: writeClaudeMcpPlacement,
      reconcile: () => {
        throw new Error('unexpected reconcile')
      },
      mutate: () => {
        throw new Error('unexpected mutation')
      },
    })
    expect(results).toEqual([{ target: 'MCP claude user', outcome: 'current', changed: false }])
    expect(portCalls).toBe(0)
    expect(readClaudeMcpPlacement(environment)).toEqual({ scope: 'user', projectPaths: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('first local placement reads user once, then writes projects without readbacks', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-mcp-placement-'))
  const environment = { BOTTEGA_STATE_HOME: root }
  let reads = 0
  const mutations: Array<{ action: string; cwd?: string }> = []
  const plan = decideMachineSettingsScope('off', [
    { path: '/projects/one', exists: true, gitMainCheckout: true },
    { path: '/projects/two', exists: true, gitMainCheckout: true },
  ])
  try {
    reconcileClaudeMcpPlacementPlan(false, plan, {
      environment,
      port: () => ({ bin: 'claude', runner: () => fixtureCommandResult() }),
      server: stableMcpServers()[0]!,
      read: readClaudeMcpPlacement,
      write: writeClaudeMcpPlacement,
      reconcile: () => {
        reads++
        return { changed: true }
      },
      mutate: ({ action, cwd }) => mutations.push({ action, cwd }),
    })
    expect(reads).toBe(1)
    expect(mutations).toEqual([
      { action: 'add', cwd: '/projects/one' },
      { action: 'add', cwd: '/projects/two' },
    ])
    expect(readClaudeMcpPlacement(environment)).toEqual({
      scope: 'local',
      projectPaths: ['/projects/one', '/projects/two'],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed recorded removal converges through one scoped reconcile', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-mcp-placement-'))
  const environment = { BOTTEGA_STATE_HOME: root }
  const reconciles: Array<{ scope: string; present: boolean }> = []
  try {
    writeClaudeMcpPlacement(environment, { scope: 'user', projectPaths: [] })
    const results = reconcileClaudeMcpPlacementPlan(
      false,
      decideMachineSettingsScope('off', [
        { path: '/projects/one', exists: true, gitMainCheckout: true },
      ]),
      {
        environment,
        port: () => ({ bin: 'claude', runner: () => fixtureCommandResult() }),
        server: stableMcpServers()[0]!,
        read: readClaudeMcpPlacement,
        write: writeClaudeMcpPlacement,
        reconcile: (input) => {
          reconciles.push({ scope: input.scope, present: input.present })
          return { changed: false }
        },
        mutate: ({ action }) => {
          if (action === 'remove') throw new Error('already absent')
        },
      },
    )
    expect(reconciles).toEqual([{ scope: 'user', present: false }])
    expect(results.every((result) => result.outcome !== 'refused')).toBe(true)
    expect(readClaudeMcpPlacement(environment)).toEqual({
      scope: 'local',
      projectPaths: ['/projects/one'],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixtureCommandResult() {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, error: null }
}
