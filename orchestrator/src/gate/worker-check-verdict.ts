// concern: worker reply check evidence

import {
  GATE_FAILURES_MARKER,
  parseFailingLegTailHeading,
  parseGateFailureFooterLine,
} from '../../../shared/check-execution.ts'

export type WorkerCheckFailure = {
  leg: string
  tail: readonly string[]
}

export type WorkerCheckCandidate = {
  recordId: string
  number: number
  headCommit: string | null
  treeId: string | null
  requestedAt: string
  exitCode: number | null
  timedOut: boolean | null
  failures: readonly WorkerCheckFailure[]
}

export type WorkerCheckVerdict =
  | { kind: 'none'; replyHead: string | null }
  | { kind: 'passed'; replyHead: string; number: number }
  | {
      kind: 'failed'
      replyHead: string
      number: number
      failures: readonly WorkerCheckFailure[]
    }

/** Decide the recorded worker-check verdict for the commit the worker replied from. */
export function decideWorkerCheckVerdict(
  replyHead: string | null,
  replyTree: string | null,
  latest: WorkerCheckCandidate | null,
): WorkerCheckVerdict {
  if (!replyHead) return { kind: 'none', replyHead }
  const matchesReply =
    latest !== null &&
    (latest.headCommit === replyHead || (replyTree !== null && latest.treeId === replyTree))
  if (!latest || !matchesReply) return { kind: 'none', replyHead }
  return latest.exitCode === 0 && latest.timedOut === false
    ? { kind: 'passed', replyHead, number: latest.number }
    : {
        kind: 'failed',
        replyHead,
        number: latest.number,
        failures: latest.failures,
      }
}

function shortSha(commit: string): string {
  return commit.slice(0, 12)
}

function failureNames(verdict: Extract<WorkerCheckVerdict, { kind: 'failed' }>): string {
  return verdict.failures.map((failure) => failure.leg).join(', ') || 'unknown failure'
}

/** Render the recorded verdict before any worker-authored narrative. */
export function workerCheckVerdictLine(verdict: WorkerCheckVerdict): string {
  if (verdict.kind === 'none') return 'worker check: none at this HEAD'
  if (verdict.kind === 'passed')
    return `worker check: passed at ${shortSha(verdict.replyHead)} (gate ${verdict.number})`
  return (
    `worker check: FAILED at ${shortSha(verdict.replyHead)} (gate ${verdict.number}): ` +
    failureNames(verdict)
  )
}

/** Render contract refusal text only for a failed recorded check at the reply HEAD. */
export function workerCheckRefusalText(verdict: WorkerCheckVerdict): string | null {
  if (verdict.kind !== 'failed') return null
  const details = verdict.failures.flatMap((failure) => [
    `${failure.leg}:`,
    ...failure.tail.map((line) => `  ${line}`),
  ])
  return [
    `${workerCheckVerdictLine(verdict)}. A done reply is refused because its recorded worker check failed.`,
    ...details,
    'The reply cannot be done until the worker check passes at this HEAD, or the worker stops and asks.',
  ].join('\n')
}

/** Recover the recorded footer detail for known failing legs without interpreting prose. */
function recordedLegTail(lines: readonly string[], leg: string): string[] {
  const marker = lines.findLastIndex((line) => parseFailingLegTailHeading(line)?.leg === leg)
  if (marker < 0) return []
  const tail: string[] = []
  for (const line of lines.slice(marker + 1)) {
    if (!line.startsWith(`[${leg}] `)) break
    tail.push(line)
  }
  return tail
}

function addFooterTails(lines: readonly string[], failures: Map<string, string[]>): void {
  const footer = lines.findLastIndex((line) => line.trim() === GATE_FAILURES_MARKER)
  let current: string | null = null
  for (const line of footer < 0 ? [] : lines.slice(footer + 1)) {
    const parsed = parseGateFailureFooterLine(line)
    if (parsed?.kind === 'leg' && failures.has(parsed.value)) {
      current = parsed.value
      continue
    }
    if (!current || parsed?.kind !== 'detail') {
      if (current) break
      continue
    }
    if (failures.get(current)!.length === 0) failures.get(current)!.push(parsed.value)
  }
}

export function workerCheckFailures(
  output: string,
  failingLegs: readonly string[],
): WorkerCheckFailure[] {
  const lines = output.split('\n')
  const failures = new Map(failingLegs.map((leg) => [leg, recordedLegTail(lines, leg)]))
  addFooterTails(lines, failures)
  return failingLegs.map((leg) => ({ leg, tail: failures.get(leg)! }))
}
