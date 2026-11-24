import { createHash, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'

export const ASK_AUTH_PREAMBLE_MAX_BYTES = 4_096
export const ASK_AUTH_PREAMBLE_TIMEOUT_MS = 1_000

export function askAuthPreamble(token: string): string {
  return `${JSON.stringify({ bottega_ask_auth: { run_token: token } })}\n`
}

function matchingToken(candidate: string, expected: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(candidateDigest, expectedDigest)
}

function tokenFromPreamble(line: Buffer): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line.toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const outer = parsed as Record<string, unknown>
  if (Object.keys(outer).length !== 1) return null
  const auth = outer.bottega_ask_auth
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null
  const inner = auth as Record<string, unknown>
  return Object.keys(inner).length === 1 && typeof inner.run_token === 'string'
    ? inner.run_token
    : null
}

/** Authenticate the first line and restore any following MCP bytes to the socket. */
export function authenticateAskLoopbackSocket(
  socket: Socket,
  expectedToken: string,
  timeoutMs = ASK_AUTH_PREAMBLE_TIMEOUT_MS,
): Promise<boolean> {
  if (!expectedToken) {
    socket.destroy()
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref()

    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('end', onClosed)
      socket.off('close', onClosed)
      socket.off('error', onClosed)
    }
    const finish = (accepted: boolean, remainder?: Buffer) => {
      cleanup()
      if (!accepted) {
        socket.destroy()
      } else {
        socket.pause()
        if (remainder && remainder.length > 0) socket.unshift(remainder)
      }
      resolve(accepted)
    }
    const onClosed = () => finish(false)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf(0x0a)
      if (newline < 0) {
        if (buffered.length > ASK_AUTH_PREAMBLE_MAX_BYTES) finish(false)
        return
      }
      if (newline >= ASK_AUTH_PREAMBLE_MAX_BYTES) {
        finish(false)
        return
      }
      const candidate = tokenFromPreamble(buffered.subarray(0, newline))
      finish(
        candidate !== null && matchingToken(candidate, expectedToken),
        buffered.subarray(newline + 1),
      )
    }

    socket.on('data', onData)
    socket.once('end', onClosed)
    socket.once('close', onClosed)
    socket.once('error', onClosed)
  })
}
