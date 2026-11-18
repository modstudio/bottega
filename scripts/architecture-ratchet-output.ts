import type {
  ArchitectureViolationEdge,
  ArchitectureViolationRatchet,
} from './architecture-violation-baseline.ts'

function violationLines(
  violation: ArchitectureViolationEdge,
  comment: string | undefined,
): string[] {
  return [
    `error ${violation.rule}: ${violation.from} -> ${violation.to}`,
    ...(comment ? [comment] : []),
  ]
}

/** Decide the architecture ratchet failure text without running dependency-cruiser again. */
export function architectureRatchetFailureLines(input: {
  ratchet: ArchitectureViolationRatchet
  ruleComments: ReadonlyMap<string, string>
  full?: boolean
}): string[] {
  const detailViolations = input.full
    ? [...input.ratchet.newViolations, ...input.ratchet.baselined]
    : input.ratchet.newViolations

  return [
    ...input.ratchet.newViolations.map(
      (edge) =>
        `check-architecture: new violation outside the baseline; remove the import: ${edge.rule} ${edge.from} -> ${edge.to}`,
    ),
    ...input.ratchet.fixedBaseline.map(
      (edge) =>
        `check-architecture: baselined violation is fixed; remove it from the baseline: ${edge.rule} ${edge.from} -> ${edge.to}`,
    ),
    ...detailViolations.flatMap((violation) =>
      violationLines(violation, input.ruleComments.get(violation.rule)),
    ),
    input.full
      ? `check-architecture: ${input.ratchet.newViolations.length} new; ${input.ratchet.baselined.length} baselined, shown above`
      : `check-architecture: ${input.ratchet.newViolations.length} new; ${input.ratchet.baselined.length} baselined, not shown; full dump: bun scripts/check-architecture.ts --full`,
  ]
}
