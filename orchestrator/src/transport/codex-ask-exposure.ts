// concern: Codex ask-tool exposure observation
/**
 * Knows the observed Codex rollout tool-list shape and constructs its run event.
 * Must not know launch, collection, or persistence.
 */
import { WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { codexMcpToolIdentifier } from '../contract/codex-mcp-tool.ts'
import type { RunLogEvent } from '../events.ts'

type CodexAskExposureSurface = 'top-level' | 'code-mode' | 'absent' | 'unknown'
const SURFACE_PRIORITY: Record<CodexAskExposureSurface, number> = {
  unknown: 0,
  absent: 1,
  'code-mode': 2,
  'top-level': 3,
}
export type CodexAskExposure = {
  surface: CodexAskExposureSurface
  cliVersion: string | null
}

type Tool = { name?: unknown; tools?: unknown }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function namedTools(value: unknown): Tool[] {
  return Array.isArray(value) ? value.filter((tool) => record(tool)) : []
}

function namespaceSurface(namespace: Tool, nestedRunTests: string): CodexAskExposureSurface | null {
  if (namespace.name === 'run_tests' || namespace.name === nestedRunTests) return 'top-level'
  const tools = namedTools(namespace.tools)
  if (tools.some((tool) => tool.name === 'run_tests' || tool.name === nestedRunTests)) {
    return 'top-level'
  }
  if (namespace.name === 'functions' && tools.some((tool) => tool.name === 'exec')) {
    return 'code-mode'
  }
  return null
}

function additionalToolsSurface(
  item: Record<string, unknown>,
  payload: Record<string, unknown> | null,
  nestedRunTests: string,
): CodexAskExposureSurface | null {
  if (item.type !== 'response_item' || payload?.type !== 'additional_tools') return null
  if (!Array.isArray(payload.tools)) return null
  const surfaces = namedTools(payload.tools).map((namespace) =>
    namespaceSurface(namespace, nestedRunTests),
  )
  if (surfaces.includes('top-level')) return 'top-level'
  return surfaces.includes('code-mode') ? 'code-mode' : 'absent'
}

function rolloutItem(line: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(line))
  } catch {
    return null
  }
}

function preferredSurface(
  current: CodexAskExposureSurface,
  candidate: CodexAskExposureSurface | null,
): CodexAskExposureSurface {
  return candidate && SURFACE_PRIORITY[candidate] > SURFACE_PRIORITY[current] ? candidate : current
}

/** Classify ask-tool exposure from Codex rollout JSONL without assuming malformed input is absent. */
export function parseCodexAskExposure(text: string | null | undefined): CodexAskExposure {
  let cliVersion: string | null = null
  let surface: CodexAskExposureSurface = 'unknown'
  const nestedRunTests = codexMcpToolIdentifier(WORKER_MCP_SERVER_NAME, 'run_tests')
  for (const line of text?.split('\n') ?? []) {
    const item = rolloutItem(line)
    if (!item) continue
    const payload = record(item?.payload)
    if (item?.type === 'session_meta' && typeof payload?.cli_version === 'string') {
      cliVersion = payload.cli_version
    }
    surface = preferredSurface(surface, additionalToolsSurface(item, payload, nestedRunTests))
  }
  return { surface, cliVersion }
}

/** Classify only this turn's slice, while allowing its stable CLI version to come from the chain. */
export function codexAskExposureFromTexts(slice: string, full: string): CodexAskExposure {
  const exposure = parseCodexAskExposure(slice)
  return {
    ...exposure,
    cliVersion: exposure.cliVersion ?? parseCodexAskExposure(full).cliVersion,
  }
}

const CODE_MODE_NOTE =
  'code-mode means exec offered, nested set not enumerated; not proof run_tests was reachable'

export function askExposureEvent(
  harness: string,
  exposure: CodexAskExposure | undefined,
  ts: string,
): Extract<RunLogEvent, { type: 'ask_exposure' }> | null {
  if (harness !== 'codex' || !exposure) return null
  return {
    ts,
    type: 'ask_exposure',
    surface: exposure.surface,
    cli_version: exposure.cliVersion,
    note: exposure.surface === 'code-mode' ? CODE_MODE_NOTE : null,
  }
}
