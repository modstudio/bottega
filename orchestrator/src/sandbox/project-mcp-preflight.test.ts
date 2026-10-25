import { expect, test } from 'bun:test'
import { requiredMcpProbeRefusal } from './project-mcp-preflight.ts'

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
