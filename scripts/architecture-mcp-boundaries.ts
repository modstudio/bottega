import { dirname, normalize } from 'node:path'
import type { ImportBoundary } from './architecture-boundaries.ts'

const boundary = (
  name: string,
  file: string,
  allowed: string[],
  reason: string,
  typeOnlyAllowed: string[] = [],
): ImportBoundary => ({
  name,
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
  typeOnlyAllowed: typeOnlyAllowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
  reason,
})

export const mcpBoundarySpecs: ImportBoundary[] = [
  boundary(
    'mcp-commands-boundary',
    'orchestrator/src/mcp/mcp-commands.ts',
    ['./mcp.ts', './mcp-compatibility-record.ts'],
    'Keep MCP command adapters independent of the run nucleus and the CLI: they compose concern modules for one verb and own no lifecycle.',
  ),
  boundary(
    'mcp-compatibility-record-boundary',
    'orchestrator/src/mcp/mcp-compatibility-record.ts',
    [
      'bun:sqlite',
      '../agent/agent-registry.ts',
      '../database/db.ts',
      '../project/projects.ts',
      './mcp-compatibility.ts',
      './mcp-probe.ts',
    ],
    'Keep stored MCP compatibility evidence behind its adapter and separate from the pure compatibility decision.',
  ),
  boundary(
    'mcp-preflight-boundary',
    'orchestrator/src/mcp/mcp-preflight.ts',
    [
      '../agent/agent-registry.ts',
      '../jobs/jobs.ts',
      '../project/projects.ts',
      '../run/run-process.ts',
    ],
    'Keep MCP preflight independent of execution, transport, routing, and mutation.',
    ['../contract/contract.ts', './mcp-compatibility.ts'],
  ),
  boundary(
    'run-mcp-attachment-record-boundary',
    'orchestrator/src/run/run-mcp-attachment-record.ts',
    ['../database/db.ts', '../events.ts', '../mcp/mcp-preflight.ts', './run-mcp-attachment.ts'],
    'Keep final worker MCP evidence with the attachment adapter and separate from grammar enforcement.',
  ),
  boundary(
    'run-mcp-grammar-boundary',
    'orchestrator/src/run/run-mcp-grammar.ts',
    [
      '../mcp/mcp-compatibility.ts',
      '../mcp/mcp-preflight.ts',
      '../mcp/mcp-probe.ts',
      './run-prelaunch-refusal.ts',
    ],
    'Keep the grammar backstop dependent on the pure compatibility ruling and the shared unstarted-run refusal.',
  ),
  boundary(
    'run-prelaunch-refusal-boundary',
    'orchestrator/src/run/run-prelaunch-refusal.ts',
    ['../database/db.ts', '../resources/resource-ownership.ts'],
    'Keep unstarted-run refusal as the single owner of its failure write and teardown.',
  ),
]
