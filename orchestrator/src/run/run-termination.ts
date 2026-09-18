export type TerminateRunProcessesResult =
  | { outcome: 'signalled'; signalled: number[]; acceptableIds: number[] }
  | { outcome: 'identity-mismatch'; acceptableIds: number[] }
  | { outcome: 'unascertainable'; acceptableIds: number[]; reason: string }
  | { outcome: 'no-pid'; acceptableIds: number[] }
  | { outcome: 'gone'; acceptableIds: number[] }

export function commandNamesRun(command: string, acceptableIds: readonly number[]): boolean {
  return acceptableIds.some((id) =>
    new RegExp(`(?:^|[/\\s])exec\\.ts\\s+${id}(?:\\s|$)`).test(command),
  )
}

export function stoppedRunLine(
  id: number,
  pid: number | null,
  termination: TerminateRunProcessesResult,
): string {
  if (pid && termination.outcome === 'identity-mismatch') {
    const commands = termination.acceptableIds.map((runId) => `exec.ts ${runId}`).join(', ')
    return `stopped run ${id}; pid ${pid} is present but does not name this run (expected ${commands}); after checking ps -p ${pid} -o command, run kill -TERM ${pid} only if the command shows one of those ids`
  }
  if (pid && termination.outcome === 'unascertainable') {
    const commands = termination.acceptableIds.map((runId) => `exec.ts ${runId}`).join(', ')
    return `stopped run ${id}; no process could be signalled because ${termination.reason}; after checking ps -p ${pid} -o command, run kill -TERM ${pid} only if the command shows one of these ids: ${commands}`
  }
  return `stopped run ${id}`
}
