// concern: secret-scan
/** Decides what a redacted gitleaks report establishes without running a process. */

type SecretScanFinding = {
  ruleId: string
  line: number
}

export type SecretScanOutcome =
  | { status: 'clean' }
  | { status: 'found'; findings: SecretScanFinding[] }
  | { status: 'unavailable'; reason: string }

export type SecretScanCapture = {
  exitCode: number | null
  report: string
  timedOut: boolean
  couldNotRun: boolean
}

const FINDINGS_EXIT_CODE = 1

function findingsFromReport(report: string): SecretScanFinding[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(report)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const findings: SecretScanFinding[] = []
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('RuleID' in entry) ||
      typeof entry.RuleID !== 'string' ||
      !entry.RuleID ||
      !('StartLine' in entry) ||
      typeof entry.StartLine !== 'number' ||
      !Number.isInteger(entry.StartLine) ||
      entry.StartLine < 1
    ) {
      return null
    }
    findings.push({ ruleId: entry.RuleID, line: entry.StartLine })
  }
  return findings
}

export function decideSecretScanOutcome(capture: SecretScanCapture): SecretScanOutcome {
  if (capture.timedOut) return { status: 'unavailable', reason: 'gitleaks timed out' }
  if (capture.couldNotRun) return { status: 'unavailable', reason: 'gitleaks could not start' }
  if (capture.exitCode !== 0 && capture.exitCode !== FINDINGS_EXIT_CODE) {
    return {
      status: 'unavailable',
      reason:
        capture.exitCode === null
          ? 'gitleaks did not report an exit code'
          : `gitleaks exited with code ${capture.exitCode}`,
    }
  }
  const findings = findingsFromReport(capture.report)
  if (findings === null) {
    return { status: 'unavailable', reason: 'gitleaks report could not be parsed' }
  }
  if (capture.exitCode === 0 && findings.length === 0) return { status: 'clean' }
  if (capture.exitCode === FINDINGS_EXIT_CODE && findings.length > 0) {
    return { status: 'found', findings }
  }
  return { status: 'unavailable', reason: 'gitleaks exit code and report disagreed' }
}
