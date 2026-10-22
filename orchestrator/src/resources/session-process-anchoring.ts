// concern: session process anchoring
/** Owns process ancestry facts and stable session anchors derived from repeated CLI observations. */

export type ProcessTreeSample = {
  pid: number
  ppid: number
  cpu: number
  command: string
  startTime: string
}
export type ProcessIdentity = Pick<ProcessTreeSample, 'pid' | 'startTime'>
export type SessionProcessChain = { sessionId: string; chain: ProcessIdentity[] }

/** Keep the ancestors shared by both observations, ordered nearest the CLI to PID 1. */
export function commonAncestorChain(
  previous: readonly ProcessIdentity[],
  observed: readonly ProcessIdentity[],
): ProcessIdentity[] {
  let previousIndex = previous.length - 1
  let observedIndex = observed.length - 1
  while (
    previousIndex >= 0 &&
    observedIndex >= 0 &&
    previous[previousIndex]!.pid === observed[observedIndex]!.pid &&
    previous[previousIndex]!.startTime === observed[observedIndex]!.startTime
  ) {
    previousIndex--
    observedIndex--
  }
  return observed.slice(observedIndex + 1)
}

/** Continue a stable harness chain, or restart ownership when the session has moved. */
export function nextSessionAncestorChain(
  previous: readonly ProcessIdentity[] | null,
  observed: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const previousAnchor = previous?.[0]
  if (
    !previousAnchor ||
    previousAnchor.pid === 1 ||
    !observed.some(
      (identity) =>
        identity.pid === previousAnchor.pid && identity.startTime === previousAnchor.startTime,
    )
  )
    return [...observed]
  return commonAncestorChain(previous, observed)
}

/** Parse one persisted chain without allowing corrupt ownership evidence to escape as an exception. */
export function parseStoredAncestorChain(
  sessionId: string,
  value: string | null,
): { chain: ProcessIdentity[] | null; error: string | null } {
  if (value === null) return { chain: null, error: null }
  try {
    const parsed = JSON.parse(value) as unknown
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (identity) =>
          typeof identity === 'object' &&
          identity !== null &&
          Number.isInteger((identity as ProcessIdentity).pid) &&
          typeof (identity as ProcessIdentity).startTime === 'string',
      )
    )
      return { chain: parsed as ProcessIdentity[], error: null }
  } catch {
    // Report the same bounded error for malformed JSON and invalid decoded values.
  }
  return {
    chain: null,
    error: `session ${sessionId} has an invalid stored ancestor_chain`,
  }
}

/** The nearest non-init ancestor, unless another live session also contains that identity. */
export function sessionAnchors(chains: SessionProcessChain[]): Map<string, ProcessIdentity> {
  const appearances = new Map<string, Set<string>>()
  for (const { sessionId, chain } of chains)
    for (const identity of chain) {
      const key = `${identity.pid}\0${identity.startTime}`
      const sessions = appearances.get(key) ?? new Set<string>()
      sessions.add(sessionId)
      appearances.set(key, sessions)
    }
  const anchors = new Map<string, ProcessIdentity>()
  for (const { sessionId, chain } of chains) {
    const anchor = chain[0]
    const key = anchor ? `${anchor.pid}\0${anchor.startTime}` : ''
    if (anchor && anchor.pid !== 1 && appearances.get(key)?.size === 1)
      anchors.set(sessionId, anchor)
  }
  return anchors
}

export function processDescendsFrom(
  pid: number,
  ancestor: number,
  parents: ReadonlyMap<number, number>,
): boolean {
  const visited = new Set<number>()
  for (let current = pid; current > 0 && !visited.has(current); ) {
    if (current === ancestor) return true
    visited.add(current)
    current = parents.get(current) ?? 0
  }
  return false
}

export function ancestorChain(pid: number, processes: readonly ProcessTreeSample[]): number[] {
  const parents = new Map(processes.map((process) => [process.pid, process.ppid]))
  const chain: number[] = []
  const visited = new Set<number>()
  let current = parents.get(pid)
  while (current !== undefined && current > 0 && !visited.has(current)) {
    chain.push(current)
    if (current === 1) break
    visited.add(current)
    current = parents.get(current)
  }
  return chain
}

export function ancestorIdentityChain(
  pid: number,
  processes: readonly ProcessTreeSample[],
): ProcessIdentity[] {
  const identities = new Map(
    processes.map((process) => [process.pid, { pid: process.pid, startTime: process.startTime }]),
  )
  return ancestorChain(pid, processes).flatMap((ancestorPid) => {
    const identity = identities.get(ancestorPid)
    return identity ? [identity] : []
  })
}
