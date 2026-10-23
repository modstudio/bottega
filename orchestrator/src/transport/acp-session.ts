// concern: ACP session establishment
/** Chooses load versus new after initialize. Process launch and protocol events stay with the transport. */
import type * as acp from '@agentclientprotocol/sdk'

export type AcpSessionConnection = {
  loadSession(input: acp.LoadSessionRequest): Promise<unknown>
  newSession(input: acp.NewSessionRequest): Promise<acp.NewSessionResponse>
}

export async function establishAcpSession(input: {
  connection: AcpSessionConnection
  cwd: string
  mcpServers: acp.McpServer[]
  sessionId?: string
  fallbackToNew: boolean
  loadFailureKilledProcess?: (error: unknown) => boolean
  onLoadFailure?: (reason: string) => void
}): Promise<{ sessionId: string; response: unknown; loaded: boolean }> {
  if (input.sessionId) {
    try {
      const response = await input.connection.loadSession({
        cwd: input.cwd,
        sessionId: input.sessionId,
        mcpServers: input.mcpServers,
      })
      return { sessionId: input.sessionId, response, loaded: true }
    } catch (error) {
      if (input.loadFailureKilledProcess?.(error)) throw error
      if (!input.fallbackToNew) throw error
      input.onLoadFailure?.(String((error as Error).message ?? error))
    }
  }
  const response = await input.connection.newSession({
    cwd: input.cwd,
    mcpServers: input.mcpServers,
  })
  return { sessionId: response.sessionId, response, loaded: false }
}
