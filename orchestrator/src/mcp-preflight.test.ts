import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../test/fixtures/store.ts'
import { AGENTS } from './agent/agent-registry.ts'
import {
  assertGrokTrustEligible,
  canonSourceFor,
  canonSourceInstruction,
  effectiveMcpRequest,
  mcpAttachRefusal,
  mcpRequestFromStored,
  preflightMcp,
} from './mcp-preflight.ts'
import { upsertProject, type WorktreeTool } from './projects.ts'

const fixtureFiles: string[] = []
const fixtureFile = (name: string) => {
  const path = join(dir, name)
  fixtureFiles.push(path)
  return path
}
afterEach(() => {
  for (const path of fixtureFiles.splice(0)) rmSync(path, { force: true })
})

describe('effectiveMcpRequest', () => {
  const mcpJob = { needs: { mcp: true } }
  const nonMcpJob = { needs: {} }

  test('requires MCP when the job declares it and the caller omits a request', () => {
    expect(effectiveMcpRequest(undefined, mcpJob)).toBe(true)
  })

  test('preserves an explicit preferred request for an MCP job', () => {
    expect(effectiveMcpRequest('prefer', mcpJob)).toBe('prefer')
  })

  test('preserves an explicit required request for an MCP job', () => {
    expect(effectiveMcpRequest(true, mcpJob)).toBe(true)
  })

  test('leaves an omitted request absent for a non-MCP job', () => {
    expect(effectiveMcpRequest(undefined, nonMcpJob)).toBeUndefined()
  })

  test('preserves an explicit preferred request for a non-MCP job', () => {
    expect(effectiveMcpRequest('prefer', nonMcpJob)).toBe('prefer')
  })
})

