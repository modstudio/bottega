// concern: focused-test-tool
/** Registers the writer-only run_tests MCP surface. */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { authenticatedWorkerRun } from '../ask/worker-auth.ts'
import { db } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { runScratchDir } from '../run/run-artifacts.ts'
import { decideFocusedTestEligibility, parseFocusedTestRunner } from './focused-test-decision.ts'
import { requestFocusedTests } from './focused-test-request.ts'

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

function eligibility(runId: number, token: string) {
  const row = db()
    .query(
      `SELECT r.job,p.settings FROM run r
       LEFT JOIN project p ON p.id=r.project_id WHERE r.id=?`,
    )
    .get(runId) as { job: string; settings: string | null } | null
  let runner = null
  try {
    const settings = JSON.parse(row?.settings ?? '{}') as { focusedTests?: unknown }
    runner = parseFocusedTestRunner(settings.focusedTests)
  } catch {
    runner = null
  }
  return decideFocusedTestEligibility({
    authenticated: authenticatedWorkerRun(runId, token),
    writer: Boolean(row && JOBS[row.job]?.needs.writesRepo),
    runner,
  })
}

export function registerFocusedTestTool(input: {
  registerTool: McpServer['registerTool']
  runId: number
  token: string
  text(value: string, isError?: true): TextResult
}): void {
  input.registerTool(
    'run_tests',
    {
      description:
        "Run this project's registered focused test runner with project-relative paths. " +
        'The executable and argv prefix are fixed by orch; paths are appended as distinct argv values.',
      inputSchema: z.object({ paths: z.array(z.string()) }),
    },
    async ({ paths }, context) => {
      try {
        const decision = eligibility(input.runId, input.token)
        if (!decision.eligible) return input.text(decision.message)
        return input.text(
          await requestFocusedTests({
            runId: input.runId,
            scratchDir: runScratchDir(input.runId),
            paths,
            signal: context.mcpReq.signal,
          }),
        )
      } catch (error) {
        return input.text(`The registered focused tests could not be run (${String(error)}).`, true)
      }
    },
  )
}
