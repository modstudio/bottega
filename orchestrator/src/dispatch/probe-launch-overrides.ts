export type ProbeContextLimit = number | 'served'

type ProbeLaunchOverrideDecision =
  | { accepted: false; refusal: string }
  | {
      accepted: true
      contextLimit: ProbeContextLimit | undefined
      readerSuites: boolean
    }

function parsedContextLimit(value: string | ProbeContextLimit): ProbeContextLimit | null {
  const raw = String(value)
  if (raw === 'served') return raw
  if (/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw)
  return null
}

export function acceptedProbeReaderSuites(input: {
  probe: boolean
  readerSuites: boolean
  findings: boolean
}): boolean {
  return input.probe && input.readerSuites && input.findings
}

/** Decides every probe-only launch override refusal at the dispatch edge. */
export function decideProbeLaunchOverrides(input: {
  probe: boolean
  contextLimit: string | ProbeContextLimit | undefined
  readerSuites: boolean
  agentHarness: string | null
  findings: boolean
}): ProbeLaunchOverrideDecision {
  if (!input.probe && input.contextLimit !== undefined) {
    return {
      accepted: false,
      refusal: '--probe-context-limit is a probe-only override; add --probe or drop it',
    }
  }
  if (!input.probe && input.readerSuites) {
    return {
      accepted: false,
      refusal: '--probe-reader-suites is a probe-only override; add --probe or drop it',
    }
  }

  const readerSuites = acceptedProbeReaderSuites(input)

  let contextLimit: ProbeContextLimit | undefined
  if (input.contextLimit !== undefined) {
    const parsed = parsedContextLimit(input.contextLimit)
    if (parsed === null) {
      return {
        accepted: false,
        refusal: '--probe-context-limit must be a positive integer token count or served',
      }
    }
    contextLimit = parsed
    if (input.agentHarness === null) {
      return {
        accepted: false,
        refusal: '--probe-context-limit requires --agent pinned to a Goose harness',
      }
    }
    if (input.agentHarness !== 'goose') {
      return {
        accepted: false,
        refusal: `--probe-context-limit requires the goose harness; selected harness is ${input.agentHarness}`,
      }
    }
  }
  if (input.readerSuites && !readerSuites) {
    return {
      accepted: false,
      refusal: '--probe-reader-suites requires a findings job; choose a findings job or drop it',
    }
  }
  return { accepted: true, contextLimit, readerSuites }
}

export function readerPromptFindings(findings: boolean, readerSuites: boolean): boolean {
  return findings && !readerSuites
}

export function probeContextLimitEnvironment(
  override: ProbeContextLimit | undefined,
  servedWindow: number | null | undefined,
): Record<string, string> {
  if (override === undefined) return {}
  if (override === 'served') {
    if (servedWindow === null || servedWindow === undefined || !Number.isFinite(servedWindow)) {
      throw new Error(
        '--probe-context-limit served requires the selected Goose agent to declare its served window',
      )
    }
    return { GOOSE_CONTEXT_LIMIT: String(servedWindow) }
  }
  return { GOOSE_CONTEXT_LIMIT: String(override) }
}
