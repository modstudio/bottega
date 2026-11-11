import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export const MCP_SERVER_STALE_EXIT = 75
export const MCP_SERVER_RESTART_BACKOFF_MS = 250
export const MCP_SERVER_CRASH_LOOP_CEILING = 5
export const MCP_SERVER_CRASH_LOOP_WINDOW_MS = 30_000
export const MCP_SERVER_SHUTDOWN_WAIT_MS = 2_000
export const MCP_SUPERVISOR_ID_PREFIX = 'bottega-mcp-supervisor:'

export type JsonRpcId = string | number | null
export type JsonRpcMessage = Record<string, unknown>
export type McpSupervisorSignal = 'SIGINT' | 'SIGTERM'

type SupervisorPhase =
  | 'running'
  | 'waiting-restart'
  | 'replaying'
  | 'failed'
  | 'shutting-down'
  | 'stopped'

export type McpSupervisorState = {
  phase: SupervisorPhase
  initialize: JsonRpcMessage | null
  initialized: JsonRpcMessage | null
  inFlight: JsonRpcId[]
  buffered: JsonRpcMessage[]
  recentExits: number[]
  lastExitStatus: string | null
  replayId: string | null
  replaySequence: number
  timerSequence: number
}

export type McpSupervisorEvent =
  | { type: 'client-message'; message: JsonRpcMessage }
  | { type: 'child-message'; message: JsonRpcMessage }
  | { type: 'child-exit'; code: number; status: string; at: number }
  | { type: 'timer'; kind: 'restart' | 'shutdown'; token: number }
  | { type: 'client-close' }
  | { type: 'signal'; signal: McpSupervisorSignal }

export type McpSupervisorAction =
  | { type: 'send-child'; message: JsonRpcMessage }
  | { type: 'send-client'; message: JsonRpcMessage }
  | { type: 'start-child' }
  | { type: 'close-child-input' }
  | { type: 'signal-child'; signal: McpSupervisorSignal }
  | { type: 'schedule'; kind: 'restart' | 'shutdown'; delayMs: number; token: number }
  | { type: 'exit'; code: number }

export type McpSupervisorTransition = {
  state: McpSupervisorState
  actions: McpSupervisorAction[]
}

export function initialMcpSupervisorState(): McpSupervisorState {
  return {
    phase: 'running',
    initialize: null,
    initialized: null,
    inFlight: [],
    buffered: [],
    recentExits: [],
    lastExitStatus: null,
    replayId: null,
    replaySequence: 0,
    timerSequence: 0,
  }
}

const isRequest = (message: JsonRpcMessage): message is JsonRpcMessage & { id: JsonRpcId } =>
  typeof message.method === 'string' &&
  Object.hasOwn(message, 'id') &&
  (typeof message.id === 'string' || typeof message.id === 'number' || message.id === null)

const isResponse = (message: JsonRpcMessage): message is JsonRpcMessage & { id: JsonRpcId } =>
  typeof message.method !== 'string' &&
  Object.hasOwn(message, 'id') &&
  (typeof message.id === 'string' || typeof message.id === 'number' || message.id === null)

const isInitialize = (message: JsonRpcMessage) =>
  message.method === 'initialize' && isRequest(message)
const isInitialized = (message: JsonRpcMessage) =>
  message.method === 'notifications/initialized' && !Object.hasOwn(message, 'id')

const sameId = (left: JsonRpcId, right: JsonRpcId) => typeof left === typeof right && left === right

function rememberHandshake(state: McpSupervisorState, message: JsonRpcMessage): McpSupervisorState {
  if (isInitialize(message) && !state.initialize) return { ...state, initialize: message }
  if (isInitialized(message) && !state.initialized) return { ...state, initialized: message }
  return state
}

function trackRequest(state: McpSupervisorState, message: JsonRpcMessage): McpSupervisorState {
  if (!isRequest(message)) return state
  return { ...state, inFlight: [...state.inFlight, message.id] }
}

