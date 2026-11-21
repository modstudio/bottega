// concern: worker reply check evidence

export type WorkerCheckFailure = {
  leg: string
  tail: readonly string[]
}

export type WorkerCheckCandidate = {
  recordId: string
  number: number
  headCommit: string | null
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

function newerWorkerCheck(
  current: WorkerCheckCandidate | null,
  candidate: WorkerCheckCandidate,
): WorkerCheckCandidate {
  if (!current) return candidate
  const requestedOrder = candidate.requestedAt.localeCompare(current.requestedAt)
  return requestedOrder > 0 ||
    (requestedOrder === 0 && candidate.recordId.localeCompare(current.recordId) > 0)
    ? candidate
    : current
}

/** Decide the recorded worker-check verdict for the commit the worker replied from. */
export function decideWorkerCheckVerdict(
  replyHead: string | null,
  candidates: readonly WorkerCheckCandidate[],
): WorkerCheckVerdict {
  if (!replyHead) return { kind: 'none', replyHead }
  const latest = candidates
    .filter((candidate) => candidate.headCommit === replyHead)
    .reduce<WorkerCheckCandidate | null>(newerWorkerCheck, null)
  if (!latest) return { kind: 'none', replyHead }
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

/** Refuse only a done reply contradicted by a failed recorded check at the same HEAD. */
export function workerCheckDoneRefusal(
  replyStatus: 'done' | 'asking' | 'refused' | null,
  verdict: WorkerCheckVerdict,
): string | null {
  if (replyStatus !== 'done' || verdict.kind !== 'failed') return null
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
export function workerCheckFailures(
  output: string,
  failingLegs: readonly string[],
): WorkerCheckFailure[] {
  const failures = new Map(failingLegs.map((leg) => [leg, [] as string[]]))
  const lines = output.split('\n')
  for (const leg of failingLegs) {
    const marker = lines.findLastIndex((line) =>
      line.startsWith(`[${leg}] failing leg tail (exit `),
    )
    if (marker < 0) continue
    const tail: string[] = []
    for (const line of lines.slice(marker + 1)) {
      if (!line.startsWith(`[${leg}] `)) break
      tail.push(line)
    }
    failures.set(leg, tail)
  }
  const footer = lines.findLastIndex((line) => line.trim() === 'gate failures:')
  let current: string | null = null
  for (const line of footer < 0 ? [] : lines.slice(footer + 1)) {
    if (failures.has(line)) {
      current = line
      continue
    }
    if (!current || !line.startsWith('  ')) {
      if (current) break
      continue
    }
    if (failures.get(current)!.length === 0) failures.get(current)!.push(line.slice(2))
  }
  return failingLegs.map((leg) => ({ leg, tail: failures.get(leg)! }))
}
