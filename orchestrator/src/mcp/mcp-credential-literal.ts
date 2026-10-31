// concern: mcp-credential-literal
/** Identifies credential values that a project MCP declaration stores literally. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { McpConfigReadResult, McpServerConfig } from './mcp-probe.ts'

export const MCP_CREDENTIAL_KEY_PATTERN = /AUTH|TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|COOKIE/i

const MCP_REFERENCE_PATTERN = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/g
const REFERENCE_PREFIX_PATTERN = /^(?:Bearer|Basic|Token)$/i

export type McpCredentialFinding = {
  server: string
  key: string
  where: 'header' | 'env'
}

function holdsLiteralCredential(key: string, value: string): boolean {
  if (!MCP_CREDENTIAL_KEY_PATTERN.test(key) || !value.trim()) return false
  let references = 0
  const remaining = value.replace(MCP_REFERENCE_PATTERN, () => {
    references += 1
    return ''
  })
  if (references === 0) return true
  const trimmed = remaining.trim()
  return trimmed !== '' && !REFERENCE_PREFIX_PATTERN.test(trimmed)
}

export function literalCredentialFindings(
  servers: Record<string, McpServerConfig>,
): McpCredentialFinding[] {
  const findings: McpCredentialFinding[] = []
  for (const [server, config] of Object.entries(servers)) {
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      if (holdsLiteralCredential(key, value)) findings.push({ server, key, where: 'header' })
    }
    for (const [key, value] of Object.entries(config.env ?? {})) {
      if (holdsLiteralCredential(key, value)) findings.push({ server, key, where: 'env' })
    }
  }
  return findings
}

export function literalCredentialLines(
  project: string,
  findings: McpCredentialFinding[],
): string[] {
  return findings.map(({ server, key, where }) => {
    const remedy =
      where === 'header'
        ? `store the value with ${PLATFORM_SLUG} machine config secret set, then serve it from a headersHelper`
        : `store the value with ${PLATFORM_SLUG} machine config secret set, then launch the server's command through ${PLATFORM_SLUG} machine config secret run --name ${key} -- <command>`
    return `project ${project} MCP server ${server} holds a literal credential in ${where} ${key}; ${remedy}`
  })
}

export function credentialLinesFromRead(project: string, read: McpConfigReadResult): string[] {
  if (read.ok) return literalCredentialLines(project, literalCredentialFindings(read.config))
  if (read.reason === 'missing') return []
  return [
    `project ${project} .mcp.json at ${read.path} could not be scanned for literal credentials (${read.reason}); fix the file so the check can run`,
  ]
}
