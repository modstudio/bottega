// Which gate steps failed, in the order they ran, and the exit code that reports them.
export type GateStepResult = { name: string; exitCode: number }

export function decideGateOutcome(steps: readonly GateStepResult[]): {
  failures: string[]
  exitCode: 0 | 1
} {
  const failures = steps.filter((step) => step.exitCode !== 0).map((step) => step.name)
  return { failures, exitCode: failures.length === 0 ? 0 : 1 }
}
