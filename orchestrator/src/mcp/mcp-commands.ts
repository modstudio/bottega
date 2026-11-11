// concern: mcp-commands
/** Owns MCP server entry and configuration presentation. Must not know CLI grammar. */
import { serveMcpSupervisor } from './mcp-supervisor.ts'

export async function mcpCommand(
  config: boolean,
  verb: string | undefined,
  project: string | undefined,
  binary: string,
  presentation: { log(value: string): void },
): Promise<void> {
  if (verb === 'compat') {
    const { mcpCompatibilityRows } = await import('./mcp-compatibility-record.ts')
    const rows = mcpCompatibilityRows(project)
    if (project && !rows.length) throw new Error(`unknown project "${project}"`)
    presentation.log(
      [
        'harness agent project server listed admitted verdict pattern transport auth last_observation',
        ...rows.map((row) => {
          const observation = row.lastObservation
            ? `run=${row.lastObservation.runId},time=${row.lastObservation.time},mcp_connected=${row.lastObservation.connected ?? 'unknown'}`
            : 'none'
          return [
            row.harness,
            row.agent,
            row.project,
            row.server,
            row.listed ?? 'unknown',
            row.admitted ?? 'unknown',
            row.verdict,
            row.pattern ?? 'any',
            row.transport,
            row.auth,
            observation,
          ].join(' ')
        }),
      ].join('\n'),
    )
  } else if (verb) {
    throw new Error(`unknown mcp verb "${verb}"`)
  } else if (config) {
    const [{ MCP_SERVER_NAME }, { bottegaMcpServerEntry }] = await Promise.all([
      import('../../../shared/brand.ts'),
      import('./mcp-probe.ts'),
    ])
    presentation.log(
      JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: bottegaMcpServerEntry(binary) } }, null, 2),
    )
  } else await serveMcpSupervisor()
}
