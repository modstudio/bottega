// concern: workflows
/** Pure validation and persistence facts for a class-measured workflow floor. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { shellQuote } from '../../../shared/shell-quote.ts'
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

const remedy = `run the class-wide command with \`${PLATFORM_SLUG} workflow exec -- <command>\`, print a non-negative integer as its last stdout line, then pass exactly one \`--artifact exec:<id>\` and \`--class "<class name>"\``

export function measuredCountFromOutput(output: string): number | null {
  const lastLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  return lastLine && /^\d+$/.test(lastLine) ? Number(lastLine) : null
}

export function renderClassMeasurementCommand(argv: readonly string[] | null): string | null {
  return argv?.length ? argv.map(shellQuote).join(' ') : null
}

export function decideClassMeasuredFloor(input: {
  className?: string
  artifacts: readonly ValidatedArtifactEvidence[]
}): ClassMeasuredDecision {
  const className = input.className?.trim()
  if (!className)
    return { met: false, message: `floor class-measured is unmet: --class is missing; ${remedy}` }
  if (containsSecretShaped(className))
    return {
      met: false,
      message: `floor class-measured is unmet: --class contains secret-shaped content; ${remedy}`,
    }
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
  const command = exec.commandWithheld ? null : renderClassMeasurementCommand(exec.argv)
  if (!command)
    return {
      met: false,
      message: `floor class-measured is unmet: exec:${exec.id} has no structured command; rerun the measurement through \`${PLATFORM_SLUG} workflow exec -- <command>\``,
    }
  const count = measuredCountFromOutput(exec.output)
  if (count === null)
    return {
      met: false,
      message: `floor class-measured is unmet: exec:${exec.id} stdout does not end in a non-negative integer; ${remedy}`,
    }
  return {
    met: true,
    measurement: { className, command, execId: exec.id, count },
  }
}
