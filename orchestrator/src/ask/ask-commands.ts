// concern: run-inbox
/** Owns the bottega-ask-only alias over setup MCP registration. */

import { existsSync } from 'node:fs'
import { which } from 'bun'
import { PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { applyMcpRegistration } from '../setup/setup-apply.ts'
import {
  captureHarnessMcpFacts,
  HARNESS_MCP_CATALOGUE,
  type HarnessName,
  harnessMcpServers,
  runSetupCommand,
  type SetupCommandRunner,
  stableMcpServers,
} from '../setup/setup-mcp.ts'
import { assertMcpRegistrationWriteAllowed } from '../setup/setup-registration-write.ts'

export async function setupAskCommand(
  presentation: { log(value: string): void },
  dependencies: {
    runner?: SetupCommandRunner
    find?: (name: string) => string | null
    commandExists?: (path: string) => boolean
    assertWriteAllowed?: () => void
  } = {},
): Promise<number> {
  try {
    ;(dependencies.assertWriteAllowed ?? assertMcpRegistrationWriteAllowed)()
  } catch (error) {
    presentation.log(`FAIL ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const runner = dependencies.runner ?? runSetupCommand
  const find = dependencies.find ?? ((name: string) => which(name, { PATH: process.env.PATH }))
  const server = stableMcpServers().find((candidate) => candidate.name === WORKER_MCP_SERVER_NAME)!
  let failed = false
  const targets = (Object.keys(HARNESS_MCP_CATALOGUE) as HarnessName[]).filter(
    (harness) =>
      HARNESS_MCP_CATALOGUE[harness].support === 'automatic' &&
      harnessMcpServers(harness).includes(WORKER_MCP_SERVER_NAME),
  )
  for (const harness of targets) {
    const bin = find(harness) ?? harness
    try {
      const current = captureHarnessMcpFacts(
        harness,
        bin,
        [server],
        runner,
        dependencies.commandExists ?? existsSync,
        find,
      ).registrations[WORKER_MCP_SERVER_NAME]
      if (current?.status === 'different') {
        throw new Error(
          `${WORKER_MCP_SERVER_NAME} has a different working registration; run ${PLATFORM_SLUG} machine setup apply to review and replace it`,
        )
      }
      const status = applyMcpRegistration(
        {
          kind: 'register-mcp',
          harness,
          bin,
          server,
          replace: current?.status === 'stale',
        },
        runner,
      )
      presentation.log(
        status === 'unchanged'
          ? `ok   ${harness}: ${WORKER_MCP_SERVER_NAME} already registered`
          : `ok   ${harness}: ${WORKER_MCP_SERVER_NAME} registered and verified`,
      )
    } catch (error) {
      failed = true
      presentation.log(`FAIL ${harness}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  presentation.log(
    '\nA worker can now call ask_orchestrator, message_orchestrator, and check_orchestrator_messages mid-task.\nAgents without it fall back to returning status "asking", which still works.',
  )
  return failed ? 1 : 0
}
