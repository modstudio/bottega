// concern: mcp
/** Applies context moments and appends their reports to MCP tool results. */
import { applyContextMoment, type ContextMomentPorts } from '../doc/context-moment-adapter.ts'
import type { WorkflowContextMoment } from '../workflow/workflow-context-moment.ts'

export async function collectContextMomentReports(
  moment: WorkflowContextMoment,
  ports?: ContextMomentPorts,
): Promise<string[]> {
  const lines: string[] = []
  await applyContextMoment(
    moment,
    false,
    { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    ports,
  )
  return lines
}

export const resultWithContextReports = (result: unknown, reports: string[]) => ({
  content: [
    { type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result) },
    ...reports.map((line) => ({ type: 'text' as const, text: line })),
  ],
})
