export const FAILED_STEP_DETAIL_LINES = 20

// Which gate steps failed, the exit code, and the summary that names each failure.
export type GateStepResult = {
  name: string
  exitCode: number
  detail: readonly string[]
  omittedDetailLines: number
  note?: string
}

function failedStepSummary(step: GateStepResult): string[] {
  const heading = [
    step.name,
    ...(step.note ? [`  ${step.note}`] : []),
    ...(step.omittedDetailLines > 0
      ? [`  … ${step.omittedDetailLines} earlier lines omitted`]
      : []),
  ]
  if (step.detail.length <= FAILED_STEP_DETAIL_LINES) {
    return [...heading, ...step.detail.map((line) => `  ${line}`)]
  }
  const visibleDetailCount = FAILED_STEP_DETAIL_LINES - 1
  return [
    ...heading,
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
