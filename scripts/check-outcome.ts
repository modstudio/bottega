import { formatGateFailureDetail, formatGateFailureLeg } from '../shared/check-execution.ts'

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
    formatGateFailureLeg(step.name),
    ...(step.note ? [formatGateFailureDetail(step.note)] : []),
    ...(step.omittedDetailLines > 0
      ? [formatGateFailureDetail(`… ${step.omittedDetailLines} earlier lines omitted`)]
      : []),
  ]
  if (step.detail.length <= FAILED_STEP_DETAIL_LINES) {
    return [...heading, ...step.detail.map(formatGateFailureDetail)]
  }
  const visibleDetailCount = FAILED_STEP_DETAIL_LINES - 1
  return [
    ...heading,
    ...step.detail.slice(0, visibleDetailCount).map(formatGateFailureDetail),
    formatGateFailureDetail(`… ${step.detail.length - visibleDetailCount} more`),
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
