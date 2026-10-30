// concern: run terminal fallback
/** Guarantees a finish-path exception leaves a terminal run and publication row behind. */
import { recordRunFinishFailure } from './run-startup-failure.ts'
import { finishRun, type TerminalInput, type TerminalResult } from './run-terminal.ts'

export async function finishRunWithFallback(input: TerminalInput): Promise<TerminalResult> {
  try {
    return await finishRun(input)
  } catch (error) {
    recordRunFinishFailure({
      runId: input.claim.id,
      error,
      started: input.started,
      machineId: input.machineId,
    })
    throw Object.assign(new Error(String((error as Error)?.message ?? error), { cause: error }), {
      runId: input.claim.id,
      runFinishFailed: true,
    })
  }
}
