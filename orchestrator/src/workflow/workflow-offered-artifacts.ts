// concern: workflows
/** Normalizes workflow artifact offers before floor evidence is gathered. */

import type { Database } from 'bun:sqlite'
import { parseProbeArtifact, resolveProbeArtifact } from './probe-identifier.ts'

export type WorkflowEvidenceInput = {
  ruling?: number
  review?: string
  gate?: string | number
  run?: string
  artifacts?: string[]
  task?: string
  defer?: string
  satisfies?: string
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
