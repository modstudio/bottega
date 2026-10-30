// concern: run terminal fallback
/** Guarantees a finish-path exception leaves a terminal run and publication row behind. */
import { recordRunFinishFailure } from './run-startup-failure.ts'
import { finishRun, type TerminalInput, type TerminalResult } from './run-terminal.ts'

export async function finishRunWithFallback(
  build: () => TerminalInput,
  fallback: { runId: string; started: number; machineId: string },
): Promise<TerminalResult> {
  try {
    return await finishRun(build())
  } catch (error) {
    recordRunFinishFailure({
      runId: fallback.runId,
      error,
      started: fallback.started,
      machineId: fallback.machineId,
    })
    throw Object.assign(new Error(String((error as Error)?.message ?? error), { cause: error }), {
      runId: fallback.runId,
      runFinishFailed: true,
    })
  }
}
