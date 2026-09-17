// concern: run-inbox
/** Owns ask-server setup behavior. Must not know CLI grammar. */
import { AGENTS } from '../agent-registry.ts'

export function setupAskCommand(
  command: string[],
  presentation: { log(value: string): void },
): void {
  const registrars: Record<string, string[]> = {
    codex: ['mcp', 'add', 'orch-ask', '--', ...command],
    grok: ['mcp', 'add', 'orch-ask', '--', ...command],
  }
  const manual = Object.values(AGENTS)
    .filter((agent) => agent.caps.mcp && !(agent.bin in registrars))
    .map((agent) => agent.name)
  for (const [bin, args] of Object.entries(registrars)) {
    const result = Bun.spawnSync([bin, ...args], { stdout: 'pipe', stderr: 'pipe' })
    const detail = (result.stdout.toString() + result.stderr.toString()).trim().split('\n')[0] ?? ''
    presentation.log(
      `${result.exitCode === 0 ? 'ok  ' : 'FAIL'} ${bin}: ${detail || `exit ${result.exitCode}`}`,
    )
  }
  if (manual.length)
    presentation.log(
      `\nnot registered automatically: ${manual.join(', ')} — add orch-ask to their own\nMCP settings by hand, or they fall back to the asking protocol.`,
    )
  presentation.log(
    '\nA worker can now call ask_orchestrator, message_orchestrator, and check_orchestrator_messages mid-task.\nAgents without it fall back to returning status "asking", which still works.',
  )
}
