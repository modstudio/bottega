// concern: run terminal fallback
/** Guarantees a finish-path exception leaves a terminal run and publication row behind. */
import { isTerminalRecorded, markRunFinishFailed } from './run-finish-error.ts'
import { recordRunFinishFailure } from './run-finish-failure.ts'
import { finishRun, type TerminalInput, type TerminalResult } from './run-terminal.ts'

export async function finishRunWithFallback(
  build: () => TerminalInput,
  fallback: { runId: string; started: number; machineId: string },
): Promise<TerminalResult> {
  try {
    return await finishRun(build())
  } catch (error) {
    if (!isTerminalRecorded(error)) {
      recordRunFinishFailure({
        runId: fallback.runId,
        error,
        started: fallback.started,
        machineId: fallback.machineId,
        terminalRecorded: false,
      })
    }
    throw markRunFinishFailed(error, fallback.runId)
  }
}
