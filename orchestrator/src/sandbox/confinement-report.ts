// concern: confinement-report
/**
 * Pure measurement of what a worker shape can reach. Calls the same sandbox,
 * child-env, worker-home, and resolver decisions dispatch uses. Must not probe
 * homes, sockets, or secret values.
 */
import {
  recordConnectionResolverRefusal,
  withheldClassNamesForwardedFrom,
} from './record-connection-env.ts'
import {
  isReadonlySandboxCandidate,
  READONLY_LENS_ALLOW_LOCAL_BINDING,
  READONLY_LENS_DENY_PATHS,
  selectReadonlySandboxKind,
  workerHomeLinksEnvFile,
} from './sandbox.ts'

const CONFINEMENT_JOB_KINDS = ['reading', 'writing'] as const
export type ConfinementJobKind = (typeof CONFINEMENT_JOB_KINDS)[number]

export type ConfinementReportAgent = {
  name: string
  harness: string
  enabled: boolean
  readsRepo: boolean
  writesRepo: boolean
  mcp: boolean
}

type ConfinementAccess = {
  access: 'open' | 'denied'
  reason: string
}

export type ConfinementReportRow = {
  agent: string
  job: ConfinementJobKind
  mcp: boolean
  status: 'ok' | 'refused'
  refusal: string | null
  confinement: { sandbox: 'host' | 'srt'; reason: string }
  withheldForwarded: string[]
  envFile: ConfinementAccess
  keychain: ConfinementAccess
  namedSecret: ConfinementAccess
  loopback: ConfinementAccess
}

export type ConfinementReportInput = {
  agents: readonly ConfinementReportAgent[]
  parentEnvNames: readonly string[]
  sandboxOverride?: string
  agent?: string
  job?: ConfinementJobKind
  mcp?: boolean
}

const OPEN = 'orch has no denial'
const JOB_KINDS: readonly ConfinementJobKind[] = CONFINEMENT_JOB_KINDS
const MCP_VALUES = [false, true] as const

export function confinementJobKindFromNeeds(needs: {
  readsRepo?: boolean
  writesRepo?: boolean
}): ConfinementJobKind | null {
  if (needs.writesRepo) return 'writing'
  if (needs.readsRepo) return 'reading'
  return null
}

export function parseConfinementJobSelector(
  value: string | undefined,
  jobs: Readonly<Record<string, { needs: { readsRepo?: boolean; writesRepo?: boolean } }>>,
): ConfinementJobKind | undefined {
  if (value === undefined) return undefined
  if (value === 'reading' || value === 'writing') return value
  const selected = jobs[value]
  if (!selected) throw new Error(`unknown job "${value}"`)
  const kind = confinementJobKindFromNeeds(selected.needs)
  if (!kind) throw new Error(`${value} is not a reading or writing repository job`)
  return kind
}

export function parseConfinementMcpSelector(
  present: boolean,
  value: string | undefined,
): boolean | undefined {
  if (!present) return undefined
  if (value === undefined) return true
  if (value === 'true' || value === 'yes') return true
  if (value === 'false' || value === 'no') return false
  throw new Error(`--mcp must be true or false; received ${JSON.stringify(value)}`)
}

function selectedAgents(
  agents: readonly ConfinementReportAgent[],
  name: string | undefined,
): ConfinementReportAgent[] {
  if (name === undefined) return agents.filter((agent) => agent.enabled && agent.readsRepo)
  const found = agents.find((agent) => agent.name === name)
  if (!found) throw new Error(`unknown agent "${name}"`)
  return [found]
}

function shapeRefusal(
  agent: ConfinementReportAgent,
  job: ConfinementJobKind,
  mcp: boolean,
): string | null {
  if (!agent.enabled) return 'agent is disabled'
  if (!agent.readsRepo) return 'not repository-capable'
  if (job === 'writing' && !agent.writesRepo) return 'lacks writesRepo'
  if (mcp && !agent.mcp) return 'lacks mcp'
  return null
}

function confinementReason(
  agent: string,
  writesRepo: boolean,
  kind: { sandbox: 'host' | 'srt'; reason: string | null },
): string {
  if (kind.reason) return kind.reason
  if (kind.sandbox === 'srt') return 'readonly sandbox candidate'
  if (!isReadonlySandboxCandidate({ agent, readsRepo: true, writesRepo })) {
    return agent === 'codex'
      ? 'codex is not a readonly-sandbox candidate'
      : 'writing jobs are not readonly-sandbox candidates'
  }
  return OPEN
}

