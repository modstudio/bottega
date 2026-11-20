export { recordApiConfigured, resolveRecordApiUrl } from './record-api-url.ts'

/**
 * Set above Fly's idle close so the proxy, not the app, ends an idle connection.
 * Bun's unset default drops requests at ten seconds.
 */
export const HOSTED_SERVER_IDLE_TIMEOUT_SECONDS = 75

export function responseBodyBytes(response: Response): number | null {
  const value = response.headers.get('content-length')
  if (value === null || !/^\d+$/.test(value)) return null
  const bytes = Number(value)
  return Number.isSafeInteger(bytes) ? bytes : null
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
