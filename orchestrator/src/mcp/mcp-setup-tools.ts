// concern: setup-mcp-tools
/** Registers the harness-facing setup plan and apply adapters. */

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  planSetupActions,
  recommendedAnswers,
  setupActionChangesMachine,
  setupActionLine,
} from '../setup/setup-planner.ts'
import {
  SetupAnswersRefusedError,
  type SetupService,
  setupService,
} from '../setup/setup-service.ts'

const questionSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    why: z.string(),
    recommendation: z.string(),
    options: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          why: z.string(),
        })
        .strict(),
    ),
  })
  .strict()

const noticeSchema = z.object({ message: z.string(), fix: z.string().nullable() }).strict()

const actionResultSchema = z
  .object({
    line: z.string(),
    status: z.enum(['applied', 'unchanged', 'refused', 'not-attempted']),
    message: z.string().nullable(),
  })
  .strict()

const planOutputSchema = z
  .object({
    questions: z.array(questionSchema),
    notices: z.array(noticeSchema),
    changes: z.array(z.string()),
  })
  .strict()

const applyOutputSchema = z
  .object({
    actions: z.array(actionResultSchema),
    refused: z.boolean(),
  })
  .strict()

const folderSchema = z.string().superRefine((folder, context) => {
  if (!isAbsolute(folder)) {
    context.addIssue({
      code: 'custom',
      message: `folder must be an absolute path: ${JSON.stringify(folder)}`,
    })
    return
  }
  if (!existsSync(folder)) {
    context.addIssue({
      code: 'custom',
      message: `folder does not exist: ${JSON.stringify(folder)}`,
    })
  }
})

const foldersSchema = z.array(folderSchema).min(1, 'folders must be a non-empty array; received []')

const structured = <T extends Record<string, unknown>>(value: T) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value,
})

function refuseWorkerCaller(tool: string): void {
  if (process.env.ORCH_RUN_ID || process.env.ORCH_DEPTH) {
    throw new Error(
      `${tool} refuses worker-marked callers because ORCH_RUN_ID or ORCH_DEPTH is set`,
    )
  }
}

export function registerSetupTools(
  server: McpServer,
  service: Pick<SetupService, 'plan' | 'apply'> = setupService,
): void {
  server.registerTool(
    'setup_plan',
    {
      description:
        "Plan setup. Present every question, option, recommendation and why to the user, then pass the user's choices to setup_apply.",
      inputSchema: z.object({ folders: foldersSchema }).strict(),
      outputSchema: z.object(planOutputSchema.shape).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ folders }) => {
      refuseWorkerCaller('setup_plan')
      const plan = await service.plan(folders)
      const changes = planSetupActions(plan, recommendedAnswers(plan))
        .filter(setupActionChangesMachine)
        .map(setupActionLine)
      return structured(
        planOutputSchema.parse({
          questions: plan.questions.map((question) => ({
            id: question.id,
            question: question.question,
            why: question.why,
            recommendation: question.recommendation,
            options: question.options.map((option) => ({
              id: option.id,
              label: option.label,
              why: option.why,
            })),
          })),
          notices: plan.notices,
          changes,
        }),
      )
    },
  )

  server.registerTool(
    'setup_apply',
    {
      description:
        "Register MCP servers in harnesses, register projects, and possibly write a recipe file. Answers must be the user's choices from setup_plan.",
      inputSchema: z
        .object({
          folders: foldersSchema,
          answers: z.record(z.string(), z.string()),
        })
        .strict(),
      outputSchema: z.object(applyOutputSchema.shape).strict(),
    },
    async ({ folders, answers }) => {
      refuseWorkerCaller('setup_apply')
      try {
        const outcome = await service.apply(folders, answers)
        const actions = outcome.results.map((result) => ({
          line: setupActionLine(result),
          status: result.status,
          message: result.message,
        }))
        return structured(
          applyOutputSchema.parse({
            actions,
            refused: actions.some((action) => action.status === 'refused'),
          }),
        )
      } catch (error) {
        if (error instanceof SetupAnswersRefusedError) {
          throw new Error(`${error.message}; call setup_plan again and use the user's choices`)
        }
        throw error
      }
    },
  )
}
