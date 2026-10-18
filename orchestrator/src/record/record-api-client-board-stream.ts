// concern: record-api-client
/** Classifies board stream responses without depending on the board transport implementation. */
import type { RecordBoardStreamOpen, RecordBoardStreamSource } from './record-api-client-paths.ts'

function sourceFromBody(body: ReadableStream<Uint8Array>): RecordBoardStreamSource {
  const reader = body.getReader()
  return {
    async read() {
      const result = await reader.read()
      return result.done ? null : (result.value ?? new Uint8Array())
    },
  }
}

export function classifyBoardStreamResponse(
  status: number,
  body: ReadableStream<Uint8Array> | null,
  close: () => void,
): RecordBoardStreamOpen {
  if (status === 401 || status === 403) return { kind: 'unauthorized' }
  if (status !== 200 || !body) return { kind: 'error', reason: `record API ${status}` }
  return { kind: 'stream', source: sourceFromBody(body), close }
}
