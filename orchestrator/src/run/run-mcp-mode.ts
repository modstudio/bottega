/** Select the Codex MCP catalogue scope for one worker launch. */
export function codexMcpMode(usingMcp: boolean, writesJob: boolean): false | 'reader' | 'writer' {
  if (!usingMcp) return false
  return writesJob ? 'writer' : 'reader'
}
