// concern: ACP registration resume probe
/** Proves that a fresh ACP process can load a prior session and recall its conversation. */

export type ResumeProbeResult = { ok: boolean | null; output: string }

/** ACP capabilities change only after an observation; CLI declarations stay untouched. */
export function resumeCapabilityPolicy(
  transport: 'cli' | 'acp',
  observation: boolean | null | undefined,
): { resumable: boolean | null; jobSuccess: boolean } {
  const observed = transport === 'acp'
  return {
    resumable: observed && observation != null ? observation : null,
    jobSuccess: !observed || observation === true,
  }
}

type ResumeProbeTurn = (input: { prompt: string; session?: string }) => Promise<{
  status: 'ok' | 'failed' | 'asking'
  output: string
  sessionId: string | null
  loadSessionAdvertised: boolean
}>

export async function probeAgentResumes(
  transport: 'cli' | 'acp',
  token: string,
  runTurn: ResumeProbeTurn,
): Promise<ResumeProbeResult> {
  if (transport !== 'acp') {
    return { ok: null, output: 'skipped: CLI transport never receives the resume check' }
  }
  const first = await runTurn({
    prompt: `Remember this exact token for the next turn: ${token}. Reply with exactly: remembered`,
  })
  if (!first.loadSessionAdvertised) {
    return { ok: false, output: 'ACP initialize did not advertise loadSession' }
  }
  if (first.status !== 'ok' || !first.sessionId) {
    return { ok: false, output: first.output || 'ACP first session did not return a session id' }
  }
  const resumed = await runTurn({
    session: first.sessionId,
    prompt: 'Reply with exactly the token I asked you to remember in the prior turn.',
  })
  return {
    ok: resumed.status === 'ok' && resumed.output.includes(token),
    output: resumed.output,
  }
}
