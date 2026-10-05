// concern: model-host
/** Owns model-host wake, health, reachability, and availability. Must not know probes or CLI grammar. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { which } from 'bun'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { concernStateDirectory } from '../../../shared/state-directory.ts'
import { AGENTS, type AgentRow } from './agent-registry.ts'
import type { Agent } from './agents.ts'

/** Where the model host's OpenAI-compatible endpoint lives. */
export function modelHostUrl(): string {
  return readMachineValue('model_host.url')
}

export function modelHostModel(): string {
  return readMachineValue('model_host.model')
}

export function registeredLocalAgent(rows: AgentRow[], baseUrl: string): AgentRow | null {
  const registered = rows.filter(
    (row) => Boolean(row.enabled) && row.transport === 'acp' && row.operated_by === 'self',
  )
  if (baseUrl) return registered.find((row) => row.base_url === baseUrl) ?? null
  return registered.length === 1 ? registered[0]! : null
}

export function registeredContextTokens(row: AgentRow): number | null {
  const value = (JSON.parse(row.caps) as { contextTokens?: unknown }).contextTokens
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/**
 * What the last reachability probe found, or null if none has run yet.
 *
 * Process-local and deliberately not persisted. A cached verdict on disk would
 * be a second source of truth about a thing that changes without warning — the
 * box comes back and the file still says it is down — and `orch` processes are
 * short-lived enough that one probe each is cheap: 2ms when the endpoint is
 * healthy, and when it is not, it replaces a run that was going to fail anyway.
 */
export type LocalHealth = { ok: boolean; detail: string; contextTokens?: number }

let modelHostHealth: LocalHealth | null = null
const agentHealth = new Map<string, { baseUrl: string | null; health: LocalHealth }>()

/**
 * MAC address to wake the model host at, or empty to never try.
 *
 * OPT-IN, and deliberately so. Powering on a remote host is an operator
 * decision. Whoever sets this is saying "wake it when work needs it"; unset,
 * nothing here ever sends a packet.
 *
 * It is configuration rather than a code dependency, which is what keeps the
 * contract with local-stack the same shape it always was: an endpoint and some
 * environment, never an import.
 */
const modelHostWolMac = (): string => readMachineValue('model_host.wol_mac')

/**
 * How long to leave the box alone after sending a magic packet.
 *
 * A second packet during boot cannot make the model load faster; it can only
 * turn one wake into a stream of packets. Leave enough time for the host and
 * model server to start.
 */
const WAKE_COOLDOWN_MS = 10 * 60_000

const wakeStampPath = () => join(concernStateDirectory('orchestrator', process.env), '.last-wake')

export function lastWakeAttempt(): Date | null {
  try {
    const d = new Date(readFileSync(wakeStampPath(), 'utf8').trim())
    return Number.isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

/**
 * Whether to send a magic packet, decided from facts alone.
 *
 * Pure, and separate from the sending, so the four cases are pinned by tests
 * rather than by powering a machine off to see what happens — which is the only
 * way the real thing can be exercised.
 */
function wakeDecision(o: { mac: string; haveBinary: boolean; last: Date | null; now: number }): {
  send: boolean
  detail: string
} {
  if (!o.mac) return { send: false, detail: 'ORCH_MODEL_HOST_WOL_MAC not set — waking is opt-in' }
  if (!o.haveBinary) {
    return { send: false, detail: 'wakeonlan not installed (brew install wakeonlan)' }
  }
  if (o.last) {
    const ago = o.now - o.last.getTime()
    if (ago < WAKE_COOLDOWN_MS) {
      return {
        send: false,
        detail: `woken ${Math.round(ago / 60_000)}m ago; a cold start takes ~6m, so waiting`,
      }
    }
  }
  return { send: true, detail: `magic packet to ${o.mac}` }
}

/**
 * The decision, with today's facts gathered, and nothing sent.
 *
 * One gatherer for both callers. Written because the alternative — doctor
 * assembling its own arguments to wakeDecision — immediately produced a wrong
 * one, and a status line that reports something other than what will happen is
 * the whole class of bug this codebase keeps finding.
 */
export function wakeStatus(now = Date.now()): { send: boolean; detail: string } {
  return wakeDecision({
    mac: modelHostWolMac(),
    haveBinary: which('wakeonlan', { PATH: process.env.PATH }) !== null,
    last: lastWakeAttempt(),
    now,
  })
}

/**
 * Send one magic packet, if that is the right thing to do.
 *
 * Fire and forget. A cold start is 5m42s and no caller can wait that long, so
 * this never blocks and never reports success at waking — only at asking. The
 * job in hand still routes elsewhere; the next one, minutes later, finds the
 * endpoint up on its own.
 */
export function tryWake(now = Date.now()): { sent: boolean; detail: string } {
  const d = wakeStatus(now)
  if (!d.send) return { sent: false, detail: d.detail }
  // Stamped BEFORE the spawn. If the spawn throws, the attempt still counts —
  // the alternative is a failure that retries on every single run.
  try {
    mkdirSync(concernStateDirectory('orchestrator', process.env), { recursive: true })
    writeFileSync(wakeStampPath(), new Date(now).toISOString())
  } catch {
    /* best effort */
  }
  try {
    Bun.spawn(['wakeonlan', modelHostWolMac()], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    }).unref()
  } catch {
    return { sent: false, detail: 'wakeonlan could not be spawned' }
  }
  return { sent: true, detail: d.detail }
}

/**
 * Commands that must know whether an agent can be reached before they answer.
 *
 * Anything that ROUTES (`do`) or REPORTS A ROUTE (`pick`, `guide`, `doctor`,
 * `agents`). Exported rather than left in the command adapter so it can be asserted against:
 * a command added to the switch that prints eligibility and is missing here
 * reports a route that `orch do` would not take, which is exactly what
 * happened to `pick` and `guide`.
 *
 * `stats` is deliberately absent — it reports recorded history, and history does
 * not change when a machine is switched off.
 */
/**
 * Probe the configured model host and every enabled self-operated agent once
 * per process, and remember their answers separately.
 *
 * This is what makes reachability a ROUTING INPUT rather than a run outcome.
 * `available()` reads the result, so anything that calls this before routing
 * gets an honest answer, and anything that does not behaves exactly as it did
 * before — which is why the reporting views can stay synchronous.
 */
export async function ensureLocalHealth(opts: { force?: boolean; baseUrl?: string } = {}) {
  const globalBaseUrl = opts.baseUrl ?? modelHostUrl()
  const globalProbe =
    !modelHostHealth || opts.force
      ? localReachable(undefined, globalBaseUrl)
      : Promise.resolve(modelHostHealth)
  const probes = Object.values(AGENTS)
    .filter((agent) => agent.enabled !== false && agent.operatedBy === 'self')
    .map(async (agent) => {
      const cached = agentHealth.get(agent.name)
      if (cached?.baseUrl === agent.baseUrl && !opts.force) return
      const health =
        agent.baseUrl === globalBaseUrl
          ? await globalProbe
          : await localReachable(undefined, agent.baseUrl ?? '')
      agentHealth.set(agent.name, { baseUrl: agent.baseUrl ?? null, health })
    })
  const [globalHealth] = await Promise.all([globalProbe, ...probes])
  modelHostHealth = globalHealth
  return modelHostHealth
}

/** The last reachability verdict for this row's current endpoint, if probed. */
export function localAgentHealth(name: string): LocalHealth | null {
  const agent = AGENTS[name]
  const cached = agentHealth.get(name)
  return cached && cached.baseUrl === agent?.baseUrl ? cached.health : null
}

/**
 * Forget the probe, so the next caller takes a fresh one.
 *
 * The cache is right for `orch do`, which lives for one run. It is wrong for
 * anything long-lived — `orch serve` runs for days, and a verdict taken when the
 * box happened to be rebooting would outlive the reboot by the life of the
 * process. Whoever holds a process open longer than a run is responsible for
 * calling this.
 */
/**
 * Why this agent cannot be used at all, or null if it can.
 *
 * The reason is returned rather than a bare boolean because it is the thing
 * anyone actually needs. `--agent qwen36-goose` against a powered-down host used
 * to be refused as "not installed", which sends you looking for a missing
 * binary that is sitting right there on PATH.
 */
export function fileContractProbeReason(name: string): string {
  return `registration probe predates the file contract; run orch agent probe ${name}`
}

export function predatesFileContract(agent: Agent): boolean {
  return Boolean(agent.probedAt) && agent.caps.replyFile !== true && agent.probePassed !== false
}

export function unavailableReason(name: string): string | null {
  const a = AGENTS[name]
  if (!a) return 'unknown agent'
  if (a.enabled === false) return `disabled — ${a.disabledReason}`
  if (a.probePassed === null) return `registration probe incomplete; run orch agent probe ${name}`
  if (a.probedAt && a.probePassed === false) return 'registration probe failed'
  if (a.contextTokens === 0) {
    return `no declared context window; run orch agent set ${name} --context-tokens <tokens>`
  }
  if (!harnessInstalled(name)) return 'not installed'
  if (a.operatedBy === 'self') {
    // A local agent is only real once its own endpoint is configured. The
    // machine-wide model host is a wake target, not a default for every row.
    if (!a.baseUrl) return 'ORCH_MODEL_HOST_URL not set'
    // ...and only usable once it ANSWERS. Configuration is not reachability:
    // the env var stayed correct for the whole eleven hours the box was off.
    // Only a probe that has actually run can say no here, so a caller that
    // never awaited ensureLocalHealth() is left exactly as it was.
    const health = localAgentHealth(name)
    if (health && !health.ok) return `endpoint unreachable — ${health.detail}`
  }
  return null
}

export function available(name: string): boolean {
  return unavailableReason(name) === null
}

export function harnessInstalled(name: string): boolean {
  const agent = AGENTS[name]
  return Boolean(agent && which(agent.bin, { PATH: process.env.PATH }) !== null)
}

/** Confirm the local endpoint actually answers. Reachability is not configuration. */
export async function localReachable(
  timeoutMs = 4000,
  // Defaults to the configured endpoint. Taken as a parameter so this can be
  // pointed at a URL that is known to be dead, or known to be the wrong
  // service, without reconfiguring the machine — which is the only way to test
  // the "answered 200 with HTML" case that Docker Desktop actually produced.
  baseUrl = modelHostUrl(),
): Promise<LocalHealth> {
  if (!baseUrl) return { ok: false, detail: 'ORCH_MODEL_HOST_URL not set' }
  try {
    const res = await fetch(new URL('models', baseUrl.replace(/\/?$/, '/')), {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    // A 200 is not proof it is the right service: another process holding the
    // port answers 200 too. Require an OpenAI-shaped model list.
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('json')) {
      return {
        ok: false,
        detail: `not an API — answered ${type.split(';')[0] || 'unknown'}; something else owns this port`,
      }
    }
    const body = (await res.json()) as { data?: { id: string; max_model_len?: number }[] }
    if (!Array.isArray(body.data))
      return { ok: false, detail: 'JSON but no model list — not an OpenAI-compatible endpoint' }
    const ids = body.data.map((m) => m.id)
    // The window the server is actually serving, which is a routing input: a job
    // whose working set will not fit is excluded outright. It is declared in
    // AGENTS because routing is synchronous, so the declaration can fall out of
    // step with a re-serve — reading it back here is what notices.
    const served = body.data.find((m) => m.max_model_len)?.max_model_len
    return {
      ok: true,
      detail: ids.length ? ids.join(', ') : 'reachable, no models listed',
      contextTokens: served,
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}