function forgetResponse(state: McpSupervisorState, message: JsonRpcMessage): McpSupervisorState {
  if (!isResponse(message)) return state
  return {
    ...state,
    inFlight: state.inFlight.filter((id) => !sameId(id, message.id)),
  }
}

const jsonRpcError = (id: JsonRpcId, message: string): JsonRpcMessage => ({
  jsonrpc: '2.0',
  id,
  error: { code: -32000, message },
})

const restartError = (id: JsonRpcId) =>
  jsonRpcError(id, 'Bottega MCP server restarted; this call may be retried.')

const crashLoopError = (id: JsonRpcId, status: string | null) =>
  jsonRpcError(
    id,
    `Bottega MCP server stopped after a crash loop (last child ${status ?? 'status unknown'}); run ${PLATFORM_SLUG} machine doctor, then reconnect the server in the harness.`,
  )

const toolsChangedNotification = (): JsonRpcMessage => ({
  jsonrpc: '2.0',
  method: 'notifications/tools/list_changed',
})

function uniqueReplayId(state: McpSupervisorState): { id: string; sequence: number } {
  let sequence = state.replaySequence + 1
  let id = `${MCP_SUPERVISOR_ID_PREFIX}${sequence}`
  while (state.inFlight.some((candidate) => candidate === id)) {
    sequence += 1
    id = `${MCP_SUPERVISOR_ID_PREFIX}${sequence}`
  }
  return { id, sequence }
}

function sendBuffered(state: McpSupervisorState): McpSupervisorTransition {
  let next = { ...state, phase: 'running' as const, replayId: null, buffered: [] }
  const actions: McpSupervisorAction[] = []
  for (const message of state.buffered) {
    next = trackRequest(next, message)
    actions.push({ type: 'send-child', message })
  }
  actions.push({ type: 'send-client', message: toolsChangedNotification() })
  return { state: next, actions }
}

function startReplacement(state: McpSupervisorState): McpSupervisorTransition {
  const actions: McpSupervisorAction[] = [{ type: 'start-child' }]
  if (!state.initialize) {
    const forwarded = sendBuffered(state)
    return { state: forwarded.state, actions: [...actions, ...forwarded.actions] }
  }
  const replay = uniqueReplayId(state)
  actions.push({ type: 'send-child', message: { ...state.initialize, id: replay.id } })
  return {
    state: {
      ...state,
      phase: 'replaying',
      replayId: replay.id,
      replaySequence: replay.sequence,
    },
    actions,
  }
}

function clientMessage(
  state: McpSupervisorState,
  message: JsonRpcMessage,
): McpSupervisorTransition {
  const next = rememberHandshake(state, message)
  if (next.phase === 'failed') {
    return {
      state: next,
      actions: isRequest(message)
        ? [{ type: 'send-client', message: crashLoopError(message.id, next.lastExitStatus) }]
        : [],
    }
  }
  if (next.phase === 'waiting-restart' || next.phase === 'replaying') {
    const firstHandshakeMessage =
      (isInitialize(message) && state.initialize === null) ||
      (isInitialized(message) && state.initialized === null)
    return {
      state: firstHandshakeMessage ? next : { ...next, buffered: [...next.buffered, message] },
      actions: [],
    }
  }
  if (next.phase !== 'running') return { state: next, actions: [] }
  return {
    state: trackRequest(next, message),
    actions: [{ type: 'send-child', message }],
  }
}

function childMessage(state: McpSupervisorState, message: JsonRpcMessage): McpSupervisorTransition {
  if (state.phase === 'replaying' && isResponse(message) && message.id === state.replayId) {
    const replayed = sendBuffered(state)
    return {
      state: replayed.state,
      actions: [
        ...(state.initialized ? [{ type: 'send-child' as const, message: state.initialized }] : []),
        ...replayed.actions,
      ],
    }
  }
  if (state.phase !== 'running' && state.phase !== 'replaying') return { state, actions: [] }
  return {
    state: forgetResponse(state, message),
    actions: [{ type: 'send-client', message }],
  }
}

