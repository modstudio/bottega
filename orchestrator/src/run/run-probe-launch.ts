import { GOOSE_CONTEXT_CEILING } from '../agent/agent-registry.ts'
import type { Agent } from '../agent/agents.ts'
import {
  decideProbeLaunchOverrides,
  probeContextLimitEnvironment,
  readerPromptFindings,
} from '../dispatch/probe-launch-overrides.ts'
import type { Job } from '../jobs/jobs.ts'
import type { RunOptions } from './run-options.ts'

export function prepareRunProbeLaunch(agent: Agent, opts: RunOptions, requestedJob: Job) {
  const decision = decideProbeLaunchOverrides({
    probe: Boolean(opts.probe),
    contextLimit: opts.probeContextLimit,
    readerSuites: Boolean(opts.probeReaderSuites),
    agentHarness: agent.harness ?? agent.name,
    findings: Boolean(requestedJob.findings),
  })
  if (!decision.accepted) return { refusal: decision.refusal, environment: {} }
  return {
    refusal: null,
    environment: probeContextLimitEnvironment(opts.probeContextLimit, agent.servedContextTokens),
  }
}

export function probeReaderFindings(opts: RunOptions, requestedJob: Job): boolean {
  return readerPromptFindings(Boolean(requestedJob.findings), Boolean(opts.probeReaderSuites))
}

export function reportProbeOverrides(
  runId: string,
  environment: Record<string, string>,
  readerSuites: boolean,
): void {
  const lines = [
    ...(environment.GOOSE_CONTEXT_LIMIT
      ? [
          `orch: run ${runId} probe override GOOSE_CONTEXT_LIMIT=${environment.GOOSE_CONTEXT_LIMIT} (ceiling ${GOOSE_CONTEXT_CEILING} bypassed)`,
        ]
      : []),
    ...(readerSuites ? [`orch: run ${runId} probe override reader-suites wording`] : []),
  ]
  for (const line of lines) console.error(line)
}
