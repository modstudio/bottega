// concern: board-watch-frames
/** Parses hosted board stream frames. Must not know HTTP, stores, or reconnect policy. */

import { BOARD_STREAM_EVENT } from '../record/record-board-stream.ts'

/** Pending text held until a frame terminator; exceeding this is a protocol error. */
export const BOARD_WATCH_FRAME_BUFFER_MAX = 65_536

export type BoardStreamFrame =
  | { kind: 'heartbeat' }
  | { kind: 'event'; revision: string }
  | { kind: 'malformed' }

export type BoardStreamParse = {
  frames: BoardStreamFrame[]
  protocolError: boolean
}

function lineEndingLength(text: string, index: number): number {
  if (index >= text.length) return 0
  if (text[index] === '\r' && text[index + 1] === '\n') return 2
  if (text[index] === '\n' || text[index] === '\r') return 1
  return 0
}

function takeFrame(pending: string): { raw: string; rest: string } | null {
  let index = 0
  while (index < pending.length) {
    const first = lineEndingLength(pending, index)
    if (first === 0) {
      index += 1
      continue
    }
    if (pending[index] === '\r' && index + 1 === pending.length) return null
    const next = index + first
    const second = lineEndingLength(pending, next)
    if (second === 0) {
      index = next
      continue
    }
    if (pending[next] === '\r' && next + 1 === pending.length) return null
    return { raw: pending.slice(0, index), rest: pending.slice(next + second) }
  }
  return null
}

export function createBoardStreamParser() {
  let pending = ''
  return {
    push(chunk: string): BoardStreamParse {
      pending += chunk
      const frames: BoardStreamFrame[] = []
      for (;;) {
        const taken = takeFrame(pending)
        if (!taken) break
        pending = taken.rest
        const parsed = parseBoardStreamFrame(taken.raw)
        if (parsed) frames.push(parsed)
      }
      if (pending.length <= BOARD_WATCH_FRAME_BUFFER_MAX) return { frames, protocolError: false }
      pending = ''
      return { frames, protocolError: true }
    },
  }
}

function parseBoardStreamFrame(raw: string): BoardStreamFrame | null {
  const lines = raw.split(/\r\n|\n|\r/)
  if (lines.every((line) => line === '')) return null
  const fields = lines.filter((line) => line !== '' && !line.startsWith(':'))
  if (fields.length === 0) return { kind: 'heartbeat' }
  const record: Record<string, string> = {}
  for (const line of fields) {
    const colon = line.indexOf(':')
    if (colon <= 0) return { kind: 'malformed' }
    const name = line.slice(0, colon)
    let value = line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    record[name] = name === 'data' && record.data !== undefined ? `${record.data}\n${value}` : value
  }
  if (record.event !== BOARD_STREAM_EVENT.name || record.data === undefined)
    return { kind: 'malformed' }
  try {
    const parsed = BOARD_STREAM_EVENT.data.safeParse(JSON.parse(record.data))
    return parsed.success
      ? { kind: 'event', revision: parsed.data.revision }
      : { kind: 'malformed' }
  } catch {
    return { kind: 'malformed' }
  }
}
