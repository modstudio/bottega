// concern: run-prelaunch-refusal
/** Records and tears down one run that was refused before its agent started. */
import { db } from '../database/db.ts'
import { teardownTerminalRunResources } from '../resources/resource-ownership.ts'
import { recordRunStartupFailure } from './run-startup-failure.ts'

export async function refuseUnstartedRun(input: {
  runId: string
  started: number
  why: string
  mcpError?: string
  resetSandbox(): Promise<void>
}): Promise<never> {
  try {
    recordRunStartupFailure(input.runId, input.why, input.started, {
      failureKind: 'mcp_unverified',
      mcpError: input.mcpError,
    })
  } finally {
    try {
      await input.resetSandbox()
    } finally {
      teardownTerminalRunResources(db(), input.runId)
    }
  }
  throw Object.assign(new Error(`run ${input.runId} could not start: ${input.why}`), {
    runId: input.runId,
  })
}