function envFileAccess(sandbox: 'host' | 'srt', harness: string): ConfinementAccess {
  if (workerHomeLinksEnvFile(harness)) {
    return { access: 'open', reason: `${OPEN}; worker HOME links the operator env file` }
  }
  if (sandbox === 'host') return { access: 'open', reason: OPEN }
  if (READONLY_LENS_DENY_PATHS.includes('~/.claude/.env')) {
    return { access: 'denied', reason: 'srt denyRead includes the operator env file' }
  }
  return { access: 'open', reason: OPEN }
}

function keychainAccess(sandbox: 'host' | 'srt'): ConfinementAccess {
  if (sandbox === 'host') return { access: 'open', reason: OPEN }
  if (READONLY_LENS_DENY_PATHS.some((path) => path.includes('login.keychain'))) {
    return { access: 'denied', reason: 'srt denyRead includes the login keychain' }
  }
  return { access: 'open', reason: OPEN }
}

function loopbackAccess(sandbox: 'host' | 'srt'): ConfinementAccess {
  if (sandbox === 'host') return { access: 'open', reason: OPEN }
  return {
    access: READONLY_LENS_ALLOW_LOCAL_BINDING ? 'open' : 'denied',
    reason: READONLY_LENS_ALLOW_LOCAL_BINDING
      ? `${OPEN}; srt allowLocalBinding`
      : 'srt does not allow local binding',
  }
}

function namedSecretAccess(): ConfinementAccess {
  const withheld = recordConnectionResolverRefusal('ORCH_RECORD_URL', true)
  return {
    access: 'open',
    reason: `${OPEN}; ${withheld}`,
  }
}

function reportRow(
  agent: ConfinementReportAgent,
  job: ConfinementJobKind,
  mcp: boolean,
  parentEnvNames: readonly string[],
  sandboxOverride: string | undefined,
): ConfinementReportRow {
  const writesRepo = job === 'writing'
  const kind = selectReadonlySandboxKind({
    agent: agent.name,
    readsRepo: true,
    writesRepo,
    worktreePresent: true,
    projectPresent: true,
    override: sandboxOverride,
    mcp,
  })
  const sandbox = kind.sandbox
  const refusal = shapeRefusal(agent, job, mcp)
  return {
    agent: agent.name,
    job,
    mcp,
    status: refusal ? 'refused' : 'ok',
    refusal,
    confinement: { sandbox, reason: confinementReason(agent.name, writesRepo, kind) },
    withheldForwarded: withheldClassNamesForwardedFrom(parentEnvNames),
    envFile: envFileAccess(sandbox, agent.harness),
    keychain: keychainAccess(sandbox),
    namedSecret: namedSecretAccess(),
    loopback: loopbackAccess(sandbox),
  }
}

export function reportConfinement(input: ConfinementReportInput): ConfinementReportRow[] {
  const agents = selectedAgents(input.agents, input.agent)
  const jobs = input.job ? [input.job] : JOB_KINDS
  const mcpValues = input.mcp === undefined ? MCP_VALUES : ([input.mcp] as const)
  const rows: ConfinementReportRow[] = []
  for (const agent of agents) {
    for (const job of jobs) {
      for (const mcp of mcpValues) {
        rows.push(reportRow(agent, job, mcp, input.parentEnvNames, input.sandboxOverride))
      }
    }
  }
  return rows
}

function accessLine(label: string, channel: ConfinementAccess): string {
  return `  ${label.padEnd(12)} ${channel.access}: ${channel.reason}`
}

function rowHeading(row: ConfinementReportRow): string {
  const mcp = row.mcp ? 'yes' : 'no'
  if (row.status === 'refused')
    return `${row.agent}  ${row.job}  mcp=${mcp}  refused  ${row.refusal}`
  const withheld = row.withheldForwarded.length ? row.withheldForwarded.join(', ') : '(none)'
  return `${row.agent}  ${row.job}  mcp=${mcp}  ${row.confinement.sandbox}  ${row.confinement.reason}  withheld: ${withheld}`
}

export function formatConfinementReport(
  rows: readonly ConfinementReportRow[],
  json: boolean,
): string[] {
  if (json) return [JSON.stringify(rows)]
  return rows.flatMap((row, index) => {
    const block = [
      rowHeading(row),
      accessLine('env-file', row.envFile),
      accessLine('keychain', row.keychain),
      accessLine('named-secret', row.namedSecret),
      accessLine('loopback', row.loopback),
    ]
    return index === 0 ? block : ['', ...block]
  })
}
