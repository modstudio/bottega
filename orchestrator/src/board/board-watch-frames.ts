// concern: board-watch-frames
/** Parses hosted board stream frames. Must not know HTTP, stores, or reconnect policy. */

import { BOARD_STREAM_EVENT } from '../record/record-board-stream.ts'

export type BoardStreamFrame =
  | { kind: 'heartbeat' }
  | { kind: 'event'; revision: string }
  | { kind: 'malformed' }

export function createBoardStreamParser() {
  let pending = ''
  return {
    push(chunk: string): BoardStreamFrame[] {
      pending += chunk
      const frames: BoardStreamFrame[] = []
      for (;;) {
        const split = pending.indexOf('\n\n')
        if (split < 0) return frames
        const raw = pending.slice(0, split)
        pending = pending.slice(split + 2)
        const parsed = parseBoardStreamFrame(raw)
        if (parsed) frames.push(parsed)
      }
    },
  }
}

function parseBoardStreamFrame(raw: string): BoardStreamFrame | null {
  const lines = raw.split('\n').map((line) => line.replace(/\r$/, ''))
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
