// concern: codex MCP tool instruction
/**
 * Knows how Codex code mode names MCP tools and adds that fact to a Codex
 * worker contract. Must not know routing, launch arguments, or tool discovery.
 */
import { WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'

/** Normalize one MCP tool name to the JavaScript identifier Codex code mode exposes. */
export function codexMcpToolIdentifier(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_$]/g, '_')
}

const RUN_TESTS_PARAGRAPH_START = 'When the `run_tests` tool is available'

/** Add the code-mode call shape beside the existing test-tool paragraph for Codex only. */
export function bindCodexMcpToolInstruction(prompt: string, agent: string): string {
  if (agent !== 'codex' || !prompt.includes(RUN_TESTS_PARAGRAPH_START)) return prompt
  const identifier = codexMcpToolIdentifier(WORKER_MCP_SERVER_NAME, 'run_tests')
  const sentence =
    `In Codex, the ${WORKER_MCP_SERVER_NAME} tools may not appear as top-level tools. ` +
    `When \`functions.exec\` is available, call them inside it as \`tools.${identifier}(…)\`, ` +
    `for example \`tools.${identifier}({...})\`.\n\n`
  return prompt.replace(RUN_TESTS_PARAGRAPH_START, `${sentence}${RUN_TESTS_PARAGRAPH_START}`)
}
