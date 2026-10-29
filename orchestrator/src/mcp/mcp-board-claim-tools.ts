import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  boardClaimList,
  boardClaimRelease,
  boardClaimReleaseTask,
  boardClaimRenew,
  boardClaimTake,
} from '../board/board-operations.ts'
import { db } from '../database/db.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
})

export const BOARD_CLAIM_TOOL_NAMES = [
  'board_claim_take',
  'board_claim_renew',
  'board_claim_release',
  'board_claim_list',
  'board_claim_release_task',
] as const

const [takeTool, renewTool, releaseTool, listTool, releaseTaskTool] = BOARD_CLAIM_TOOL_NAMES

export function registerBoardClaimTools(server: McpServer): void {
  server.registerTool(
    takeTool,
    {
      description: 'Take or renew a coordination claim.',
      inputSchema: z.object({
        subject: z.string().min(1),
        duration_ms: z.number().int().positive().optional(),
        run_record_id: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
        note: z.string().optional(),
        project: z.string().min(1).optional(),
        force: z.boolean().optional(),
      }),
    },
    async (input) =>
      result(
        await boardClaimTake({
          subject: input.subject,
          durationMs: input.duration_ms,
          runId:
            input.run_record_id === undefined
              ? undefined
              : resolveRunIdentifier(db(), input.run_record_id),
          note: input.note,
          project: input.project,
          force: input.force,
        }),
      ),
  )
  server.registerTool(
    renewTool,
    {
      description: 'Renew a live coordination claim.',
      inputSchema: z.object({ id: z.string().min(1) }),
    },
    async ({ id }) => result(await boardClaimRenew(id)),
  )
  server.registerTool(
    releaseTool,
    {
      description: 'Release a live coordination claim.',
      inputSchema: z.object({ id: z.string().min(1) }),
    },
    async ({ id }) => result(await boardClaimRelease(id)),
  )
  server.registerTool(
    listTool,
    {
      description: 'List coordination claims for a project.',
      inputSchema: z.object({ project: z.string().min(1).optional(), all: z.boolean().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, all }) => result(await boardClaimList(project, all ?? false)),
  )
  server.registerTool(
    releaseTaskTool,
    {
      description: 'Release live claims for a closed task.',
      inputSchema: z.object({ key: z.string().min(1), project: z.string().min(1) }),
    },
    async ({ key, project }) => result(await boardClaimReleaseTask(key, project)),
  )
}
