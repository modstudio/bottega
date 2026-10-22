// concern: ACP registration resume probe
/** Proves that a fresh ACP process can load a prior session and recall its conversation. */

import { observedCapabilityPolicy } from './agent-capability-probe-policy.ts'
import {
  type CapabilityProbeConfinement,
  type CapabilityProbeSandboxInput,
  type CapabilityProbeSandboxPorts,
  withCapabilityProbeSandbox,
} from './agent-capability-probe-sandbox.ts'

export type ResumeProbeResult = { ok: boolean | null; output: string }

/** ACP capabilities change only after an observation; CLI declarations stay untouched. */
export function resumeCapabilityPolicy(
  transport: 'cli' | 'acp',
  observation: boolean | null | undefined,
): { resumable: boolean | null; jobSuccess: boolean } {
  const policy = observedCapabilityPolicy(transport, observation)
  return {
    resumable: policy.value,
    jobSuccess: policy.jobSuccess,
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

/** Run the ACP resume observation inside the same confinement lifecycle as the writing probe. */
export async function probeAgentResumesInSandbox(
  input: CapabilityProbeSandboxInput,
  ports: CapabilityProbeSandboxPorts,
  token: string,
  runTurn: (
    input: { prompt: string; session?: string },
    confinement: CapabilityProbeConfinement,
  ) => ReturnType<ResumeProbeTurn>,
): Promise<ResumeProbeResult> {
  if (!observedCapabilityPolicy(input.transport, null).requiresObservation) {
    return probeAgentResumes(input.transport, token, async () => {
      throw new Error('CLI resume probe unexpectedly ran')
    })
  }
  try {
    return await withCapabilityProbeSandbox(input, ports, (confinement) =>
      probeAgentResumes(input.transport, token, (turn) => runTurn(turn, confinement)),
    )
  } catch (error) {
    return { ok: false, output: String((error as Error).message ?? error) }
  }
}
