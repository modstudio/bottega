// concern: agent-commands
/** Owns agent registry mutations and catalogue presentation. Must not know CLI grammar. */
import { db } from './db.ts'
import { AGENTS, addAgent, agentRows, available, ensureLocalHealth, installed, probeAgent, removeAgent, setAgent, unavailableReason } from './agents.ts'
import { flagValue } from './args.ts'

type Presentation = { log(value: string): void; setExitCode(code: number): void }
const parseJobs = (value: string | undefined) => value === undefined ? undefined : value === 'any' ? null : value.split(',').map((entry) => entry.trim())

function mutation(argv: string[]) {
  const flag = (name: string) => flagValue(argv, name); const enabled = flag('enabled')
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') throw new Error('--enabled must be true or false')
  const context = flag('context-tokens'), jobs = flag('jobs'), prefer = flag('prefer'), maxConcurrent = flag('max-concurrent')
  return {
    ...(flag('harness') ? { harness: flag('harness') as any } : {}), ...(flag('backend') ? { backend: flag('backend') as any } : {}),
    ...(flag('model') ? { model: flag('model')! } : {}), ...(flag('base-url') ? { baseUrl: flag('base-url')! } : {}),
    ...(context ? { contextTokens: Number(context) } : {}), ...(enabled !== undefined ? { enabled: enabled === 'true' } : {}),
    ...(flag('reason') !== undefined ? { reason: flag('reason')! } : {}), ...(jobs !== undefined ? { jobs: parseJobs(jobs) } : {}),
    ...(prefer !== undefined ? { preferredJobs: parseJobs(prefer) ?? [] } : {}), ...(maxConcurrent !== undefined ? { maxConcurrent: Number(maxConcurrent) } : {}),
  }
}

export async function agentCommand(argv: string[], presentation: Presentation): Promise<void> {
  const sub = argv[1], name = argv[2]
  if (sub === 'add') return addCommand(name!, argv, presentation)
  if (sub === 'set') { presentation.log(JSON.stringify(setAgent(name!, mutation(argv)))); return }
  if (sub === 'remove') { removeAgent(name!); presentation.log(`removed ${name}`); return }
  if (sub === 'probe') return probeCommand(name!, presentation)
  if (sub === 'show') return showCommand(name!, presentation)
  if (sub === 'list') listCommand(argv.includes('--json'), presentation)
}

function addCommand(name: string, argv: string[], presentation: Presentation): void {
  const input = mutation(argv)
  if (!input.model) { const configured = process.env.ORCH_LOCAL_MODEL?.trim(); if (!configured) throw new Error('agent add requires --model or ORCH_LOCAL_MODEL\ncleared by: pass --model or set ORCH_LOCAL_MODEL'); input.model = configured }
  presentation.log(JSON.stringify(addAgent(name, input)))
}

async function probeCommand(name: string, presentation: Presentation): Promise<void> { const result = await probeAgent(name); presentation.log(JSON.stringify(result, null, 2)); if (!result.ok) presentation.setExitCode(1) }

function showCommand(name: string, presentation: Presentation): void {
  const row = agentRows().find((candidate) => candidate.name === name); if (!row) throw new Error(`unknown agent "${name}"`)
  const judged = db().query('SELECT job, COUNT(*) AS count FROM run r JOIN score s ON s.run_id=r.id WHERE r.agent=? GROUP BY job ORDER BY job').all(name) as { job: string; count: number }[]
  presentation.log(JSON.stringify({ ...row, caps: JSON.parse(row.caps), probeResult: row.probe_result ? JSON.parse(row.probe_result) : null, judged }, null, 2))
}

function listedRow(row: ReturnType<typeof agentRows>[number]) {
  const caps = JSON.parse(row.caps), probe = row.probe_result ? JSON.parse(row.probe_result) : null
  const eligibility = probe?.ok === false ? 'ineligible: registration probe failed' : !Object.hasOwn(caps, 'contextTokens') ? 'ineligible: no declared or probed context window' : !row.probed_at ? 'inline only: unprobed and ineligible for repository jobs' : row.enabled ? 'eligible by registration' : `ineligible: disabled — ${row.disabled_reason}`
  return { name: row.name, harness: row.harness, backend: row.backend, model: row.model, baseUrl: row.base_url, transport: row.transport, caps, billing: row.billing, enabled: Boolean(row.enabled), disabledReason: row.disabled_reason, jobs: row.jobs ? JSON.parse(row.jobs) : null, preferredJobs: row.preferred_jobs ? JSON.parse(row.preferred_jobs) : [], maxConcurrent: row.max_concurrent, probedAt: row.probed_at, probeResult: probe, legacy: !['codex', 'grok', 'opencode', 'goose', 'claude-code'].includes(row.harness), limitation: row.name === 'local-acp' && Number(caps.contextTokens ?? 0) < 147_456 ? 'understand requires the endpoint served at 147456 tokens or more' : null, eligibility }
}

function listCommand(json: boolean, presentation: Presentation): void {
  const rows = agentRows().map(listedRow)
  if (json) presentation.log(JSON.stringify(rows)); else for (const row of rows) presentation.log(`${row.name.padEnd(12)} ${row.enabled ? 'enabled ' : 'disabled'} ${row.harness}/${row.backend ?? '-'} ${row.model}${row.legacy ? ' [legacy]' : ''} — ${row.eligibility}; jobs ${row.jobs?.join(',') ?? 'any'}; prefer ${row.preferredJobs.join(',') || '-'}; cap ${row.maxConcurrent ?? 'none'}${row.limitation ? `; ${row.limitation}` : ''}`)
}

export async function agentsCommand(json: boolean, presentation: Presentation): Promise<void> {
  await ensureLocalHealth()
  if (json) { presentation.log(JSON.stringify(Object.values(AGENTS).map((agent) => ({ name: agent.name, caps: agent.caps, model: agent.model, contextTokens: Number.isFinite(agent.contextTokens) ? agent.contextTokens : null, maxPromptBytes: Number.isFinite(agent.maxPromptBytes) ? agent.maxPromptBytes : null, timeoutMs: agent.timeoutMs })))); return }
  for (const agent of Object.values(AGENTS)) presentation.log(`${agent.name.padEnd(7)} ${available(agent.name) ? 'installed' : 'MISSING  '} ${agent.billing.padEnd(13)}${unavailableReason(agent.name) ? ` [${unavailableReason(agent.name)}]` : ''} repo=${agent.caps.readsRepo ? 'y' : 'n'} mcp=${agent.caps.mcp ? 'y' : 'n'} schema=${agent.caps.schema ? 'y' : 'n'}  ${agent.notes}`)
  presentation.log(`\ninstalled: ${installed().join(', ') || 'none'}`)
}
