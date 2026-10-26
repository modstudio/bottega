import { expect, test } from 'bun:test'
import { MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { PROJECT_RELATIVE_NO_TREE_REASON } from './mcp-reader-scope.ts'
import {
  type RequiredMcpProbeFacts,
  RequiredMcpProbeRefusalError,
  requiredMcpProbeDecision,
} from './project-mcp-preflight.ts'
import { PROJECT_MCP_WRITER_WITHHELD_REASON } from './project-mcp-scope.ts'

const requiredMcpProbeRefusal = (facts: RequiredMcpProbeFacts) =>
  requiredMcpProbeDecision(facts).refusal

const project = { name: 'starship', path: '/opt/starship' }
const failure = { server: 'starship', error: 'Connection closed\nstderr: not configured' }

test('a require run refuses a failed probe and never a passed one', () => {
  expect(requiredMcpProbeRefusal({ mode: 'require', project, failures: [failure] })).not.toBeNull()
  expect(requiredMcpProbeRefusal({ mode: 'require', project, failures: [] })).toBeNull()
})

test('a preferring or default run records the same failure without refusing', () => {
  expect(requiredMcpProbeRefusal({ mode: 'prefer', project, failures: [failure] })).toBeNull()
  expect(requiredMcpProbeRefusal({ mode: null, project, failures: [failure] })).toBeNull()
})

test('the refusal names the server, its error and the edit that clears it', () => {
  const refusal = requiredMcpProbeRefusal({ mode: 'require', project, failures: [failure] })!
  expect(refusal).toContain('starship: Connection closed')
  expect(refusal).toContain('/opt/starship/.mcp.json')
  expect(refusal).toContain('project set starship --settings')
  expect(refusal).toContain('mcpServer')
})

test('a required server the selection did not hand over is refused, and named', () => {
  const facts: RequiredMcpProbeFacts = {
    mode: 'require',
    project,
    failures: [],
    requiredServer: 'starship',
    selectedServers: [],
    withheld: [],
  }

  // A probe list derived from the selection cannot see a server the selection
  // never had: the project's primary was absent from .mcp.json and the run
  // would review without its required server.
  const refusal = requiredMcpProbeRefusal(facts)!
  expect(refusal).toContain('starship: not configured in the tree')
  expect(refusal).toContain('/opt/starship/.mcp.json')
})

test('a started required server does not refuse another server failure and reports it', () => {
  const unrelated = { server: 'stripe', error: 'missing credentials' }
  const decision = requiredMcpProbeDecision({
    mode: 'require',
    project,
    failures: [unrelated],
    requiredServer: 'starship',
    selectedServers: ['starship', 'stripe'],
  })

  expect(decision).toEqual({ refusal: null, unrelatedFailures: [unrelated] })
})

test('a failed required server refuses only its failure and reports another failure', () => {
  const unrelated = { server: 'youtrack', error: 'Connection closed' }
  const decision = requiredMcpProbeDecision({
    mode: 'require',
    project,
    failures: [failure, unrelated],
    requiredServer: 'starship',
    selectedServers: ['starship', 'youtrack'],
  })

  expect(decision.refusal).toContain('starship: Connection closed')
  expect(decision.refusal).not.toContain('youtrack')
  expect(decision.unrelatedFailures).toEqual([unrelated])
})

test('an unscoped required server keeps refusing any affirmative failure', () => {
  const decision = requiredMcpProbeDecision({
    mode: 'require',
    project,
    failures: [{ server: 'stripe', error: 'missing credentials' }],
    requiredServer: null,
  })

  expect(decision.refusal).toContain('stripe: missing credentials')
  expect(decision.unrelatedFailures).toEqual([])
})

test('a withheld required server says why the run did not get it', () => {
  const refusal = requiredMcpProbeRefusal({
    mode: 'require',
    project,
    failures: [],
    requiredServer: 'starship',
    selectedServers: [],
    withheld: [{ name: 'starship', reason: PROJECT_MCP_WRITER_WITHHELD_REASON }],
  })!

  expect(refusal).toContain(
    "starship: withheld from this run's MCP scope (inline env/headers, a headersHelper, or no launch definition); writing workers cannot receive these; run as a reader through the proxy, or declare the server without them",
  )
})

test('a withheld required server names a project-relative no-tree reason', () => {
  const refusal = requiredMcpProbeRefusal({
    mode: 'require',
    project,
    failures: [],
    requiredServer: 'starship',
    selectedServers: [],
    withheld: [{ name: 'starship', reason: PROJECT_RELATIVE_NO_TREE_REASON }],
  })!

  expect(refusal).toContain(
    `starship: withheld from this run's MCP scope (${PROJECT_RELATIVE_NO_TREE_REASON})`,
  )
  expect(refusal).not.toContain('headersHelper')
})

test('a handed-over required server, and the platform server, are never refused', () => {
  expect(
    requiredMcpProbeRefusal({
      mode: 'require',
      project,
      failures: [],
      requiredServer: 'starship',
      selectedServers: ['starship'],
    }),
  ).toBeNull()
  // The platform installs its own server, so it is not the tree's to configure.
  expect(
    requiredMcpProbeRefusal({
      mode: 'require',
      project,
      failures: [],
      requiredServer: MCP_SERVER_NAME,
      selectedServers: [],
    }),
  ).toBeNull()
  expect(
    requiredMcpProbeRefusal({
      mode: 'prefer',
      project,
      failures: [],
      requiredServer: 'starship',
      selectedServers: [],
    }),
  ).toBeNull()
})

test('the refusal error carries only the reason, never the run failure kind', () => {
  const refusal = new RequiredMcpProbeRefusalError(
    requiredMcpProbeRefusal({ mode: 'require', project, failures: [failure] })!,
  )

  // The run concern owns the failure-kind vocabulary, so a refusal cannot be
  // recorded with a kind this module chose.
  expect(refusal.message).toContain('starship: Connection closed')
  expect((refusal as unknown as { failureKind?: string }).failureKind).toBeUndefined()
})
