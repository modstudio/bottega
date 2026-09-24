// concern: run-prelaunch-refusal
/** Records and tears down one run that was refused before its agent started. */
import { db } from '../database/db.ts'
import { teardownTerminalRunResources } from '../resources/resource-ownership.ts'

export async function refuseUnstartedRun(input: {
  runId: number
  started: number
  why: string
  mcpError?: string
  resetSandbox(): Promise<void>
}): Promise<never> {
  db()
    .query(
      `UPDATE run SET status='failed', error=?, mcp_error=COALESCE(?,mcp_error),
       failure_kind='mcp_unverified', latency_ms=? WHERE id=?`,
    )
    .run(input.why, input.mcpError ?? null, Date.now() - input.started, input.runId)
  await input.resetSandbox()
  teardownTerminalRunResources(db(), input.runId)
  throw Object.assign(new Error(`run ${input.runId} could not start: ${input.why}`), {
    runId: input.runId,
  })
}
