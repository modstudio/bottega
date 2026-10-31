// concern: focused-test-tool
/** Registers the writer-only run_tests MCP surface. */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { runScratchDir } from '../run/run-artifacts.ts'
import { requestFocusedTests } from './focused-test-request.ts'
import { focusedTestEligibility } from './focused-test-service.ts'

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

export function registerFocusedTestTool(input: {
  registerTool: McpServer['registerTool']
  runId: string
  token: string
  text(value: string, isError?: true): TextResult
}): void {
  input.registerTool(
    'run_tests',
    {
      description:
        "Run this project's registered focused test runners with project-relative paths. " +
        'Each path goes only to the runner whose registered patterns accept it. ' +
        'Set affected to also run the tests of every module that imports what this run changed, ' +
        "which the project's registered focusedTests affected commands select.",
      inputSchema: z.object({
        paths: z.array(z.string()).optional(),
        affected: z.boolean().optional(),
      }),
    },
    async ({ paths, affected }, context) => {
      try {
        const requestedAffected = affected === true
        const decision = focusedTestEligibility(input.runId, input.token, requestedAffected)
        if (!decision.eligible) return input.text(decision.message)
        return input.text(
          await requestFocusedTests({
            runId: input.runId,
            scratchDir: runScratchDir(input.runId),
            paths: paths ?? [],
            affected: requestedAffected,
            signal: context.mcpReq.signal,
          }),
        )
      } catch (error) {
        return input.text(`The registered focused tests could not be run (${String(error)}).`, true)
      }
    },
  )
}
