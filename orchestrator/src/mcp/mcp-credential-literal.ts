// concern: mcp-credential-literal
/** Identifies credential values that a project MCP declaration stores literally. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { McpServerConfig } from './mcp-probe.ts'

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
  const remedy =
    `store the value with ${PLATFORM_SLUG} machine config secret set, then serve it from a ` +
    `headersHelper (or a \${VAR} reference for an env key)`
  return findings.map(
    ({ server, key, where }) =>
      `project ${project} MCP server ${server} holds a literal credential in ${where} ${key}; ${remedy}`,
  )
}
