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
import { declineBoardSuggestion, postBoardSuggestion } from '../board/board-suggestions.ts'
import {
  acceptAnswer,
  askQuestion,
  fileAnswerNote,
  readThread,
  replyToThread,
} from '../board/board-thread-service.ts'
import { registerBoardClaimTools } from './mcp-board-claim-tools.ts'

const result = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
})

export function registerBoardTools(server: McpServer): void {
  registerBoardClaimTools(server)
  server.registerTool(
    'board_ask',
    {
      description: 'Ask a local architect-board question.',
      inputSchema: z.object({
        audience: z.string().min(1),
        title: z.string().min(1).max(BOARD_TITLE_MAX_CHARS),
        body: z.string().min(1).max(BOARD_BODY_MAX_CHARS),
        task: z.string().min(1).optional(),
        path: z.array(z.string()).optional(),
        topic: z.array(z.string()).optional(),
        expires_ms: z.number().int().positive().optional(),
      }),
    },
    async (input) =>
      result(
        askQuestion({
          audience: input.audience,
          title: input.title,
          body: input.body,
          task: input.task,
          paths: input.path,
          topics: input.topic,
          expiresMs: input.expires_ms,
        }),
      ),
  )
  server.registerTool(
    'board_reply',
    {
      description: 'Reply to a local board notice or question thread.',
      inputSchema: z.object({
        root_id: z.number().int().positive(),
        body: z.string().min(1).max(BOARD_BODY_MAX_CHARS),
      }),
    },
    async ({ root_id, body }) => result(replyToThread(root_id, body)),
  )
  server.registerTool(
    'board_thread',
    {
      description: 'Read a local board thread.',
      inputSchema: z.object({ id: z.number().int().positive() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => result(readThread(id)),
  )
  server.registerTool(
    'board_accept',
    {
      description: 'Accept one reply as the final answer to a board question.',
      inputSchema: z.object({
        question_id: z.number().int().positive(),
        reply_id: z.number().int().positive(),
      }),
    },
    async ({ question_id, reply_id }) => result(await acceptAnswer(question_id, reply_id)),
  )
  server.registerTool(
    'board_file_note',
    {
      description: 'Retry filing the accepted answer for a board question as a note.',
      inputSchema: z.object({ question_id: z.number().int().positive() }),
    },
    async ({ question_id }) => result(await fileAnswerNote(question_id)),
  )
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
      return result(posted)
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
  server.registerTool(
    'board_suggestion_post',
    {
      description: 'Post an addressed worker suggestion as a new architect notice.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        audience: z.string().min(1),
        title: z.string().min(1).max(BOARD_TITLE_MAX_CHARS).optional(),
        body: z.string().min(1).max(BOARD_BODY_MAX_CHARS).optional(),
        task: z.string().min(1).optional(),
        path: z.array(z.string()).optional(),
        topic: z.array(z.string()).optional(),
      }),
    },
    async (input) =>
      result(
        postBoardSuggestion(input.id, {
          audience: input.audience,
          title: input.title,
          body: input.body,
          task: input.task,
          paths: input.path,
          topics: input.topic,
        }),
      ),
  )
  server.registerTool(
    'board_suggestion_decline',
    {
      description: 'Decline and withdraw an addressed worker suggestion.',
      inputSchema: z.object({ id: z.number().int().positive() }),
    },
    async ({ id }) => {
      declineBoardSuggestion(id)
      return result({ declined: id })
    },
  )
}
