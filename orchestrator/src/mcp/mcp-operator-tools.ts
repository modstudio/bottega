// concern: operator-waiting
/** Registers MCP adapters for operator-ruling mutations. */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { FILING_DOC_SCOPES } from '../../../shared/docs.ts'
import {
  AnswerWaitingResultSchema,
  FileRulingResultSchema,
  type ListOpenQuestionsResult,
  ListOpenQuestionsResultSchema,
  OverturnRulingResultSchema,
} from '../../../shared/orch-contract.ts'
import { setDoc } from '../doc/docs.ts'
import { operatorWaiting, relayQuestion } from '../operator/operator-waiting.ts'
import { fileRuling, type RulingFileStores } from '../run/ruling-file.ts'
import { overturnRuling } from '../run/ruling-overturn.ts'
import { answerRun } from '../run/run-answer.ts'
import { queryInbox } from '../run/run-inbox.ts'
import { answerRunHelpers } from '../run/run-message-commands.ts'
import { fileNote } from './hub-notes.ts'

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
  return ListOpenQuestionsResultSchema.parse({
    questions: (await queryInbox({ scope: 'session' })).questions,
    waiting_on_operator: operatorWaiting(),
  })
}

const presentation = {
  printRunId: (_id: number) => {},
}

const rulingFileStores: RulingFileStores = {
  writeDoc: async (input) => {
    const doc = await setDoc(input)
    return { id: doc.id, revision: doc.revision }
  },
  fileNote,
}

export function registerOperatorTools(server: McpServer): void {
  server.registerTool(
    'list_open_questions',
    {
      description:
        'List open questions this session owns or may answer, plus items waiting on the operator.',
      outputSchema: z.object(ListOpenQuestionsResultSchema.shape).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => structured(await listOpenQuestions()),
  )

  server.registerTool(
    'answer_questions',
    {
      description: 'Answer every open question on a run and resume it detached by default.',
      inputSchema: z.object({
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
      }),
      outputSchema: z.object(AnswerWaitingResultSchema.shape).strict(),
    },
    async ({ run_id, rulings, from_operator, record_only }) => {
      const result = await answerRun(
        run_id,
        {
          rulings: rulings.map(({ question_id, ruling }) => ({
            questionId: question_id,
            text: ruling,
          })),
          fromOperator: from_operator ?? false,
          channel: 'mcp',
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
      inputSchema: z.object({
        question_id: z.number().int().positive(),
        because: z.string().trim().min(1),
        replacement: z.string().trim().min(1).optional(),
        from_operator: z.boolean().optional(),
      }),
      outputSchema: z.object(OverturnRulingResultSchema.shape).strict(),
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
    'file_ruling',
    {
      description: 'File an answered ruling as a doc or as a canon proposal note.',
      inputSchema: z.object({
        question_id: z.number().int().positive(),
        as: z.enum(['doc', 'canon']),
        scope: z.enum(FILING_DOC_SCOPES).optional(),
        subject: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).optional(),
        from_operator: z.boolean().optional(),
      }),
      outputSchema: z.object(FileRulingResultSchema.shape).strict(),
    },
    async ({ question_id, as, scope, subject, title, from_operator }) =>
      structured(
        await fileRuling(
          {
            questionId: question_id,
            as,
            scope,
            subject,
            title,
            fromOperator: from_operator ?? false,
            channel: 'mcp',
          },
          rulingFileStores,
        ),
      ),
  )

  server.registerTool(
    'relay_question',
    {
      description: 'Mark an open run question as waiting on the operator.',
      inputSchema: z.object({
        run_id: z.number().int().positive(),
        question_id: z.number().int().positive().optional(),
        note: z.string().trim().min(1),
      }),
    },
    async ({ run_id, question_id, note }) =>
      text({ question_id: relayQuestion(run_id, question_id, note) }),
  )
}
