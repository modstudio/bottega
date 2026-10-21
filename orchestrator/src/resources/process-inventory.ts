// concern: lifecycle process inventory
/** Gathers the process table and applies pure missing-worktree classification. */
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { observeBoundedSubprocess } from '../../../shared/process-identity.ts'

export type ProcessFact = {
  pid: number
  ppid: number
  pgid: number
  command: string
  ageSeconds: number
  startTime: string
  cwd: string | null
  cwdVerified: boolean
}
export type OrphanProcess = ProcessFact & {
  missingTree: string
  project: string
  match: 'cwd' | 'argument'
}

const PROCESS_CWD_LSOF_TIMEOUT_MS = 10_000
const PROCESS_TABLE_PS_TIMEOUT_MS = 10_000

function elapsedSeconds(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value)
  if (!match) return null
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3])
  const seconds = Number(match[4])
  if (minutes > 59 || seconds > 59) return null
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

/** Parse the common macOS/Linux ps fields without relying on GNU-only etimes. */
export function parseProcessTable(output: string): ProcessFact[] {
  return output.split('\n').flatMap((line): ProcessFact[] => {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+((?:\d+-)?(?:\d+:)?\d+:\d+)\s+(.+)$/.exec(
        line,
      )
    if (!match) return []
    const ageSeconds = elapsedSeconds(match[5]!)
    if (ageSeconds === null) return []
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        ageSeconds,
        startTime: match[4]!,
        command: match[6]!,
        cwd: null,
        cwdVerified: false,
      },
    ]
  })
}

function processCwds(): { values: Map<number, string>; error: string | null } {
  try {
    const { process: found, error } = observeBoundedSubprocess(
      'lsof',
      ['lsof', '-a', '-d', 'cwd', '-Fpn'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
      PROCESS_CWD_LSOF_TIMEOUT_MS,
    )
    if (error) {
      return { values: new Map(), error }
    }
    const values = new Map<number, string>()
    let pid: number | null = null
    for (const line of (found.stdout?.toString() ?? '').split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1))
      else if (pid && line.startsWith('n')) values.set(pid, line.slice(1))
    }
    return { values, error: null }
  } catch (error) {
    return { values: new Map(), error: String((error as Error).message ?? error) }
  }
}

function processTableSnapshot(): { facts: ProcessFact[]; error: string | null } {
  try {
    const { process: ps, error } = observeBoundedSubprocess(
      'ps',
      ['ps', '-axo', 'pid=,ppid=,pgid=,lstart=,etime=,command='],
      {
        env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
      PROCESS_TABLE_PS_TIMEOUT_MS,
    )
    if (error) return { facts: [], error }
    return {
      facts: parseProcessTable(ps.stdout?.toString() ?? ''),
      error: null,
    }
  } catch (error) {
    return { facts: [], error: String((error as Error).message ?? error) }
  }
}

/** Preserve cwd evidence, but mark it safe to act on only when both snapshots agree on birth. */
export function joinProcessCwd(
  cwd: string | null,
  snapshottedStartTime: string,
  observedStartTime: string | null,
): Pick<ProcessFact, 'cwd' | 'cwdVerified'> {
  return { cwd, cwdVerified: cwd !== null && observedStartTime === snapshottedStartTime }
}

function observeProcesses(): { facts: ProcessFact[]; error: string | null } {
  const before = processTableSnapshot()
  if (before.error) return before
  const cwds = processCwds()
  if (cwds.error) return { facts: before.facts, error: cwds.error }
  const after = processTableSnapshot()
  const births = new Map(after.facts.map((fact) => [fact.pid, fact.startTime]))
  return {
    facts: before.facts.map((fact) => ({
      ...fact,
      ...joinProcessCwd(
        cwds.values.get(fact.pid) ?? null,
        fact.startTime,
        births.get(fact.pid) ?? null,
      ),
    })),
    error: after.error,
  }
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function absoluteArgumentPaths(command: string): string[] {
  return command.split(/\s+/).flatMap((argument) => {
    const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argument
    const unquoted = value.replace(/^["']|["',;]$/g, '')
    return isAbsolute(unquoted) ? [unquoted] : []
  })
}

export function orphanProcesses(
  facts: readonly ProcessFact[],
  projects: readonly { name: string; path: string }[],
  pathExists: (path: string) => boolean,
): OrphanProcess[] {
  return facts.flatMap((fact) => {
    const candidates = [
      ...(fact.cwd ? [{ path: fact.cwd, match: 'cwd' as const }] : []),
      ...absoluteArgumentPaths(fact.command).map((path) => ({ path, match: 'argument' as const })),
    ]
    for (const project of projects) {
      const root = resolve(project.path, '.claude', 'worktrees')
      for (const candidate of candidates) {
        if (!inside(root, candidate.path)) continue
        const name = relative(root, candidate.path).split(sep)[0]
        if (!name) continue
        const tree = resolve(root, name)
        if (!pathExists(tree))
          return [
            {
              ...fact,
              startTime: fact.startTime,
              missingTree: tree,
              project: project.name,
              match: candidate.match,
            },
          ]
      }
    }
    return []
  })
}

export function currentOrphanProcesses(projects: readonly { name: string; path: string }[]) {
  const observed = observeProcesses()
  return { ...observed, orphans: orphanProcesses(observed.facts, projects, existsSync) }
}
