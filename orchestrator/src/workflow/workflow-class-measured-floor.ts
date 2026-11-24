// concern: workflows
/** Pure validation and persistence facts for a class-measured workflow floor. */

import type { ValidatedArtifactEvidence } from './workflow-artifact-evidence.ts'

export type ClassMeasurement = {
  className: string
  command: string
  execId: number
  count: number
}

export type ClassMeasuredDecision =
  | { met: true; measurement: ClassMeasurement }
  | { met: false; message: string }

const remedy =
  'run the class-wide command with `bottega workflow exec -- <command>`, print a non-negative integer as its last stdout line, then pass exactly one `--artifact exec:<id>` and `--class "<class name>"`'

export function decideClassMeasuredFloor(input: {
  className?: string
  artifacts: readonly ValidatedArtifactEvidence[]
}): ClassMeasuredDecision {
  const className = input.className?.trim()
  if (!className)
    return { met: false, message: `floor class-measured is unmet: --class is missing; ${remedy}` }
  if (input.artifacts.length !== 1 || !input.artifacts[0]?.exec)
    return {
      met: false,
      message: `floor class-measured is unmet: exactly one exec artifact is required; ${remedy}`,
    }
  const exec = input.artifacts[0].exec
  if (exec.exitCode !== 0)
    return {
      met: false,
      message: `floor class-measured is unmet: exec:${exec.id} exited ${exec.exitCode}; ${remedy}`,
    }
  if (!exec.createdAfterStepActivation)
    return {
      met: false,
      message: `floor class-measured is unmet: exec:${exec.id} predates this step; ${remedy}`,
    }
  const lastLine = exec.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  if (!lastLine || !/^\d+$/.test(lastLine))
    return {
      met: false,
      message: `floor class-measured is unmet: exec:${exec.id} stdout does not end in a non-negative integer; ${remedy}`,
    }
  return {
    met: true,
    measurement: { className, command: exec.command, execId: exec.id, count: Number(lastLine) },
  }
}
