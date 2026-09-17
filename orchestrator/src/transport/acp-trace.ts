import type { ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

const BYTE_CAP = 2 * 1024

type TraceValue = string | number | boolean | null
type TraceFields = Record<string, TraceValue | TraceValue[]>

export type AcpTrace = {
  marker(event: string, fields?: TraceFields): void
  bytes(direction: 'stdin' | 'stdout', chunk: string | Uint8Array, encoding?: BufferEncoding): void
}

/** Check the gate before allocating trace state or touching a stream. */
export function createAcpTrace(
  directory: string | undefined,
  runId: string,
  pid: number,
  binary: string,
  argv: string[],
  cwd: string,
  sandboxApplied: boolean,
): AcpTrace | null {
  if (!directory) return null
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${runId}-${pid}.acp-trace.jsonl`)
  const marker = (event: string, fields: TraceFields = {}) => {
    appendFileSync(
      path,
      `${JSON.stringify({ t_ns: process.hrtime.bigint().toString(), event, ...fields })}\n`,
    )
  }
  const trace: AcpTrace = {
    marker,
    bytes(direction, chunk, encoding) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk)
      const captured = bytes.subarray(0, BYTE_CAP)
      marker('bytes', {
        direction,
        length: bytes.length,
        capturedLength: captured.length,
        bytesHex: captured.toString('hex'),
      })
    },
  }
  marker('launch', {
    binary,
    argv,
    cwd,
    sandboxApplied,
  })
  return trace
}

export function installAcpChildTrace(trace: AcpTrace | null, child: ChildProcess): void {
  if (!trace) return
  child.on('exit', (code, signal) => trace.marker('child.exit', { code, signal }))
}

export function installAcpConnectionTrace(trace: AcpTrace | null, closed: Promise<void>): void {
  if (!trace) return
  void closed.then(() => trace.marker('sdk.connection.close'))
}

/** Observe the existing pipes without inserting a transform into either path. */
export function installAcpStreamTrace(
  trace: AcpTrace | null,
  stdin: Writable,
  stdout: Readable,
): void {
  if (!trace) return

  const write = stdin.write.bind(stdin)
  stdin.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined
    trace.bytes('stdin', chunk, encoding)
    if (typeof encodingOrCallback === 'function') return write(chunk, encodingOrCallback)
    if (encodingOrCallback === undefined) return write(chunk, callback)
    return write(chunk, encodingOrCallback, callback)
  }) as typeof stdin.write

  stdout.on('data', (chunk: Buffer | string) => trace.bytes('stdout', chunk))
  stdout.on('end', () => trace.marker('stdout.end'))
  stdout.on('error', (error: Error) => trace.marker('stdout.error', { error: error.message }))
}

/** Put stage markers immediately around the exact bounded handshake await. */
export async function traceAcpHandshake<T>(
  trace: AcpTrace | null,
  stage: 'initialize' | 'session/load' | 'session/new',
  request: () => Promise<T>,
): Promise<T> {
  trace?.marker('handshake.before', { stage })
  try {
    return await request()
  } finally {
    trace?.marker('handshake.after', { stage })
  }
}
