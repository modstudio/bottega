import { expect, test } from 'bun:test'
import {
  credentialLinesFromRead,
  literalCredentialFindings,
  literalCredentialLines,
  MCP_CREDENTIAL_KEY_PATTERN,
} from './mcp-credential-literal.ts'
import type { McpServerConfig } from './mcp-probe.ts'

test('reports a literal authorization header without rendering its value', () => {
  expect(MCP_CREDENTIAL_KEY_PATTERN.test('X-API-Key')).toBeTrue()
  const servers: Record<string, McpServerConfig> = {
    tracker: { name: 'tracker', headers: { Authorization: 'Bearer literal-credential' } },
  }

  const findings = literalCredentialFindings(servers)
  expect(findings).toEqual([{ server: 'tracker', key: 'Authorization', where: 'header' }])
  const lines = literalCredentialLines('example', findings)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('project example MCP server tracker')
  expect(lines[0]).toContain('header Authorization')
  expect(lines[0]).not.toContain('literal-credential')
  expect(lines[0]).not.toContain('${')
})

test('accepts header and environment references and ignores non-secret keys', () => {
  const servers: Record<string, McpServerConfig> = {
    tracker: {
      name: 'tracker',
      headersHelper: './headers-helper',
      headers: { Authorization: `Bearer \${TOKEN}` },
      env: { GITHUB_KEY: `\${KEY:-x}`, LOG_LEVEL: 'debug' },
    },
  }

  expect(literalCredentialFindings(servers)).toEqual([])
})

test('reports a literal secret-named environment value', () => {
  const servers: Record<string, McpServerConfig> = {
    tracker: { name: 'tracker', env: { GITHUB_TOKEN: 'literal-token' } },
  }

  const findings = literalCredentialFindings(servers)
  expect(findings).toEqual([{ server: 'tracker', key: 'GITHUB_TOKEN', where: 'env' }])
  const lines = literalCredentialLines('example', findings)
  expect(lines[0]).toContain('secret run --name GITHUB_TOKEN')
  expect(lines[0]).not.toContain('headersHelper')
  expect(lines[0]).not.toContain('${')
})

test('reports unreadable config results while leaving a missing config silent', () => {
  expect(
    credentialLinesFromRead('example', {
      ok: false,
      path: '/projects/example/.mcp.json',
      reason: 'missing',
    }),
  ).toEqual([])

  expect(
    credentialLinesFromRead('example', {
      ok: false,
      path: '/projects/example/.mcp.json',
      reason: 'invalid',
      detail: 'secret parse detail',
    }),
  ).toEqual([
    'project example .mcp.json at /projects/example/.mcp.json could not be scanned for literal credentials (invalid); fix the file so the check can run',
  ])
})
