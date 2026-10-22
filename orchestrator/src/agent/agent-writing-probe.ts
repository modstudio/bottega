// concern: ACP registration writing probe
/** Owns the disposable writing check. Must not know registry persistence or CLI grammar. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { observedCapabilityPolicy } from './agent-capability-probe-policy.ts'
import {
  type CapabilityProbeConfinement,
  type CapabilityProbeSandboxInput,
  type CapabilityProbeSandboxPorts,
  capabilityProbeSandboxPorts,
  withCapabilityProbeSandbox,
} from './agent-capability-probe-sandbox.ts'

const WRITING_PROBE_FILE = 'registration-probe-write.txt'
const WRITING_PROBE_CONTENT = 'REGISTRATION_PROBE_WRITE_OK\n'

export type WritingProbeResult = { ok: boolean | null; output: string }

type WritingProbeLaunch = {
  cwd: string
  prompt: string
  profile: CapabilityProbeConfinement['profile']
}
export type WritingProbeConfinement = CapabilityProbeConfinement

type WritingProbeAgentCall = (
  input: WritingProbeLaunch,
) => Promise<{ status: 'ok' | 'failed' | 'asking'; output: string }>

export type WritingProbePorts = CapabilityProbeSandboxPorts & {
  callAgent: WritingProbeAgentCall
}

/** One owner for whether and how a transport establishes repository-writing capability. */
export function writingCapabilityPolicy(
  transport: 'cli' | 'acp',
  observation: boolean | null | undefined,
): { requiresObservation: boolean; writesRepo: boolean | null; jobSuccess: boolean } {
  const policy = observedCapabilityPolicy(transport, observation)
  return {
    requiresObservation: policy.requiresObservation,
    writesRepo: policy.value,
    jobSuccess: policy.jobSuccess,
  }
}
export type WritingProbeInput = CapabilityProbeSandboxInput

/** Run one ACP writer inside the same profile and transport launch used by a writing run. */
export async function probeAgentWrites(
  input: WritingProbeInput,
  ports: WritingProbePorts,
): Promise<WritingProbeResult> {
  if (!writingCapabilityPolicy(input.transport, null).requiresObservation) {
    return { ok: null, output: 'skipped: CLI transport never receives the writing check' }
  }
  try {
    return await withCapabilityProbeSandbox(input, ports, async ({ cwd, profile }) => {
      const target = join(cwd, WRITING_PROBE_FILE)
      const outcome = await ports.callAgent({
        cwd,
        prompt: `Create ${WRITING_PROBE_FILE} with exactly this content, including the final newline:\n${WRITING_PROBE_CONTENT}`,
        profile,
      })
      const content = existsSync(target) ? readFileSync(target, 'utf8') : ''
      return {
        ok: outcome.status === 'ok' && content === WRITING_PROBE_CONTENT,
        output: outcome.output,
      }
    })
  } catch (error) {
    return { ok: false, output: String((error as Error).message ?? error) }
  }
}

export function writingProbePorts(callAgent: WritingProbeAgentCall): WritingProbePorts {
  return {
    ...capabilityProbeSandboxPorts(),
    callAgent,
  }
}
