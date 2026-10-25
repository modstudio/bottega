// concern: run-prelaunch-refusal
/** Records and tears down one run that was refused before its agent started. */
import { db } from '../database/db.ts'
import { teardownTerminalRunResources } from '../resources/resource-ownership.ts'
import { RequiredMcpProbeRefusalError } from '../sandbox/project-mcp-preflight.ts'
import { recordRunStartupFailure } from './run-startup-failure.ts'

/** The failure kind a refused-before-launch run is recorded with. */
const REFUSAL_FAILURE_KIND = 'mcp_unverified'

/**
 * The failure record an error carries when a run was refused before its agent
 * started. Only the refusal this concern owns is trusted: a refusal recorded as
 * 'harness' reads to routing and failover as the agent failing, and here the
 * agent never ran.
 */
export function carriedRefusalFailure(
  error: unknown,
): { failureKind: string; mcpError?: string } | undefined {
  return error instanceof RequiredMcpProbeRefusalError
    ? { failureKind: REFUSAL_FAILURE_KIND, mcpError: error.message }
    : undefined
}

export async function refuseUnstartedRun(input: {
  runId: string
  started: number
  why: string
  mcpError?: string
  resetSandbox(): Promise<void>
}): Promise<never> {
  try {
    recordRunStartupFailure(input.runId, input.why, input.started, {
      failureKind: REFUSAL_FAILURE_KIND,
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
