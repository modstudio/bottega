import type { IViolation } from 'dependency-cruiser'
import type { ArchitectureViolationEdge } from './architecture-violation-baseline.ts'

export type ArchitectureViolationRatchet = {
  newViolations: readonly ArchitectureViolationEdge[]
  fixedBaseline: readonly ArchitectureViolationEdge[]
}

function edgeKey(edge: ArchitectureViolationEdge): string {
  return JSON.stringify([edge.rule, edge.from, edge.to])
}

function violationLines(violation: IViolation, comment: string | undefined): string[] {
  return [
    `error ${violation.rule.name}: ${violation.from} -> ${violation.to}`,
    ...(comment ? [comment] : []),
  ]
}

/** Decide the architecture ratchet failure text without running dependency-cruiser again. */
export function architectureRatchetFailureLines(input: {
  violations: readonly IViolation[]
  ratchet: ArchitectureViolationRatchet
  ruleComments: ReadonlyMap<string, string>
  full?: boolean
}): string[] {
  const newKeys = new Set(input.ratchet.newViolations.map(edgeKey))
  const detailViolations = input.full
    ? input.violations
    : input.violations.filter((violation) =>
        newKeys.has(edgeKey({ rule: violation.rule.name, from: violation.from, to: violation.to })),
      )
  const baselinedCount = input.violations.filter(
    (violation) =>
      !newKeys.has(edgeKey({ rule: violation.rule.name, from: violation.from, to: violation.to })),
  ).length

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
      violationLines(violation, input.ruleComments.get(violation.rule.name)),
    ),
    `check-architecture: ${input.ratchet.newViolations.length} new; ${baselinedCount} baselined, not shown; full dump: bun scripts/check-architecture.ts --full`,
  ]
}
