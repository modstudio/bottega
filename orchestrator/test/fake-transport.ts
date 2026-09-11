import {
  installTestTransport, type AgentTransport, type NormalizedEvent,
  type TransportHandle, type TransportResult, type TransportStartOpts,
} from '../src/transport.ts'

export type ScriptedTransportEvent =
  | { kind: 'started'; pid?: number | null; session?: string | null }
  | { kind: 'stdout'; chunk: string }
  | { kind: 'stderr'; chunk: string }
  | { kind: 'checkpoint'; reply: string }
  | { kind: 'ask'; question: string; why: string }
  | { kind: 'resume'; ruling?: string }
  | { kind: 'completed'; output?: string; exitCode?: number; stopReason?: string | null }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason: string }

export type ScriptedTransport = {
  transport: AgentTransport
  prompts: string[]
  events: ScriptedTransportEvent[]
  install(): void
  injectRuling(ruling: string): void
}

const result = (state: {
  stdout: string; stderr: string; output: string; session: string | null
  pid: number | null
  exitCode: number; stopReason: string | null; error: string | null
  events: NormalizedEvent[]; cancelled: boolean
}): TransportResult => ({
  stdout: state.stdout,
  stderr: state.stderr,
  raw: state.stdout + state.stderr,
  parsed: {
    text: state.output, tokens: null, costUsd: null,
    stopReason: state.stopReason, error: state.error ?? undefined,
  },
  output: state.output,
  tokens: null,
  costUsd: null,
  sessionId: state.session,
  stopReason: state.stopReason,
  error: state.error,
  exitCode: state.exitCode,
  pid: state.pid,
  events: state.events,
  asking: false,
  failureKind: null,
  status: state.error || state.exitCode !== 0 || state.cancelled ? 'failed' : 'ok',
  questions: [],
})

type ScriptState = {
  cancelled: boolean
  pid: number | null
  session: string | null
  stdout: string
  stderr: string
  output: string
  exitCode: number
  stopReason: string | null
  error: string | null
}

async function applyEvent(
  event: ScriptedTransportEvent,
  state: ScriptState,
  emit: (event: NormalizedEvent) => void,
  waitForRuling: () => Promise<string>,
  seen: ScriptedTransportEvent[],
  prompts: string[],
): Promise<void> {
  if (event.kind === 'started') {
    state.pid = event.pid ?? state.pid
    state.session = event.session ?? state.session
    if (event.session) emit({ kind: 'session', sessionId: event.session })
  } else if (event.kind === 'stdout') {
    state.stdout += event.chunk
    emit({ kind: 'text', text: event.chunk })
  } else if (event.kind === 'stderr') state.stderr += event.chunk
  else if (event.kind === 'checkpoint') emit({ kind: 'text', text: event.reply })
  else if (event.kind === 'ask') {
    emit({ kind: 'elicitation', message: event.question })
    seen.push({ kind: 'resume', ruling: await waitForRuling() })
  } else if (event.kind === 'resume') {
    if (event.ruling !== undefined) prompts.push(event.ruling)
  } else if (event.kind === 'completed') {
    state.output = event.output ?? state.stdout
    state.exitCode = event.exitCode ?? 0
    state.stopReason = event.stopReason ?? 'end_turn'
  } else if (event.kind === 'failed') {
    state.error = event.error
    state.exitCode = 1
    state.stopReason = null
    emit({ kind: 'error', error: event.error })
  } else if (event.kind === 'cancelled') {
    state.cancelled = true
    state.error = event.reason
    state.exitCode = 1
    state.stopReason = 'cancelled'
  }
}

/** Deterministic, spawn-free AgentTransport driven by a declared event script. */
export function scriptedTransport(script: ScriptedTransportEvent[]): ScriptedTransport {
  const prompts: string[] = []
  const seen: ScriptedTransportEvent[] = []
  let ruling: ((value: string) => void) | null = null
  let queuedRuling: string | null = null

  const waitForRuling = (): Promise<string> => {
    if (queuedRuling !== null) {
      const value = queuedRuling
      queuedRuling = null
      return Promise.resolve(value)
    }
    return new Promise((resolve) => { ruling = resolve })
  }

  const handleFor = (opts: TransportStartOpts): TransportHandle => {
    const normalized: NormalizedEvent[] = []
    let eventsDone = false
    let eventWake: (() => void) | null = null
    const emit = (event: NormalizedEvent) => { normalized.push(event); eventWake?.(); eventWake = null }
    const state: ScriptState = {
      cancelled: false, pid: 0, session: opts.session ?? null, stdout: '', stderr: '',
      output: '', exitCode: 0, stopReason: 'end_turn', error: null,
    }
    const collected = (async () => {
      for (const event of script) {
        seen.push(event)
        await applyEvent(event, state, emit, waitForRuling, seen, prompts)
      }
      eventsDone = true
      const wake = eventWake as (() => void) | null
      if (wake) wake()
      eventWake = null
      return result({ ...state, events: normalized })
    })()
    return {
      get pid() { return state.pid },
      kill() { state.cancelled = true; if (ruling) { const resume = ruling; ruling = null; resume('') } },
      async prompt(text) { prompts.push(text) },
      async *events() {
        let index = 0
        while (!eventsDone || index < normalized.length) {
          if (index < normalized.length) yield normalized[index++]!
          else await new Promise<void>((resolve) => { eventWake = resolve })
        }
      },
      async cancel() { state.cancelled = true; if (ruling) { const resume = ruling; ruling = null; resume('') } },
      collect: () => collected,
    }
  }

  const transport: AgentTransport = {
    name: 'cli',
    async start(opts) { prompts.push(opts.prompt); return handleFor(opts) },
    prompt(handle, text) { return handle.prompt(text) },
    events(handle) { return handle.events() },
    cancel(handle) { return handle.cancel() },
    async resume(opts) { prompts.push(opts.prompt); return handleFor(opts) },
  }
  return {
    transport, prompts, events: seen,
    install() { installTestTransport(transport) },
    injectRuling(value) {
      if (ruling) { const resolve = ruling; ruling = null; resolve(value) }
      else queuedRuling = value
    },
  }
}
