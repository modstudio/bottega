// concern: workflows
/** Normalizes workflow artifact offers before floor evidence is gathered. */

import type { Database } from 'bun:sqlite'
import { parseProbeArtifact, resolveProbeArtifact } from './probe-identifier.ts'

export function resolveOfferedArtifacts(
  d: Database,
  artifacts: string | string[] | undefined,
): string[] {
  const offered = artifacts === undefined ? [] : Array.isArray(artifacts) ? artifacts : [artifacts]
  return offered.map((artifact) => resolveProbeArtifact(d, artifact)!)
}

export function resolvedOfferedArtifact(d: Database, artifact: string): string {
  const offered = artifact.trim()
  try {
    const parsed = parseProbeArtifact(offered)
    return parsed?.identifier.kind === 'number' ? resolveProbeArtifact(d, offered)! : offered
  } catch {
    return offered
  }
}
