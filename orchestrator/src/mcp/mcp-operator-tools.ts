// concern: operator-waiting
/** Registers MCP adapters for operator-ruling mutations. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  AnswerWaitingResultSchema,
  type ListOpenQuestionsResult,
  ListOpenQuestionsResultSchema,
  OverturnRulingResultSchema,
} from '../../../shared/orch-contract.ts'
import { operatorWaiting, relayQuestion } from '../operator/operator-waiting.ts'
import { overturnRuling } from '../run/ruling-overturn.ts'
import { answerRun } from '../run/run-answer.ts'
import { runInboxCommand } from '../run/run-inbox.ts'
import { answerRunHelpers } from '../run/run-message-commands.ts'

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
})

const structured = <T extends Record<string, unknown>>(value: T) => ({
  ...text(value),
  structuredContent: value,
})

async function listOpenQuestions(): Promise<ListOpenQuestionsResult> {
  let encoded: string | undefined
  await runInboxCommand(
    { has: (name) => name === 'json' },
    {
      log: (value) => {
        encoded = String(value)
      },
      dur: () => '',
      chainHasPendingDelivery: () => false,
      strandedRecovery: () => '',
    },
  )
  if (encoded === undefined) throw new Error('orch inbox returned no JSON result')
  return ListOpenQuestionsResultSchema.parse({
    questions: JSON.parse(encoded),
    waiting_on_operator: operatorWaiting(),
  })
}

const presentation = {
  printRunId: (_id: number) => {},
}

export function registerOperatorTools(server: McpServer): void {
  server.registerTool(
    'list_open_questions',
    {
      description:
        'List open questions this session owns or may answer, plus items waiting on the operator.',
      outputSchema: ListOpenQuestionsResultSchema,
      annotations: { readOnlyHint: true },
    },
    async () => structured(await listOpenQuestions()),
  )

  server.registerTool(
    'answer_questions',
    {
      description: 'Answer every open question on a run and resume it detached by default.',
      inputSchema: {
        run_id: z.number().int().positive(),
        rulings: z
          .array(
            z
              .object({
                question_id: z.number().int().positive(),
                ruling: z.string().trim().min(1),
              })
              .strict(),
          )
          .min(1),
        from_operator: z.boolean().optional(),
        record_only: z.boolean().optional(),
      },
      outputSchema: AnswerWaitingResultSchema,
    },
    async ({ run_id, rulings, from_operator, record_only }) => {
      const argv = rulings.flatMap(({ question_id, ruling }) => [`--q${question_id}`, ruling])
      if (from_operator) argv.push('--from-operator')
      argv.push('--channel', 'mcp')
      const result = await answerRun(
        run_id,
        {
          argv,
          recordOnly: record_only ?? false,
          json: true,
          flags: { detach: true, follow: false, quiet: true },
        },
        answerRunHelpers(presentation),
      )
      return structured(result)
    },
  )

  server.registerTool(
    'overturn_ruling',
    {
      description: 'Overturn an existing ruling with the same authority as the orch CLI.',
      inputSchema: {
        question_id: z.number().int().positive(),
        because: z.string().trim().min(1),
        replacement: z.string().trim().min(1).optional(),
        from_operator: z.boolean().optional(),
      },
      outputSchema: OverturnRulingResultSchema,
    },
    async ({ question_id, because, replacement, from_operator }) =>
      structured(
        overturnRuling({
          questionId: question_id,
          reason: because,
          replacement: replacement ?? null,
          fromOperator: from_operator ?? false,
        }),
      ),
  )

  server.registerTool(
    'relay_question',
    {
      description: 'Mark an open run question as waiting on the operator.',
      inputSchema: {
        run_id: z.number().int().positive(),
        question_id: z.number().int().positive().optional(),
        note: z.string().trim().min(1),
      },
    },
    async ({ run_id, question_id, note }) =>
      text({ question_id: relayQuestion(run_id, question_id, note) }),
  )
}
