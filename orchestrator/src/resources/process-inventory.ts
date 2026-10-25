// concern: lifecycle process inventory
/** Gathers the process table and applies pure missing-worktree classification. */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { observeBoundedSubprocess } from '../../../shared/process-identity.ts'
import { RUN_PROCESS_MARKER_ENV } from '../issue/issue-shell.ts'

export type ProcessFact = {
  pid: number
  ppid: number
  pgid: number
  cpu: number
  command: string
  ageSeconds: number
  startTime: string
  cwd: string | null
  cwdVerified: boolean
}

export type OrphanCandidate = ProcessFact & {
  missingTree: string
  project: string
  match: 'cwd' | 'argument'
}

/** Whether a process environment proves a run started the process. */
export type RunMarkerEvidence = 'present' | 'absent' | 'unknown'
export type OrphanProcess = OrphanCandidate & { runMarker: RunMarkerEvidence }

/**
 * The delegation marker every run child inherits, and the marker a host broker
 * stamps on the children it starts for a run. Either proves a run started the
 * process; neither is present in an operator's own shell.
 */
const RUN_MARKER_ENV_NAMES = ['BOTTEGA_DEPTH', RUN_PROCESS_MARKER_ENV]
const RUN_MARKER_ENTRY = new RegExp(`^(?:${RUN_MARKER_ENV_NAMES.join('|')})=.`)
/** Any environment entry, which is the only proof an environment was printed at all. */
const ENVIRONMENT_ENTRY = /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=\S/

const PROCESS_CWD_LSOF_TIMEOUT_MS = 10_000
const PROCESS_TABLE_PS_TIMEOUT_MS = 10_000
const PROCESS_ENVIRONMENT_PS_TIMEOUT_MS = 10_000

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
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+((?:\d+-)?(?:\d+:)?\d+:\d+)\s+(.+)$/.exec(
        line,
      )
    if (!match) return []
    const ageSeconds = elapsedSeconds(match[6]!)
    const cpu = Number(match[4])
    if (ageSeconds === null || !Number.isFinite(cpu)) return []
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        cpu,
        ageSeconds,
        startTime: match[5]!,
        command: match[7]!,
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

export function processTableSnapshot(): { facts: ProcessFact[]; error: string | null } {
  try {
    const { process: ps, error } = observeBoundedSubprocess(
      'ps',
      ['ps', '-axo', 'pid=,ppid=,pgid=,%cpu=,lstart=,etime=,command='],
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
): OrphanCandidate[] {
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

/**
 * Whether an environment text carries a run marker.
 *
 * Takes either shape the platform offers: the NUL-separated environ bytes of
 * `/proc/<pid>/environ`, or the whitespace-joined environment `ps -E` prints
 * after a process's command. A name with an empty value is not a marker.
 */
export function environmentCarriesRunMarker(environment: string): boolean {
  return environment.split(/[\s\0]+/).some((entry) => RUN_MARKER_ENTRY.test(entry))
}

/**
 * Parse `ps -E` output into per-pid marker evidence.
 *
 * `ps -E` prints the environment of processes this user owns appended to the
 * command in one column, so the command the inventory already observed is
 * subtracted first: an argument that merely spells a marker name must not read
 * as ownership. A line whose command cannot be separated is unknown, because
 * nothing was read to prove a run started the process.
 *
 * Some platforms print no environment at all, which would otherwise read as
 * every candidate lacking the marker. `probePid` names a process whose
 * environment is known to be non-empty — this process, which always carries
 * PATH — so a probe line with no NAME=value entry after its command means the
 * platform cannot read environments: every candidate is unknown, not absent.
 */
export function parseProcessEnvironmentEvidence(
  output: string,
  commands: ReadonlyMap<number, string>,
  probePid: number,
): Map<number, RunMarkerEvidence> {
  const evidence = new Map<number, RunMarkerEvidence>()
  const environments = new Map<number, string>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const observed = match[2]!
    const command = commands.get(pid)
    if (!command || !observed.startsWith(command)) {
      evidence.set(pid, 'unknown')
      continue
    }
    const environment = observed.slice(command.length)
    environments.set(pid, environment)
    evidence.set(pid, environmentCarriesRunMarker(environment) ? 'present' : 'absent')
  }
  const probe = environments.get(probePid)
  if (probe === undefined || !ENVIRONMENT_ENTRY.test(probe))
    return new Map<number, RunMarkerEvidence>(
      [...new Set([...commands.keys(), probePid])].map((pid): [number, RunMarkerEvidence] => [
        pid,
        'unknown',
      ]),
    )
  return evidence
}

/** macOS prints the environment of this user's processes after their command. */
function psRunMarkerEvidence(
  candidates: readonly OrphanCandidate[],
  commands: ReadonlyMap<number, string>,
): Map<number, RunMarkerEvidence> {
  const probeCommand = commands.get(process.pid)
  if (!probeCommand) return new Map()
  const queried = new Map<number, string>(
    candidates.map(({ pid, command }) => [pid, command] as const),
  )
  queried.set(process.pid, probeCommand)
  for (const flag of ['-Eww', 'eww']) {
    try {
      const { process: found, error } = observeBoundedSubprocess(
        'ps',
        ['ps', flag, '-o', 'pid=,command=', '-p', [...queried.keys()].join(',')],
        {
          env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C' },
          stdout: 'pipe',
          stderr: 'pipe',
        },
        PROCESS_ENVIRONMENT_PS_TIMEOUT_MS,
      )
      if (!error)
        return parseProcessEnvironmentEvidence(found.stdout?.toString() ?? '', queried, process.pid)
    } catch {
      // A platform without this ps form leaves every candidate unknown.
    }
  }
  return new Map()
}

/** Linux exposes the environment of every process as one procfs file. */
function procRunMarkerEvidence(pids: readonly number[]): Map<number, RunMarkerEvidence> {
  const evidence = new Map<number, RunMarkerEvidence>()
  for (const pid of pids) {
    try {
      evidence.set(
        pid,
        environmentCarriesRunMarker(readFileSync(`/proc/${pid}/environ`, 'utf8'))
          ? 'present'
          : 'absent',
      )
    } catch {
      // Exited between snapshots, or unreadable to this user: unknown, not absent.
    }
  }
  return evidence
}

/** Read only the candidate orphans' environments, in one read per inventory. */
function processRunMarkerEvidence(
  candidates: readonly OrphanCandidate[],
  commands: ReadonlyMap<number, string>,
): Map<number, RunMarkerEvidence> {
  if (!candidates.length) return new Map()
  if (process.platform === 'darwin') return psRunMarkerEvidence(candidates, commands)
  if (process.platform === 'linux') return procRunMarkerEvidence(candidates.map(({ pid }) => pid))
  return new Map()
}

/** Attach ownership evidence; an environment that was not read stays unknown. */
export function joinRunMarker(
  candidates: readonly OrphanCandidate[],
  evidence: ReadonlyMap<number, RunMarkerEvidence>,
): OrphanProcess[] {
  return candidates.map((candidate) => ({
    ...candidate,
    runMarker: evidence.get(candidate.pid) ?? 'unknown',
  }))
}

export function currentOrphanProcesses(projects: readonly { name: string; path: string }[]) {
  const observed = observeProcesses()
  const candidates = orphanProcesses(observed.facts, projects, existsSync)
  const commands = new Map(observed.facts.map(({ pid, command }) => [pid, command] as const))
  return {
    ...observed,
    orphans: joinRunMarker(candidates, processRunMarkerEvidence(candidates, commands)),
  }
}
