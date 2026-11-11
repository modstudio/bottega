import { startParentBound } from '../../../shared/bounded-process.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import {
  initialMcpSupervisorState,
  JsonLineDecoder,
  type JsonRpcMessage,
  type McpSupervisorAction,
  type McpSupervisorEvent,
  reduceMcpSupervisor,
} from './mcp-supervisor-decision.ts'

const line = (message: JsonRpcMessage) => `${JSON.stringify(message)}\n`

export async function serveMcpSupervisor(): Promise<void> {
  let state = initialMcpSupervisorState()
  let child: ReturnType<typeof spawnChild> | null = null
  let resolveDone: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const dispatch = (event: McpSupervisorEvent) => {
    const transition = reduceMcpSupervisor(state, event)
    state = transition.state
    for (const action of transition.actions) apply(action)
  }

  const spawnChild = () => {
    const process = startParentBound(bottegaEntryArgv('mcp-serve-child'), {
      name: 'MCP server child',
    })
    const stdout = relayChildStdout(process.stdout, dispatch)
    const stderr = relayChildStderr(process.stderr)
    void (async () => {
      const code = await process.exited
      await Promise.all([stdout, stderr])
      if (child === process) child = null
      dispatch({ type: 'child-exit', code, status: `exit status ${code}`, at: Date.now() })
    })()
    return process
  }

  const apply = (action: McpSupervisorAction) => {
    if (action.type === 'start-child') {
      try {
        child = spawnChild()
      } catch (error) {
        console.error(`could not start the MCP server child: ${String(error)}`)
        dispatch({ type: 'child-exit', code: 1, status: 'spawn failure', at: Date.now() })
      }
      return
    }
    if (action.type === 'send-child') {
      child?.stdin.write(line(action.message))
      child?.stdin.flush()
      return
    }
    if (action.type === 'send-client') {
      process.stdout.write(line(action.message))
      return
    }
    if (action.type === 'close-child-input') {
      child?.stdin.end()
      return
    }
    if (action.type === 'signal-child') {
      child?.kill(action.signal)
      return
    }
    if (action.type === 'schedule') {
      setTimeout(
        () => dispatch({ type: 'timer', kind: action.kind, token: action.token }),
        action.delayMs,
      )
      return
    }
    process.exitCode = action.code
    resolveDone?.()
  }

  child = spawnChild()
  const clientLines = new JsonLineDecoder()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    for (const message of clientLines.push(chunk)) {
      dispatch({ type: 'client-message', message })
    }
  })
  process.stdin.once('end', () => dispatch({ type: 'client-close' }))
  process.stdin.resume()
  await done
}

async function relayChildStdout(
  stream: ReadableStream<Uint8Array>,
  dispatch: (event: McpSupervisorEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  const lines = new JsonLineDecoder()
  for await (const chunk of stream) {
    for (const message of lines.push(decoder.decode(chunk, { stream: true }))) {
      dispatch({ type: 'child-message', message })
    }
  }
  const final = decoder.decode()
  for (const message of lines.push(final)) dispatch({ type: 'child-message', message })
}

async function relayChildStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const chunk of stream) process.stderr.write(chunk)
}
