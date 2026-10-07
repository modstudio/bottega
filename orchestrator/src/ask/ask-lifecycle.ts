// concern: orch-ask lifecycle evidence and its derived turn summary
import type { JSONRPCMessage, Transport, TransportSendOptions } from '@modelcontextprotocol/server'
import { appendRunEvent, type RunLogEvent } from '../events.ts'

export type AskLifecycle = {
  started(tools: string[]): void
  initialized(): void
}

export function askLifecycle(runId: number): AskLifecycle {
  const append = (event: RunLogEvent) =>
    appendRunEvent(runId, event, undefined, { notWorkerActivity: true })
  return {
    started: (tools) => append({ ts: new Date().toISOString(), type: 'ask_started', tools }),
    initialized: () => append({ ts: new Date().toISOString(), type: 'ask_initialized' }),
  }
}

export function recordAskExpected(
  runId: number,
  transport: 'host' | 'srt',
  command: string[],
): void {
  appendRunEvent(
    runId,
    { ts: new Date().toISOString(), type: 'ask_expected', transport, command },
    undefined,
    { notWorkerActivity: true },
  )
}

function listedTools(message: JSONRPCMessage): string[] | null {
  if (!('result' in message) || !message.result || typeof message.result !== 'object') return null
  const tools = (message.result as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return null
  return tools.flatMap((tool) =>
    tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string'
      ? [(tool as { name: string }).name]
      : [],
  )
}

/** Observe tools/list at the transport boundary without replacing an SDK handler. */
export function observeAskTransport(transport: Transport, runId: number): Transport {
  const pendingLists = new Set<string | number>()
  const observed: Transport = {
    get sessionId() {
      return transport.sessionId
    },
    get hasPerRequestStream() {
      return transport.hasPerRequestStream
    },
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    async start() {
      transport.onclose = () => observed.onclose?.()
      transport.onerror = (error) => observed.onerror?.(error)
      transport.onmessage = (message, extra) => {
        if (
          'method' in message &&
          message.method === 'tools/list' &&
          'id' in message &&
          message.id !== undefined
        ) {
          pendingLists.add(message.id)
        }
        observed.onmessage?.(message, extra)
      }
      await transport.start()
    },
    async send(message: JSONRPCMessage, options?: TransportSendOptions) {
      if ('id' in message && message.id !== undefined && pendingLists.delete(message.id)) {
        const tools = listedTools(message)
        if (tools) {
          appendRunEvent(
            runId,
            { ts: new Date().toISOString(), type: 'ask_listed', tools },
            undefined,
            { notWorkerActivity: true },
          )
        }
      }
      await transport.send(message, options)
    },
    close: () => transport.close(),
    setProtocolVersion: transport.setProtocolVersion?.bind(transport),
    setSupportedProtocolVersions: transport.setSupportedProtocolVersions?.bind(transport),
  }
  return observed
}

type Seen = 'seen' | 'not_seen' | 'not_recorded'

export type AskServerSummary = {
  expected: Seen
  started: Seen
  initialized: Seen
  listed: Seen
  transport: 'host' | 'srt' | null
  command: string[] | null
  registered_tools: string[] | null
  listed_tools: string[] | null
  failure: string | null
}

export function summarizeAskServer(
  events: RunLogEvent[] | null,
  failure: string | null,
): AskServerSummary {
  const status = (seen: boolean): Seen =>
    events === null ? 'not_recorded' : seen ? 'seen' : 'not_seen'
  const expected = events?.findLast((event) => event.type === 'ask_expected')
  const started = events?.findLast((event) => event.type === 'ask_started')
  const listed = events?.findLast((event) => event.type === 'ask_listed')
  return {
    expected: status(Boolean(expected)),
    started: status(Boolean(started)),
    initialized: status(Boolean(events?.some((event) => event.type === 'ask_initialized'))),
    listed: status(Boolean(listed)),
    transport: expected?.type === 'ask_expected' ? expected.transport : null,
    command: expected?.type === 'ask_expected' ? expected.command : null,
    registered_tools: started?.type === 'ask_started' ? started.tools : null,
    listed_tools: listed?.type === 'ask_listed' ? listed.tools : null,
    failure,
  }
}
