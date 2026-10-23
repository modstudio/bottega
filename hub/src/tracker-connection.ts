import type { ToolCaller } from '../../shared/trackers.ts'
import { credentials, failureDetail, Mcp } from './mcp.ts'
import type { RegisteredProject } from './projects.ts'

export type TrackerConnection = ToolCaller & { close(): Promise<void> }
export type TrackerConnectionDependencies = {
  readCredentials?: typeof credentials
  connect?: (url: string, token: string) => Promise<TrackerConnection>
}

/** Run one tracker operation through the canonical authenticated MCP connection lifecycle. */
export async function withTrackerConnection<T>(
  project: RegisteredProject,
  operation: (client: TrackerConnection) => Promise<T>,
  dependencies: TrackerConnectionDependencies = {},
): Promise<T> {
  const env = project.settings.tracker?.envPrefix ?? project.settings.envPrefix
  if (!env) throw new Error(`project ${project.name} tracker is missing envPrefix`)
  const auth = await (dependencies.readCredentials ?? credentials)(env)
  if (!auth) throw new Error(`credentials for ${project.name} tracker do not resolve`)
  let client: TrackerConnection | null = null
  let result!: T
  let operationFailure: unknown
  try {
    client = dependencies.connect
      ? await dependencies.connect(auth.url, auth.token)
      : new Mcp(auth.url, auth.token)
    if (!dependencies.connect) await (client as Mcp).initialize()
    result = await operation(client)
  } catch (error) {
    operationFailure = error
  }
  let closeFailure: unknown
  if (client) {
    try {
      await client.close()
    } catch (error) {
      closeFailure = error
    }
  }
  const failure = operationFailure ?? closeFailure
  if (failure !== undefined) throw new Error(failureDetail(failure, auth.token))
  return result
}
