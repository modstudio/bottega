// concern: record-api-client
/** Classifies board stream responses without depending on the board transport implementation. */
import { recordUnreachableRefusal } from '../../../shared/record-remedies.ts'
import type { RecordBoardStreamOpen, RecordBoardStreamSource } from './record-api-client-paths.ts'
import { boardStreamHeaders, recordTransport } from './record-api-client-transport.ts'

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

function releaseUnopenedStream(response: Response, connection: AbortController): void {
  try {
    if (response.body) void response.body.cancel()
  } finally {
    connection.abort()
  }
}

export async function openBoardStream(input: {
  signal?: AbortSignal
  transport: typeof fetch
  readToken(): string | null
  preflight(): void
  origin(): string
}): Promise<RecordBoardStreamOpen> {
  if (input.signal?.aborted) return { kind: 'error', reason: 'aborted' }
  const token = input.readToken()
  if (!token) return { kind: 'unauthorized' }
  const connection = new AbortController()
  const stop = () => connection.abort()
  input.signal?.addEventListener('abort', stop)
  const drop = () => input.signal?.removeEventListener('abort', stop)
  const close = () => {
    drop()
    connection.abort()
  }
  let origin: string | null = null
  try {
    input.preflight()
    origin = input.origin()
    const response = await recordTransport(
      origin,
      '/v1/board/stream',
      { method: 'GET', headers: boardStreamHeaders(token), signal: connection.signal },
      input.transport,
    )
    const opened = classifyBoardStreamResponse(response.status, response.body, close)
    if (opened.kind !== 'stream') {
      releaseUnopenedStream(response, connection)
      drop()
    }
    return opened
  } catch (error) {
    connection.abort()
    drop()
    if (input.signal?.aborted) return { kind: 'error', reason: 'aborted' }
    const detail = error instanceof Error ? error.message : String(error)
    return {
      kind: 'error',
      reason: origin ? recordUnreachableRefusal(origin, detail, 'probe') : detail,
    }
  }
}
