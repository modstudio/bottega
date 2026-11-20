// concern: record-call-trace
/** Measures record API HTTP calls without coupling callers to a concern-specific client. */

import { PLATFORM_SLUG } from './brand.ts'
import { contentLength, countResponseBody } from './hosted-server.ts'

const RECORD_TRACE_ENV = `${PLATFORM_SLUG.toUpperCase()}_RECORD_TRACE`

export type RecordCallTrace = {
  routeClass: string
  method: string
  status: number | null
  requestBytes: number | null
  responseBytes: number | null
  clientMs: number
  serverMs: number | null
  open: boolean
}

type RecordTraceSummary = {
  routeClass: string
  count: number
  responseBytesTotal: number | null
  responseBytesMax: number | null
  clientMsTotal: number
  clientMsMax: number | null
  serverMsTotal: number | null
  serverMsMax: number | null
  open: number
}

const encoder = new TextEncoder()
const recordedCalls: RecordCallTrace[] = []

function configuredMode(): string | null {
  return process.env[RECORD_TRACE_ENV] ?? null
}

/** Recorded calls are exposed for behavioral tests and diagnostics. */
export function recordedRecordCalls(): readonly RecordCallTrace[] {
  return recordedCalls
}

export function recordRouteClass(path: string): string {
  const pathname = path.split('?', 1)[0] ?? path
  if (pathname.startsWith('/api/auth/')) return 'record-auth'
  if (pathname.startsWith('/public/v1/docs')) return 'record-public-docs'
  if (pathname.startsWith('/v1/board/stream')) return 'record-board-stream'
  const family = pathname.match(/^\/v1\/([^/]+)/)?.[1]
  return family ? `record-${family}` : 'record-other'
}

