// concern: process-tree identity
/** Pure process ancestry and session-anchor decisions. */

export type ProcessSample = { pid: number; ppid: number; cpu: number; command: string }
export type SessionProcessChain = { sessionId: string; chain: number[] }

/** The highest ancestor unique to one live session is its harness-independent anchor. */
export function sessionAnchors(chains: SessionProcessChain[]): Map<string, number> {
  const appearances = new Map<number, Set<string>>()
  for (const { sessionId, chain } of chains)
    for (const pid of new Set(chain)) {
      const sessions = appearances.get(pid) ?? new Set<string>()
      sessions.add(sessionId)
      appearances.set(pid, sessions)
    }
  const anchors = new Map<string, number>()
  for (const { sessionId, chain } of chains) {
    const anchor = [...chain].reverse().find((pid) => appearances.get(pid)?.size === 1)
    if (anchor !== undefined) anchors.set(sessionId, anchor)
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

export function parseProcessTable(output: string): ProcessSample[] {
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line)
    if (!match) return []
    const pid = Number(match[1]),
      ppid = Number(match[2]),
      cpu = Number(match[3])
    return Number.isFinite(cpu) && pid > 0 && ppid >= 0
      ? [{ pid, ppid, cpu, command: match[4]!.trim() }]
      : []
  })
}

export function ancestorChain(pid: number, processes: ProcessSample[]): number[] {
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
