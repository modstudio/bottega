// concern: doctor
/** Knows local agent auth probes. Must not know routing, dispatch, or run outcomes. */

export type AgentAuthCapture = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  error: string | null
}

export type AgentAuthResult = {
  status: 'signed-out' | 'ready' | 'unknown'
  detail: string
}

type AgentAuthStrategy = {
  command: readonly string[]
  classify(capture: AgentAuthCapture): AgentAuthResult
}

type AuthSpawn = (
  argv: string[],
  options: { stdout: 'pipe'; stderr: 'pipe'; timeout: number },
) => {
  exitCode: number | null
  stdout: Uint8Array
  stderr: Uint8Array
  exitedDueToTimeout?: boolean
}

const STORED_LOGIN_DETAIL = 'stored login found; not verified with the server'
const AUTH_CHECK_TIMEOUT_MS = 3_000

const strategies: Readonly<Record<string, AgentAuthStrategy>> = {
  codex: {
    command: ['login', 'status'],
    classify: ({ exitCode }) => {
      if (exitCode === 0) return { status: 'ready', detail: STORED_LOGIN_DETAIL }
      if (exitCode === 1) return { status: 'signed-out', detail: 'not logged in' }
      return { status: 'unknown', detail: 'auth check returned an unrecognized exit code' }
    },
  },
  grok: {
    command: ['models'],
    classify: ({ stdout }) => {
      const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim() ?? ''
      if (firstLine === 'You are not authenticated.') {
        return { status: 'signed-out', detail: 'not authenticated' }
      }
      if (firstLine === 'You are logged in with grok.com.') {
        return { status: 'ready', detail: STORED_LOGIN_DETAIL }
      }
      return { status: 'unknown', detail: 'auth check output was not recognized' }
    },
  },
}

export function classifyAgentAuth(agent: string, capture: AgentAuthCapture): AgentAuthResult {
  if (capture.timedOut) return { status: 'unknown', detail: 'auth check timed out' }
  if (capture.error) return { status: 'unknown', detail: 'auth check could not run' }
  return (
    strategies[agent]?.classify(capture) ?? {
      status: 'unknown',
      detail: 'no auth check is available',
    }
  )
}

const spawnAuth: AuthSpawn = (argv, options) => {
  const child = Bun.spawnSync(argv, options)
  return {
    exitCode: child.exitCode,
    stdout: child.stdout,
    stderr: child.stderr,
    exitedDueToTimeout: child.exitedDueToTimeout,
  }
}

export function runAgentAuthCheck(
  agent: string,
  bin: string,
  spawn: AuthSpawn = spawnAuth,
): AgentAuthResult | null {
  const strategy = strategies[agent]
  if (!strategy) return null
  let capture: AgentAuthCapture
  try {
    const child = spawn([bin, ...strategy.command], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: AUTH_CHECK_TIMEOUT_MS,
    })
    capture = {
      exitCode: child.exitCode,
      stdout: agent === 'grok' ? firstOutputLine(child.stdout) : '',
      stderr: '',
      timedOut: child.exitedDueToTimeout === true,
      error: null,
    }
  } catch (error) {
    capture = {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  return classifyAgentAuth(agent, capture)
}

function firstOutputLine(output: Uint8Array): string {
  const newline = output.indexOf(10)
  return new TextDecoder().decode(newline === -1 ? output : output.subarray(0, newline))
}

export function doctorAgentStatus(
  agent: string,
  unavailable: string | null,
  bin: string,
  check: typeof runAgentAuthCheck = runAgentAuthCheck,
): { status: 'absent' | 'signed-out' | 'ready' | 'unknown'; detail: string } {
  if (unavailable) return { status: 'absent', detail: unavailable }
  return check(agent, bin) ?? { status: 'ready', detail: '' }
}
