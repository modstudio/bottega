export { recordApiConfigured, resolveRecordApiUrl } from './record-api-url.ts'

/**
 * Set above Fly's idle close so the proxy, not the app, ends an idle connection.
 * Bun's unset default drops requests at ten seconds.
 */
export const HOSTED_SERVER_IDLE_TIMEOUT_SECONDS = 75

export function contentLength(headers: Headers): number | null {
  const value = headers.get('content-length')
  if (value === null || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export type BodyCountFinish = 'complete' | 'error' | 'cancelled'

/** Wrap a response body with bounded, backpressured byte counting. */
export function countResponseBody(
  response: Response,
  onProgress: (bytes: number) => void,
  onFinish: (bytes: number, finish: BodyCountFinish) => void,
): Response {
  if (response.body === null) {
    onProgress(0)
    onFinish(0, 'complete')
    return response
  }
  let bytes = 0
  let finished = false
  const finish = (kind: BodyCountFinish) => {
    if (finished) return
    finished = true
    onFinish(bytes, kind)
  }
  const transformed = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength
        onProgress(bytes)
        controller.enqueue(chunk)
      },
      flush() {
        finish('complete')
      },
    }),
  )
  const reader = transformed.getReader()
  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          finish('complete')
          controller.close()
        } else controller.enqueue(result.value)
      } catch (error) {
        finish('error')
        controller.error(error)
      }
    },
    async cancel(reason) {
      finish('cancelled')
      await reader.cancel(reason)
    },
  })
  return new Response(counted, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export function hostedAccessLogLine(input: {
  method: string
  pathname: string
  status: number
  durationMs: number
  responseBytes?: number | null
  caller?: string | null
}): string {
  return `${input.method} ${input.pathname} ${input.status} ${Math.round(input.durationMs)}ms bytes=${input.responseBytes ?? '-'} caller=${input.caller ?? '-'}`
}

export function hostedTimedResponse(input: {
  response: Response
  method: string
  pathname: string
  durationMs: number
  caller?: string | null
}): { response: Response; accessLine: string; countBody: boolean } {
  let headersMutable = true
  try {
    input.response.headers.set('server-timing', `app;dur=${input.durationMs.toFixed(1)}`)
  } catch {
    // Redirects and pass-through fetch responses can have immutable headers.
    headersMutable = false
  }
  return {
    response: input.response,
    accessLine: hostedAccessLogLine({
      method: input.method,
      pathname: input.pathname,
      status: input.response.status,
      durationMs: input.durationMs,
      responseBytes: contentLength(input.response.headers),
      caller: input.caller,
    }),
    countBody:
      headersMutable &&
      contentLength(input.response.headers) === null &&
      input.response.body !== null,
  }
}

export function hostedAccessBodyLogLine(input: {
  method: string
  pathname: string
  status: number
  responseBytes: number
  finish: BodyCountFinish
  caller?: string | null
}): string {
  return `${input.method} ${input.pathname} ${input.status} body bytes=${input.responseBytes} finish=${input.finish} caller=${input.caller ?? '-'}`
}
