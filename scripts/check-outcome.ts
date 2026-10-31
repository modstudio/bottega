import type { Finding } from '../shared/ratchet.ts'

export const FAILED_STEP_SUMMARY_LINES = 20

// Which gate steps failed, in the order they ran, and the exit code that reports them.
export type GateStepResult = { name: string; exitCode: number; detail: readonly string[] }

export function biomeFindingDetails(findings: readonly Finding[]): string[] {
  return findings.map(
    (finding) => `${finding.file}:${finding.line} ${finding.rule} ${finding.message}`,
  )
}

function failedStepSummary(step: GateStepResult): string[] {
  if (step.detail.length <= FAILED_STEP_SUMMARY_LINES) {
    return [step.name, ...step.detail.map((line) => `  ${line}`)]
  }
  const visibleDetailCount = FAILED_STEP_SUMMARY_LINES - 1
  return [
    step.name,
    ...step.detail.slice(0, visibleDetailCount).map((line) => `  ${line}`),
    `  … ${step.detail.length - visibleDetailCount} more`,
  ]
}

export function decideGateOutcome(steps: readonly GateStepResult[]): {
  failures: string[]
  summary: string[]
  exitCode: 0 | 1
} {
  const failedSteps = steps.filter((step) => step.exitCode !== 0)
  const failures = failedSteps.map((step) => step.name)
  return {
    failures,
    summary: failedSteps.flatMap(failedStepSummary),
    exitCode: failures.length === 0 ? 0 : 1,
  }
}