test.each([
  [0, null, undefined],
  [1, null, 'require'],
  [2, null, 'prefer'],
  [1, 'mirror: legacy attach failed', 'prefer'],
] as const)('reads stored MCP request %i with error %s as %s', (stored, error, expected) =>
  expect(mcpRequestFromStored(stored, error)).toBe(expected),
)
test('grants only an orch-cut tree and names the invariant for a caller checkout', () => {
  expect(() =>
    assertGrokTrustEligible(
      '/tmp/orch-tree',
      { worktree: '/tmp/orch-tree', worktree_source: 'git' },
      '/tmp/orch-runs/isolates/42',
    ),
  ).not.toThrow()
  expect(() =>
    assertGrokTrustEligible(
      '/tmp/caller-checkout',
      { worktree: '/tmp/orch-tree', worktree_source: 'git' },
      '/tmp/orch-runs/isolates/42',
    ),
  ).toThrow('trust is granted only to trees orch cut')
})
test('grants trust to an orch-created no-repo isolate but not its caller checkout', () => {
  const isolate = '/tmp/orch-runs/isolates/42'
  const recorded = { id: 42, cwd: isolate, worktree: null, worktree_source: null }
  expect(() => assertGrokTrustEligible(isolate, recorded, isolate)).not.toThrow()
  expect(() => assertGrokTrustEligible('/tmp/caller-checkout', recorded, isolate)).toThrow(
    'refusing Grok trust',
  )
})
test('preflightMcp defers cwd-discovered attachment until the worker tree exists', () => {
  upsertProject({ name: 'fixture-project', path: dir, settings: {} })
  const original = AGENTS.grok!.bin
  const doctor = fixtureFile('fake-grok-preflight-doctor.sh')
  AGENTS.grok!.bin = doctor
  writeFileSync(
    doctor,
    '#!/bin/sh\nprintf \'%s\' \'{"servers":[{"name":"fixture-project","healthy":false}]}\'\n',
  )
  chmodSync(doctor, 0o755)
  try {
    expect(() =>
      preflightMcp({ mcp: true, cwd: dir, job: 'review-lens', selectedAgent: 'codex' }),
    ).not.toThrow()
    expect(() =>
      preflightMcp({ mcp: true, cwd: dir, job: 'review-lens', selectedAgent: 'grok' }),
    ).not.toThrow()
    expect(() =>
      preflightMcp({ mcp: false, cwd: dir, job: 'review-lens', selectedAgent: 'grok' }),
    ).not.toThrow()
  } finally {
    AGENTS.grok!.bin = original
  }
})
test('preflightMcp dispatches from a register-shaped legacy row with declared MCP settings', () => {
  upsertProject({
    name: 'legacy-mcp-project',
    path: dir,
    settings: {
      worktree: { create: 'scripts/worktree create "{branch}"' } as unknown as WorktreeTool,
      mcpServer: 'legacy-mcp',
      mcp: { probe_tool: 'task.list' },
    },
  })
  expect(() =>
    preflightMcp({ mcp: true, cwd: dir, job: 'mcp-query', selectedAgent: 'codex' }),
  ).not.toThrow()
})
test('preflightMcp leaves cwd-discovered config decisions until the worker tree exists', () => {
  upsertProject({ name: 'fixture-project', path: dir, settings: { mcpServer: 'orch' } })
  const original = AGENTS.grok!.bin
  const doctor = fixtureFile('fake-grok-configured-server-doctor.sh')
  AGENTS.grok!.bin = doctor
  writeFileSync(
    doctor,
    '#!/bin/sh\nprintf \'%s\' \'{"servers":[{"name":"orch","healthy":false}]}\'\n',
  )
  chmodSync(doctor, 0o755)
  try {
    expect(() =>
      preflightMcp({ mcp: true, cwd: dir, job: 'review-lens', selectedAgent: 'grok' }),
    ).not.toThrow()
    rmSync(join(dir, '.mcp.json'), { force: true })
    expect(() =>
      preflightMcp({ mcp: true, cwd: dir, job: 'review-lens', selectedAgent: 'grok' }),
    ).not.toThrow()
  } finally {
    AGENTS.grok!.bin = original
  }
})
test('maps all recorded connection states without flattening unknown', () => {
  expect(
    canonSourceFor(true, { server: 'fixture-project', connected: true, error: null }, true),
  ).toBe('live database')
  expect(
    canonSourceFor(true, { server: 'fixture-project', connected: false, error: 'down' }, true),
  ).toBe('mirror')
  expect(
    canonSourceFor(
      true,
      { server: 'fixture-project', connected: null, error: 'no diagnostic' },
      true,
    ),
  ).toBe('unknown')
})
test('a connected lens receives live-database provenance in its assembled prompt', () => {
  expect(
    canonSourceInstruction(
      canonSourceFor(true, { server: 'fixture-project', connected: true, error: null }, true),
    ),
  ).toContain('provenance.canon_source to "live database"')
})
test('a lens without --mcp receives unknown provenance and does not run the MCP doctor', () => {
  expect(canonSourceFor(false, null, false)).toBe('unknown')
})
test('a codex lens receives unknown provenance when its MCP attach cannot be diagnosed', () => {
  expect(
    canonSourceFor(
      true,
      { server: 'fixture-project', connected: null, error: 'no diagnostic' },
      true,
    ),
  ).toBe('unknown')
})
test('verify-claim keeps its verdict contract and receives the same canon provenance', () => {
  expect(canonSourceInstruction(canonSourceFor(false, null, false))).toContain(
    'provenance.canon_source to "unknown"',
  )
})
test('a user-scope required server is refused only when doctor does not report it', () => {
  expect(
    mcpAttachRefusal({
      server: 'orch',
      connected: false,
      error: "MCP server 'orch' was not reported. Available: starship, stopal",
    }),
  ).toContain("server 'orch' could not be attached")
  expect(mcpAttachRefusal({ server: 'orch', connected: true, error: null })).toBeNull()
})
test('refuses a grok lens before agent spawn and records the worker-tree preflight failure', () => {
  expect(
    mcpAttachRefusal({ server: 'fixture-project', connected: false, error: 'folder untrusted' }),
  ).toBe(
    "MCP was requested, but server 'fixture-project' could not be attached: folder untrusted The agent was not started.",
  )
})
test('prefer mode runs on the mirror and records and discloses the attachment failure', () => {
  const connection = { server: 'fixture-project', connected: false, error: 'server down' }
  expect(canonSourceFor(true, connection, true)).toBe('mirror')
  expect(mcpAttachRefusal(connection)).toContain('server down')
})
test('prefer binds mirror provenance once after a wrong-project worker-tree probe', () => {
  const prompt = canonSourceInstruction(
    canonSourceFor(
      true,
      { server: 'fixture-project', connected: false, error: 'wrong project: saw other' },
      true,
    ),
  )
  expect(prompt.match(/Canon source provenance:/g)).toHaveLength(1)
  expect(prompt).toContain('provenance.canon_source to "mirror"')
})
