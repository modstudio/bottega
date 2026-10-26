import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { BOARD_PURPOSES, defaultBoardPurpose } from '../../../shared/board-purpose.ts'
import { assetPath } from '../../../shared/install-root.ts'
import { readBoardNotices } from '../board/board-delivery.ts'
import { resolveLocalBoardMessageIdentifier } from '../board/board-message-identifier.ts'
import {
  boardAccept,
  boardAcknowledge,
  boardAsk,
  boardFileNote,
  boardPost,
  boardReply,
  boardStatus,
  boardThread,
  boardWithdraw,
} from '../board/board-operations.ts'
import {
  architectIdentity,
  BOARD_BODY_MAX_CHARS,
  BOARD_TITLE_MAX_CHARS,
} from '../board/board-policy.ts'
import { parseReplyAudienceOption } from '../board/board-reply-audience.ts'
import { declineBoardSuggestion, postBoardSuggestion } from '../board/board-suggestions.ts'
import { db } from '../database/db.ts'
import { registerBoardClaimTools } from './mcp-board-claim-tools.ts'

const ARCHITECTS_AUDIENCE_HELP =
  'Audience architects means this project; architects:all means every project; architects:<project> names one project.'

const result = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
})

function boardHeartbeatGuidance(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const session = architectIdentity(env)?.session
  if (!session) return null
  return `Arm under Monitor from the main checkout: ${assetPath('orchestrator', 'hooks', 'orch-heartbeat.sh')} ${session}`
}

function withHeartbeatGuidance<T>(value: T, required: boolean): T | (T & { heartbeat: string }) {
  if (!required) return value
  const heartbeat = boardHeartbeatGuidance()
  return heartbeat && typeof value === 'object' && value !== null ? { ...value, heartbeat } : value
}

function registerBoardPostTool(server: McpServer): void {
  server.registerTool(
    'board_post',
    {
      description: `Post an architect-board notice. Purpose information sends one line, request sends the full body, and standing also reaches later sessions. Requests that outlive the four-hour default should set expires_ms. ${ARCHITECTS_AUDIENCE_HELP}`,
      inputSchema: z.object({
        audience: z.string().min(1),
        title: z.string().min(1).max(BOARD_TITLE_MAX_CHARS),
        body: z.string().min(1).max(BOARD_BODY_MAX_CHARS),
        purpose: z.enum(BOARD_PURPOSES).optional(),
        task: z.string().min(1).optional(),
        path: z.array(z.string()).optional(),
        topic: z.array(z.string()).optional(),
        ack_required: z.boolean().optional(),
        deadline_ms: z.number().int().positive().optional(),
        expires_ms: z.number().int().positive().optional(),
      }),
    },
    async (input) => {
      const purpose = defaultBoardPurpose(input.purpose, Boolean(input.ack_required))
      return result(
        withHeartbeatGuidance(
          await boardPost({
            audience: input.audience,
            title: input.title,
            body: input.body,
            purpose,
            task: input.task,
            paths: input.path,
            topics: input.topic,
            ackRequired: input.ack_required,
            deadlineMs: input.deadline_ms,
            expiresMs: input.expires_ms,
          }),
          purpose === 'request',
        ),
      )
    },
  )
}

function registerBoardAskTool(server: McpServer): void {
  server.registerTool(
    'board_ask',
    {
      description: `Ask an architect-board question. ${ARCHITECTS_AUDIENCE_HELP}`,
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
        withHeartbeatGuidance(
          await boardAsk({
            audience: input.audience,
            title: input.title,
            body: input.body,
            task: input.task,
            paths: input.path,
            topics: input.topic,
            expiresMs: input.expires_ms,
          }),
          true,
        ),
      ),
  )
}

function registerBoardReplyTool(server: McpServer): void {
  server.registerTool(
    'board_reply',
    {
      description:
        'Reply to a board notice or question thread. Audience may be participants, acknowledged, audience, operator, or session:<id>; session:<id> loops that session into the thread.',
      inputSchema: z.object({
        root_id: z.string().min(1),
        audience: z.string().min(1).optional(),
        body: z.string().min(1).max(BOARD_BODY_MAX_CHARS),
      }),
    },
    async ({ root_id, body, audience }) =>
      result(
        await boardReply(
          root_id,
          body,
          undefined,
          audience === undefined ? null : parseReplyAudienceOption(audience),
        ),
      ),
  )
}

function registerBoardThreadTool(server: McpServer): void {
  server.registerTool(
    'board_thread',
    {
      description: 'Read a board thread.',
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => result(await boardThread(id)),
  )
}

function registerBoardAcceptTool(server: McpServer): void {
  server.registerTool(
    'board_accept',
    {
      description: 'Accept one reply as the final answer to a board question.',
      inputSchema: z.object({
        question_id: z.string().min(1),
        reply_id: z.string().min(1),
      }),
    },
    async ({ question_id, reply_id }) => result(await boardAccept(question_id, reply_id)),
  )
}

export function registerBoardTools(server: McpServer): void {
  registerBoardClaimTools(server)
  registerBoardPostTool(server)
  registerBoardAskTool(server)
  registerBoardReplyTool(server)
  registerBoardThreadTool(server)
  registerBoardAcceptTool(server)
  server.registerTool(
    'board_file_note',
    {
      description: 'Retry filing the accepted answer for a board question as a note.',
      inputSchema: z.object({ question_id: z.string().min(1) }),
    },
    async ({ question_id }) => result(await boardFileNote(question_id)),
  )
  server.registerTool(
    'board_read',
    {
      description: 'Read live local notices addressed to the caller and stamp delivery.',
      inputSchema: z.object({ all: z.boolean().optional() }),
    },
    async ({ all }) => {
      const delivery = await readBoardNotices(all ?? false)
      return result({
        notices: delivery.notices.map((notice) => ({ ...notice, id: String(notice.id) })),
        warning: delivery.warning,
      })
    },
  )
  server.registerTool(
    'board_ack',
    {
      description: 'Explicitly acknowledge a local board notice.',
      inputSchema: z.object({ id: z.string().min(1) }),
    },
    async ({ id }) => {
      return result(await boardAcknowledge(id))
    },
  )
  server.registerTool(
    'board_status',
    {
      description: 'Show per-reader delivery and acknowledgement receipts for a notice.',
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => result(await boardStatus(id)),
  )
  server.registerTool(
    'board_withdraw',
    {
      description: 'Withdraw a notice as its author or the operator.',
      inputSchema: z.object({ id: z.string().min(1) }),
    },
    async ({ id }) => {
      return result(await boardWithdraw(id))
    },
  )
  server.registerTool(
    'board_suggestion_post',
    {
      description: `Post an addressed worker suggestion as a new architect notice. ${ARCHITECTS_AUDIENCE_HELP}`,
      inputSchema: z.object({
        id: z.string().min(1),
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
        (() => {
          const posted = postBoardSuggestion(resolveLocalBoardMessageIdentifier(db(), input.id), {
            audience: input.audience,
            title: input.title,
            body: input.body,
            task: input.task,
            paths: input.path,
            topics: input.topic,
          })
          return posted
        })(),
      ),
  )
  server.registerTool(
    'board_suggestion_decline',
    {
      description: 'Decline and withdraw an addressed worker suggestion.',
      inputSchema: z.object({ id: z.string().min(1) }),
    },
    async ({ id }) => {
      declineBoardSuggestion(resolveLocalBoardMessageIdentifier(db(), id))
      return result({ declined: id })
    },
  )
}
