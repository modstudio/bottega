import { fileNote } from '../mcp/hub-notes.ts'

const BOARD_ANSWER_NOTE_BODY_MAX_CHARS = 1_000

export type AnswerNoteFiler = (
  input: { text: string; new: true },
  options: { cwd: string },
) => Promise<{ noteRecordId: string | null; noteLabel: string | null }>

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

function boundedBody(body: string): string {
  const collapsed = oneLine(body)
  if (collapsed.length <= BOARD_ANSWER_NOTE_BODY_MAX_CHARS) return collapsed
  return `${collapsed.slice(0, BOARD_ANSWER_NOTE_BODY_MAX_CHARS - 1)}…`
}

export function acceptedAnswerNoteText(input: {
  title: string
  replyBody: string
  askerOrigin: string
  answererOrigin: string
}): string {
  return oneLine(
    `${input.title}: ${boundedBody(input.replyBody)} (asked by ${input.askerOrigin}; answered by ${input.answererOrigin})`,
  )
}

export const fileAcceptedAnswerNote: AnswerNoteFiler = (input, options) => fileNote(input, options)
