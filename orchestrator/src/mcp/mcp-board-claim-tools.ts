import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  listClaims,
  releaseClaim,
  releaseTaskClaims,
  renewClaim,
  takeClaim,
} from '../board/board-claim-service.ts'

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
})

export function registerBoardClaimTools(server: McpServer): void {
  server.registerTool(
    'board_claim_take',
    {
      description: 'Take or renew a coordination claim.',
      inputSchema: z.object({
        subject: z.string().min(1),
        duration_ms: z.number().int().positive().optional(),
        run_id: z.number().int().positive().optional(),
        note: z.string().optional(),
        project: z.string().min(1).optional(),
        force: z.boolean().optional(),
      }),
    },
    async (input) =>
      result(
        takeClaim({
          subject: input.subject,
          durationMs: input.duration_ms,
          runId: input.run_id,
          note: input.note,
          project: input.project,
          force: input.force,
        }),
      ),
  )
  server.registerTool(
    'board_claim_renew',
    {
      description: 'Renew a live coordination claim.',
      inputSchema: z.object({ id: z.number().int().positive() }),
    },
    async ({ id }) => result(renewClaim(id)),
  )
  server.registerTool(
    'board_claim_release',
    {
      description: 'Release a live coordination claim.',
      inputSchema: z.object({ id: z.number().int().positive() }),
    },
    async ({ id }) => result(releaseClaim(id)),
  )
  server.registerTool(
    'board_claim_list',
    {
      description: 'List coordination claims for a project.',
      inputSchema: z.object({ project: z.string().min(1).optional(), all: z.boolean().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, all }) => result(listClaims(project, all ?? false)),
  )
  server.registerTool(
    'board_claim_release_task',
    {
      description: 'Release live claims for a closed task.',
      inputSchema: z.object({ key: z.string().min(1), project: z.string().min(1) }),
    },
    async ({ key, project }) => result(releaseTaskClaims(key, project)),
  )
}
