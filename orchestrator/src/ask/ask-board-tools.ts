// concern: ask-board-tools
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { BOARD_BODY_MAX_CHARS, BOARD_TITLE_MAX_CHARS } from '../board/board-policy.ts'
import { suggestBoardPost } from '../board/board-suggestions.ts'

export function registerAskBoardTools(input: {
  server: McpServer
  runId: number
  authorized: () => boolean
  unauthorized: () => string
  text: (
    value: string,
    isError?: true,
  ) => { content: { type: 'text'; text: string }[]; isError?: true }
}): void {
  input.server.registerTool(
    'suggest_board_post',
    {
      description:
        'Suggest a board post to the architect who owns this run. Suggestions are context only and never interrupt.',
      inputSchema: z.object({
        title: z.string().min(1).max(BOARD_TITLE_MAX_CHARS),
        body: z.string().min(1).max(BOARD_BODY_MAX_CHARS),
        task: z.string().min(1).optional(),
        path: z.array(z.string()).optional(),
        topic: z.array(z.string()).optional(),
      }),
    },
    async ({ title, body, task, path, topic }) => {
      try {
        if (!input.authorized()) throw new Error(input.unauthorized())
        const saved = suggestBoardPost(input.runId, {
          title,
          body,
          task,
          paths: path,
          topics: topic,
        })
        return input.text(
          saved.dropped
            ? `Duplicate board suggestion ${saved.id} was already recorded.`
            : `Board suggestion ${saved.id} was sent to the owning architect.`,
        )
      } catch (error) {
        return input.text(`The board suggestion was not recorded (${String(error)}).`, true)
      }
    },
  )
}
