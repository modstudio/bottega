export type ArchitectureViolationEdge = { rule: string; from: string; to: string }
type ArchitectureViolationBaseline = ArchitectureViolationEdge & { reason: string }

const architectureViolationBaseline: readonly ArchitectureViolationBaseline[] = [
  {
    rule: 'no-new-orchestrator-cycles',
    from: 'orchestrator/src/transport/transport-acp-usage.ts',
    to: 'orchestrator/src/transport/transport-acp.ts',
    reason:
      'The ACP transport calls its usage accumulator, which imports the transport-owned usage types.',
  },
]

function edgeKey(edge: ArchitectureViolationEdge) {
  return JSON.stringify([edge.rule, edge.from, edge.to])
}

export function architectureViolationRatchet(current: readonly ArchitectureViolationEdge[]) {
  const baseline = new Map(architectureViolationBaseline.map((edge) => [edgeKey(edge), edge]))
  const currentKeys = new Set(current.map(edgeKey))
  return {
    newViolations: current.filter((edge) => !baseline.has(edgeKey(edge))),
    fixedBaseline: architectureViolationBaseline.filter((edge) => !currentKeys.has(edgeKey(edge))),
  }
}
