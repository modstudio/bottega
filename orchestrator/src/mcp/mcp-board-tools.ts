import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  acknowledgeNotice,
  noticeStatus,
  postNotice,
  readNotices,
  withdrawNotice,
} from '../board/board-service.ts'

const result = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
})

export function registerBoardTools(server: McpServer): void {
  server.registerTool(
    'board_post',
    {
      description: 'Post a local architect-board notice.',
      inputSchema: z.object({
        audience: z.string().min(1),
        title: z.string().min(1),
        body: z.string().min(1),
        ack_required: z.boolean().optional(),
        deadline_ms: z.number().int().positive().optional(),
        expires_ms: z.number().int().positive().optional(),
      }),
    },
    async (input) =>
      result(
        postNotice({
          audience: input.audience,
          title: input.title,
          body: input.body,
          ackRequired: input.ack_required,
          deadlineMs: input.deadline_ms,
          expiresMs: input.expires_ms,
        }),
      ),
  )
  server.registerTool(
    'board_read',
    {
      description: 'Read live local notices addressed to the caller and stamp delivery.',
      inputSchema: z.object({ all: z.boolean().optional() }),
    },
    async ({ all }) => result(readNotices(all ?? false)),
  )
  server.registerTool(
    'board_ack',
    {
      description: 'Explicitly acknowledge a local board notice.',
      inputSchema: z.object({ id: z.number().int().positive() }),
    },
    async ({ id }) => {
      acknowledgeNotice(id)
      return result({ acknowledged: id })
    },
  )
  server.registerTool(
    'board_status',
    {
      description: 'Show per-reader delivery and acknowledgement receipts for a notice.',
      inputSchema: z.object({ id: z.number().int().positive() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => result(noticeStatus(id)),
  )
  server.registerTool(
    'board_withdraw',
    {
      description: 'Withdraw a notice as its author or the operator.',
      inputSchema: z.object({ id: z.number().int().positive() }),
    },
    async ({ id }) => {
      withdrawNotice(id)
      return result({ withdrawn: id })
    },
  )
}
