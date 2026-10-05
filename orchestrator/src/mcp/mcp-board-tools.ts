import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { BOARD_BODY_MAX_CHARS, BOARD_TITLE_MAX_CHARS } from '../board/board-policy.ts'
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

const noReachWarning = 'reached no live session; re-address it or wait for a matching session'

export function registerBoardTools(server: McpServer): void {
  server.registerTool(
    'board_post',
    {
      description: 'Post a local architect-board notice.',
      inputSchema: z.object({
        audience: z.string().min(1),
        title: z.string().min(1).max(BOARD_TITLE_MAX_CHARS),
        body: z.string().min(1).max(BOARD_BODY_MAX_CHARS),
        task: z.string().min(1).optional(),
        path: z.array(z.string()).optional(),
        topic: z.array(z.string()).optional(),
        ack_required: z.boolean().optional(),
        deadline_ms: z.number().int().positive().optional(),
        expires_ms: z.number().int().positive().optional(),
      }),
    },
    async (input) => {
      const posted = postNotice({
        audience: input.audience,
        title: input.title,
        body: input.body,
        task: input.task,
        paths: input.path,
        topics: input.topic,
        ackRequired: input.ack_required,
        deadlineMs: input.deadline_ms,
        expiresMs: input.expires_ms,
      })
      return result(posted.reached === 0 ? { ...posted, warning: noReachWarning } : posted)
    },
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