function childExit(
  state: McpSupervisorState,
  event: Extract<McpSupervisorEvent, { type: 'child-exit' }>,
): McpSupervisorTransition {
  if (state.phase === 'shutting-down') {
    return { state: { ...state, phase: 'stopped' }, actions: [{ type: 'exit', code: 0 }] }
  }
  if (state.phase === 'stopped' || state.phase === 'failed') return { state, actions: [] }

  const actions: McpSupervisorAction[] = state.inFlight.map((id) => ({
    type: 'send-client',
    message: restartError(id),
  }))
  const recentExits = [
    ...state.recentExits.filter((at) => at >= event.at - MCP_SERVER_CRASH_LOOP_WINDOW_MS),
    event.at,
  ]
  const exited = {
    ...state,
    inFlight: [],
    recentExits,
    lastExitStatus: event.status,
    replayId: null,
  }
  if (recentExits.length > MCP_SERVER_CRASH_LOOP_CEILING) {
    return { state: { ...exited, phase: 'failed' }, actions }
  }
  if (event.code === MCP_SERVER_STALE_EXIT) {
    const restarted = startReplacement(exited)
    return { state: restarted.state, actions: [...actions, ...restarted.actions] }
  }
  const token = state.timerSequence + 1
  return {
    state: { ...exited, phase: 'waiting-restart', timerSequence: token },
    actions: [
      ...actions,
      { type: 'schedule', kind: 'restart', delayMs: MCP_SERVER_RESTART_BACKOFF_MS, token },
    ],
  }
}

function timer(
  state: McpSupervisorState,
  event: Extract<McpSupervisorEvent, { type: 'timer' }>,
): McpSupervisorTransition {
  if (event.token !== state.timerSequence) return { state, actions: [] }
  if (event.kind === 'restart' && state.phase === 'waiting-restart') return startReplacement(state)
  if (event.kind === 'shutdown' && state.phase === 'shutting-down') {
    return {
      state: { ...state, phase: 'stopped' },
      actions: [
        { type: 'signal-child', signal: 'SIGTERM' },
        { type: 'exit', code: 0 },
      ],
    }
  }
  return { state, actions: [] }
}

export function reduceMcpSupervisor(
  state: McpSupervisorState,
  event: McpSupervisorEvent,
): McpSupervisorTransition {
  if (event.type === 'client-message') return clientMessage(state, event.message)
  if (event.type === 'child-message') return childMessage(state, event.message)
  if (event.type === 'child-exit') return childExit(state, event)
  if (event.type === 'timer') return timer(state, event)
  if (event.type === 'signal') {
    return {
      state: { ...state, phase: 'stopped' },
      actions: [
        { type: 'signal-child', signal: event.signal },
        { type: 'exit', code: event.signal === 'SIGINT' ? 130 : 143 },
      ],
    }
  }
  if (state.phase === 'failed') {
    return { state: { ...state, phase: 'stopped' }, actions: [{ type: 'exit', code: 0 }] }
  }
  const token = state.timerSequence + 1
  return {
    state: { ...state, phase: 'shutting-down', timerSequence: token },
    actions: [
      { type: 'close-child-input' },
      { type: 'schedule', kind: 'shutdown', delayMs: MCP_SERVER_SHUTDOWN_WAIT_MS, token },
    ],
  }
}

export class JsonLineDecoder {
  private buffered = ''

  push(chunk: string): JsonRpcMessage[] {
    this.buffered += chunk
    const lines = this.buffered.split('\n')
    this.buffered = lines.pop() ?? ''
    return lines.flatMap((line) => {
      const trimmed = line.trim()
      if (!trimmed) return []
      try {
        const parsed = JSON.parse(trimmed)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? [parsed as JsonRpcMessage]
          : []
      } catch {
        return []
      }
    })
  }
}
