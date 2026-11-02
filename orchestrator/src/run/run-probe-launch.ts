import { GOOSE_CONTEXT_CEILING } from '../agent/agent-registry.ts'
import type { Agent } from '../agent/agents.ts'
import {
  acceptedProbeReaderSuites,
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
  if (!decision.accepted)
    return {
      refusal: decision.refusal,
      environment: {},
      contextLimit: undefined,
      readerSuites: false,
    }
  return {
    refusal: null,
    environment: probeContextLimitEnvironment(decision.contextLimit, agent.servedContextTokens),
    contextLimit: decision.contextLimit,
    readerSuites: decision.readerSuites,
  }
}

export function probeReaderFindings(opts: RunOptions, requestedJob: Job): boolean {
  const findings = Boolean(requestedJob.findings)
  const readerSuites = acceptedProbeReaderSuites({
    probe: Boolean(opts.probe),
    readerSuites: Boolean(opts.probeReaderSuites),
    findings,
  })
  return readerPromptFindings(findings, readerSuites)
}

export function reportProbeOverrides(
  runId: string,
  environment: Record<string, string>,
  readerSuites: boolean,
): void {
  const lines = [
    ...(environment.GOOSE_CONTEXT_LIMIT
      ? [
          `orch: run ${runId} probe override GOOSE_CONTEXT_LIMIT=${environment.GOOSE_CONTEXT_LIMIT} (replaces the ceilinged limit; ceiling ${GOOSE_CONTEXT_CEILING})`,
        ]
      : []),
    ...(readerSuites ? [`orch: run ${runId} probe override reader-suites wording`] : []),
  ]
  for (const line of lines) console.error(line)
}