export function parseServerTiming(value: string | null): number | null {
  if (!value) return null
  for (const metric of value.split(',')) {
    const [name, ...parameters] = metric.split(';').map((part) => part.trim())
    if (name?.toLowerCase() !== 'app') continue
    const duration = parameters
      .map((part) => /^dur\s*=\s*(?:"([^"]+)"|([^\s]+))$/i.exec(part))
      .find((match) => match !== null)
    const parsed = Number(duration?.[1] ?? duration?.[2])
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  return null
}

function bodyBytes(body: BodyInit | null | undefined): number | null {
  if (body == null) return 0
  if (typeof body === 'string') return encoder.encode(body).byteLength
  if (body instanceof URLSearchParams) return encoder.encode(body.toString()).byteLength
  if (body instanceof Blob) return body.size
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  return null
}

function decimal(value: number): string {
  return value.toFixed(1)
}

function optionalDecimal(value: number | null): string {
  return value === null ? 'unknown' : decimal(value)
}

function optionalInteger(value: number | null): string {
  return value === null ? 'unknown' : String(value)
}

export function summarizeRecordCalls(calls: readonly RecordCallTrace[]): RecordTraceSummary[] {
  const grouped = new Map<string, RecordTraceSummary>()
  for (const call of calls) {
    const summary = grouped.get(call.routeClass) ?? {
      routeClass: call.routeClass,
      count: 0,
      responseBytesTotal: null,
      responseBytesMax: null,
      clientMsTotal: 0,
      clientMsMax: null,
      serverMsTotal: null,
      serverMsMax: null,
      open: 0,
    }
    summary.count += 1
    if (call.responseBytes !== null) {
      summary.responseBytesTotal = (summary.responseBytesTotal ?? 0) + call.responseBytes
      summary.responseBytesMax = Math.max(summary.responseBytesMax ?? 0, call.responseBytes)
    }
    summary.clientMsTotal += call.clientMs
    summary.clientMsMax = Math.max(summary.clientMsMax ?? 0, call.clientMs)
    if (call.serverMs !== null) {
      summary.serverMsTotal = (summary.serverMsTotal ?? 0) + call.serverMs
      summary.serverMsMax = Math.max(summary.serverMsMax ?? 0, call.serverMs)
    }
    if (call.open) summary.open += 1
    grouped.set(call.routeClass, summary)
  }
  return [...grouped.values()].sort((left, right) =>
    left.routeClass.localeCompare(right.routeClass),
  )
}

function combineSummaries(summaries: readonly RecordTraceSummary[]): RecordTraceSummary {
  return summaries.reduce<RecordTraceSummary>(
    (total, summary) => ({
      routeClass: 'total',
      count: total.count + summary.count,
      responseBytesTotal:
        summary.responseBytesTotal === null
          ? total.responseBytesTotal
          : (total.responseBytesTotal ?? 0) + summary.responseBytesTotal,
      responseBytesMax:
        summary.responseBytesMax === null
          ? total.responseBytesMax
          : Math.max(total.responseBytesMax ?? 0, summary.responseBytesMax),
      clientMsTotal: total.clientMsTotal + summary.clientMsTotal,
      clientMsMax:
        summary.clientMsMax === null
          ? total.clientMsMax
          : Math.max(total.clientMsMax ?? 0, summary.clientMsMax),
      serverMsTotal:
        summary.serverMsTotal === null
          ? total.serverMsTotal
          : (total.serverMsTotal ?? 0) + summary.serverMsTotal,
      serverMsMax:
        summary.serverMsMax === null
          ? total.serverMsMax
          : Math.max(total.serverMsMax ?? 0, summary.serverMsMax),
      open: total.open + summary.open,
    }),
    {
      routeClass: 'total',
      count: 0,
      responseBytesTotal: null,
      responseBytesMax: null,
      clientMsTotal: 0,
      clientMsMax: null,
      serverMsTotal: null,
      serverMsMax: null,
      open: 0,
    },
  )
}

function summaryLine(summary: RecordTraceSummary): string {
  return [
    'record-trace',
    `route=${summary.routeClass}`,
    `count=${summary.count}`,
    `response_bytes_total=${optionalInteger(summary.responseBytesTotal)}`,
    `response_bytes_max=${optionalInteger(summary.responseBytesMax)}`,
    `client_ms_total=${decimal(summary.clientMsTotal)}`,
    `client_ms_max=${optionalDecimal(summary.clientMsMax)}`,
    `server_ms_total=${optionalDecimal(summary.serverMsTotal)}`,
    `server_ms_max=${optionalDecimal(summary.serverMsMax)}`,
    `open=${summary.open}`,
  ].join(' ')
}

export function formatRecordCallSummary(calls: readonly RecordCallTrace[]): string[] {
  const summaries = summarizeRecordCalls(calls)
  return [...summaries, combineSummaries(summaries)].map(summaryLine)
}

function formatRecordCall(call: RecordCallTrace): string {
  return [
    'record-trace-call',
    `route=${call.routeClass}`,
    `method=${call.method}`,
    `status=${call.status ?? 'unknown'}`,
    `request_bytes=${optionalInteger(call.requestBytes)}`,
    `response_bytes=${optionalInteger(call.responseBytes)}`,
    `client_ms=${decimal(call.clientMs)}`,
    `server_ms=${optionalDecimal(call.serverMs)}`,
    `open=${call.open}`,
  ].join(' ')
}

function recordRecordCallTrace(call: RecordCallTrace): void {
  recordedCalls.push(call)
}

export async function tracedRecordFetch(
  url: string,
  init: RequestInit,
  transport: typeof fetch,
  observer: (call: RecordCallTrace) => void = recordRecordCallTrace,
): Promise<Response> {
  const mode = configuredMode()
  if (!mode && observer === recordRecordCallTrace) return transport(url, init)
  const startedAt = performance.now()
  const routeClass = recordRouteClass(new URL(url).pathname)
  try {
    const response = await transport(url, init)
    const responseBytes = contentLength(response.headers)
    const common = {
      routeClass,
      method: init.method ?? 'GET',
      status: response.status,
      requestBytes: bodyBytes(init.body),
      serverMs: parseServerTiming(response.headers.get('server-timing')),
    }
    const call: RecordCallTrace = {
      ...common,
      responseBytes: responseBytes ?? 0,
      clientMs: performance.now() - startedAt,
      open: responseBytes === null && response.body !== null,
    }
    observer(call)
    const finish = (measuredResponseBytes: number) => {
      call.responseBytes = measuredResponseBytes
      call.clientMs = performance.now() - startedAt
      call.open = false
      if (mode === 'calls') process.stderr.write(`${formatRecordCall(call)}\n`)
    }
    if (responseBytes !== null || response.body === null) {
      finish(responseBytes ?? 0)
      return response
    }
    return countResponseBody(
      response,
      (bytes) => {
        call.responseBytes = bytes
        call.clientMs = performance.now() - startedAt
      },
      (bytes) => finish(bytes),
    )
  } catch (error) {
    const call = {
      routeClass,
      method: init.method ?? 'GET',
      status: null,
      requestBytes: bodyBytes(init.body),
      responseBytes: null,
      clientMs: performance.now() - startedAt,
      serverMs: null,
      open: false,
    }
    observer(call)
    if (mode === 'calls') process.stderr.write(`${formatRecordCall(call)}\n`)
    throw error
  }
}

process.once('exit', () => {
  if (configuredMode())
    for (const line of formatRecordCallSummary(recordedRecordCalls()))
      process.stderr.write(`${line}\n`)
})
