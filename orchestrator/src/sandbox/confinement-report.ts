// concern: confinement-report
/**
 * Pure measurement of what a worker shape can reach. Calls the same sandbox,
 * child-env, worker-home, and resolver decisions dispatch uses. Must not probe
 * homes, sockets, or secret values.
 */
import { type CodexSandboxRuling, decideCodexSandbox } from './codex-sandbox.ts'
import {
  RECORD_CONNECTION_ENV_NAMES,
  recordConnectionResolverRefusal,
  withheldClassNamesForwardedFrom,
} from './record-connection-env.ts'
import {
  isReadonlySandboxCandidate,
  READONLY_LENS_ALLOW_LOCAL_BINDING,
  READONLY_LENS_DENY_PATHS,
  type RunSandbox,
  selectReadonlySandboxKind,
  workerHomeLinksEnvFile,
} from './sandbox.ts'

const CONFINEMENT_JOB_KINDS = ['reading', 'writing'] as const
export type ConfinementJobKind = (typeof CONFINEMENT_JOB_KINDS)[number]
export type ConfinementSandbox = RunSandbox | CodexSandboxRuling['sandbox']

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

type NamedSecretAccess = {
  recordConnection: ConfinementAccess
  other: ConfinementAccess
}

type ConfinementReportRefusedRow = {
  agent: string
  job: ConfinementJobKind
  mcp: boolean
  status: 'refused'
  refusal: string
}

type ConfinementReportOkRow = {
  agent: string
  job: ConfinementJobKind
  mcp: boolean
  status: 'ok'
  refusal: null
  confinement: { sandbox: ConfinementSandbox; reason: string }
  withheldForwarded: string[]
  envFile: ConfinementAccess
  keychain: ConfinementAccess
  namedSecret: NamedSecretAccess
  loopback: ConfinementAccess
}

export type ConfinementReportRow = ConfinementReportRefusedRow | ConfinementReportOkRow

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
const CODEX_NO_READ_DENIAL = 'orch passes codex no read denial'

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
    return 'writing jobs are not readonly-sandbox candidates'
  }
  return OPEN
}

function envFileAccess(
  outerSandbox: RunSandbox,
  harness: string,
  agent: string,
): ConfinementAccess {
  if (agent === 'codex') return { access: 'open', reason: CODEX_NO_READ_DENIAL }
  const linksEnvFile = workerHomeLinksEnvFile(harness)
  if (outerSandbox === 'srt' && READONLY_LENS_DENY_PATHS.includes('~/.claude/.env')) {
    return {
      access: 'denied',
      reason: linksEnvFile
        ? 'srt denyRead includes the operator env file; the worker-home link resolves to it'
        : 'srt denyRead includes the operator env file',
    }
  }
  if (linksEnvFile) {
    return { access: 'open', reason: `${OPEN}; worker HOME links the operator env file` }
  }
  return { access: 'open', reason: OPEN }
}

function keychainAccess(outerSandbox: RunSandbox, agent: string): ConfinementAccess {
  if (agent === 'codex') return { access: 'open', reason: CODEX_NO_READ_DENIAL }
  if (outerSandbox === 'host') return { access: 'open', reason: OPEN }
  if (READONLY_LENS_DENY_PATHS.some((path) => path.includes('login.keychain'))) {
    return { access: 'denied', reason: 'srt denyRead includes the login keychain' }
  }
  return { access: 'open', reason: OPEN }
}

function codexLoopbackAccess(): ConfinementAccess {
  const ruling = decideCodexSandbox()
  if (ruling.workspaceWriteNetworkAccess) {
    return { access: 'open', reason: 'codex workspace-write network_access' }
  }
  return { access: 'denied', reason: 'codex workspace-write has network_access off' }
}

function loopbackAccess(outerSandbox: RunSandbox, agent: string): ConfinementAccess {
  if (agent === 'codex') return codexLoopbackAccess()
  if (outerSandbox === 'host') return { access: 'open', reason: OPEN }
  return {
    access: READONLY_LENS_ALLOW_LOCAL_BINDING ? 'open' : 'denied',
    reason: READONLY_LENS_ALLOW_LOCAL_BINDING
      ? `${OPEN}; srt allowLocalBinding`
      : 'srt does not allow local binding',
  }
}

function namedSecretAccess(): NamedSecretAccess {
  const reason = [...RECORD_CONNECTION_ENV_NAMES]
    .sort()
    .map((name) => recordConnectionResolverRefusal(name, true))
    .filter((refusal): refusal is string => refusal !== null)
    .join('; ')
  return {
    recordConnection: { access: 'denied', reason },
    other: { access: 'open', reason: OPEN },
  }
}

function okConfinement(
  agent: ConfinementReportAgent,
  writesRepo: boolean,
  kind: { sandbox: RunSandbox; reason: string | null },
): ConfinementReportOkRow['confinement'] {
  if (agent.name === 'codex') {
    const ruling = decideCodexSandbox()
    return { sandbox: ruling.sandbox, reason: 'codex native sandbox' }
  }
  return { sandbox: kind.sandbox, reason: confinementReason(agent.name, writesRepo, kind) }
}

function reportRow(
  agent: ConfinementReportAgent,
  job: ConfinementJobKind,
  mcp: boolean,
  parentEnvNames: readonly string[],
  sandboxOverride: string | undefined,
): ConfinementReportRow {
  const refusal = shapeRefusal(agent, job, mcp)
  if (refusal) {
    return { agent: agent.name, job, mcp, status: 'refused', refusal }
  }
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
  const outer = kind.sandbox
  return {
    agent: agent.name,
    job,
    mcp,
    status: 'ok',
    refusal: null,
    confinement: okConfinement(agent, writesRepo, kind),
    withheldForwarded: withheldClassNamesForwardedFrom(parentEnvNames),
    envFile: envFileAccess(outer, agent.harness, agent.name),
    keychain: keychainAccess(outer, agent.name),
    namedSecret: namedSecretAccess(),
    loopback: loopbackAccess(outer, agent.name),
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

function namedSecretLine(named: NamedSecretAccess): string {
  return (
    `  ${'named-secret'.padEnd(12)} ` +
    `record-connection ${named.recordConnection.access}: ${named.recordConnection.reason}; ` +
    `other named secrets ${named.other.access}: ${named.other.reason}`
  )
}

function withheldWarningLine(names: readonly string[]): string {
  return `  ${'warning'.padEnd(12)} withheld-class forwarded: ${names.join(', ')}`
}

function rowHeading(row: ConfinementReportRow): string {
  const mcp = row.mcp ? 'yes' : 'no'
  if (row.status === 'refused')
    return `${row.agent}  ${row.job}  mcp=${mcp}  refused  ${row.refusal}`
  return `${row.agent}  ${row.job}  mcp=${mcp}  ${row.confinement.sandbox}  ${row.confinement.reason}`
}

function okRowLines(row: ConfinementReportOkRow): string[] {
  return [
    rowHeading(row),
    ...(row.withheldForwarded.length ? [withheldWarningLine(row.withheldForwarded)] : []),
    accessLine('env-file', row.envFile),
    accessLine('keychain', row.keychain),
    namedSecretLine(row.namedSecret),
    accessLine('loopback', row.loopback),
  ]
}

export function formatConfinementReport(
  rows: readonly ConfinementReportRow[],
  json: boolean,
): string[] {
  if (json) return [JSON.stringify(rows)]
  return rows.flatMap((row, index) => {
    const block = row.status === 'refused' ? [rowHeading(row)] : okRowLines(row)
    return index === 0 ? block : ['', ...block]
  })
}
