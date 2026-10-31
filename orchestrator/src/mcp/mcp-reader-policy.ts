// concern: mcp-reader-policy
/** Decides which project MCP tools a reading job may call. */

export type ReaderToolDecision = {
  name: string
  readOnlyHint: boolean | undefined
  server: string
  projectServer: string
  registeredTools: readonly string[]
}

export type ProjectToolPolicy = 'reader' | 'writer'

/** Accept a registered name on any server, or an exact read-only hint from the project server. */
export function readerMayCallTool(input: ReaderToolDecision): boolean {
  return (
    input.registeredTools.includes(input.name) ||
    (input.server === input.projectServer && input.readOnlyHint === true)
  )
}

/** Accept only a tool whose exact name the project register grants to writers. */
export function writerMayCallTool(input: ReaderToolDecision): boolean {
  return input.registeredTools.includes(input.name)
}
