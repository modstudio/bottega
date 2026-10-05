// concern: project-write-decision
/** Decides project-register write authority from plain install facts. */

export type ProjectWriteDecision = 'hosted' | 'local-authoritative' | 'refused'

export function decideProjectWrite(input: {
  recordApiUrlSet: boolean
  installBound: boolean
}): ProjectWriteDecision {
  if (input.recordApiUrlSet) return 'hosted'
  return input.installBound ? 'refused' : 'local-authoritative'
}
