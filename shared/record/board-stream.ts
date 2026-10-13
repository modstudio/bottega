import { z } from 'zod'

/** Postgres channel used only to wake hosted board stream subscribers. */
export const BOARD_MESSAGE_NOTIFY_CHANNEL = 'record_board_message_advanced' as const

/** Wire contract shared by the hosted stream and its later machine client. */
export const BOARD_STREAM_EVENT = {
  name: 'board-advanced',
  data: z.object({ revision: z.string().regex(/^\d+$/) }).strict(),
} as const

export type BoardStreamEventData = z.infer<(typeof BOARD_STREAM_EVENT)['data']>
